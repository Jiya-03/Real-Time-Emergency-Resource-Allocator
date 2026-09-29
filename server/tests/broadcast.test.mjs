// Broadcast dispatch test. Run: npm run test:broadcast
//
// Starts a real server on a throw-away database, then:
//  1. BROADCAST: one click alerts every suitable hospital; no beds are locked while they decide.
//  2. FIRST ACCEPT WINS: two hospitals accept at the same instant → exactly one wins, the other gets 409.
//     Only the winner loses a bed; everyone else is withdrawn automatically.
//  3. AUTO NEXT WAVE: when every alerted hospital declines, the next suitable hospitals are alerted.
//  4. BED GONE: a hospital whose last bed disappeared cannot accept (409 BED_TAKEN) and is skipped.
//  5. WITHDRAW: the dispatcher can cancel the request at every hospital still deciding.
import './_env.mjs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-broadcast-${process.pid}.db`);
const PORT = 5900 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
// Wide bands + no waiting = every suitable hospital at once, first accept wins (the atomicity checks below).
// The ranked cascade (small waves, best "yes" wins) is tested in cascade.test.mjs.
const env = { ...process.env, DB_PATH, PORT: String(PORT), SIMULATOR: 'off', HOLD_MINUTES: '10', BROADCAST_MAX: '6',
  ETA_BAND_MIN: '999', SCORE_BAND: '0', BETTER_WAIT_SECONDS: '0', RESPONSE_SECONDS: '600' };

execSync('node src/db/seed.js', { cwd: serverDir, env, stdio: 'ignore' });
const server = spawn('node', ['src/index.js'], { cwd: serverDir, env, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };

async function call(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const login = async (role, identifier) => (await call('POST', '/api/auth/login', { role, identifier, password: 'x' })).body.token;
const hosp = async (id) => (await call('GET', `/api/hospitals/${id}`)).body;
const newRequest = async (d, extra = {}) => (await call('POST', '/api/requests', {
  emergency_type: 'Road Accident', severity: 'Critical', patient_age: 40,
  location: { lat: 18.5308, lng: 73.8475 }, requirements: { icu: true, trauma_care: true }, ...extra,
}, d)).body.request.request_id;
const holdIdAt = async (hospitalId, requestId) => {
  const t = await login('hospital', hospitalId);
  const item = (await call('GET', '/api/reservations', null, t)).body.items.find(i => i.request.request_id === requestId && i.status === 'PENDING');
  return { token: t, reservation_id: item?.reservation_id };
};

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const d = await login('dispatcher', 'DSP-7704');

  // 1. BROADCAST
  const req1 = await newRequest(d);
  const icuBefore = {};
  const bc = await call('POST', `/api/requests/${req1}/broadcast`, {}, d);
  check(bc.status === 201 && bc.body.sent_to.length >= 2, `BROADCAST: one click alerted ${bc.body.sent_to?.length} suitable hospitals`);
  const targets = bc.body.sent_to.map(t => t.hospital_id);
  for (const id of targets) icuBefore[id] = (await hosp(id)).resources.icu.available;
  const inboxes = await Promise.all(targets.map(id => holdIdAt(id, req1)));
  check(inboxes.every(x => x.reservation_id), 'BROADCAST: every alerted hospital has it in its inbox (PENDING)');
  const noBroadcastTwice = await call('POST', '/api/reservations', { request_id: req1, hospital_id: targets[0] }, d);
  check(noBroadcastTwice.status === 409, 'BROADCAST: a single-hospital hold cannot be added on top (409)');

  // 2. FIRST ACCEPT WINS (two hospitals press Accept at the same instant)
  const [a, b] = inboxes;
  const [ra, rb] = await Promise.all([
    call('PATCH', `/api/reservations/${a.reservation_id}`, { action: 'accept' }, a.token),
    call('PATCH', `/api/reservations/${b.reservation_id}`, { action: 'accept' }, b.token),
  ]);
  const wins = [ra, rb].filter(x => x.status === 200);
  const loses = [ra, rb].filter(x => x.status === 409);
  check(wins.length === 1 && loses.length === 1, `RACE: simultaneous accepts → ${wins.length} winner, ${loses.length} refused (expected 1 / 1)`);
  check(loses[0]?.body.code === 'ALREADY_FILLED', `RACE: the loser is told another hospital accepted first (${loses[0]?.body.code})`);
  const winnerId = wins[0].body.hospital_id;
  const icuAfter = {};
  for (const id of targets) icuAfter[id] = (await hosp(id)).resources.icu.available;
  check(icuAfter[winnerId] === icuBefore[winnerId] - 1, 'RACE: the winner\'s ICU bed was taken on accept (−1)');
  check(targets.filter(id => id !== winnerId).every(id => icuAfter[id] === icuBefore[id]), 'RACE: no bed was locked at any other hospital');
  const det1 = (await call('GET', `/api/requests/${req1}`)).body;
  check(det1.request_status === 'ASSIGNED' || det1.status === 'ASSIGNED', 'RACE: the emergency is ASSIGNED');
  const others = det1.workflow.filter(w => w.hospital_id !== winnerId);
  check(others.every(w => w.hospital_response === 'WITHDRAWN'), 'RACE: every other hospital was withdrawn automatically');
  check(det1.reservations.filter(x => x.hospital_id !== winnerId).every(x => x.reservation_status === 'CANCELLED'), 'RACE: their requests are closed (CANCELLED)');
  const late = inboxes[2] || inboxes[1];
  const lateRes = await call('PATCH', `/api/reservations/${late.reservation_id}`, { action: 'accept' }, late.token);
  check(lateRes.status === 409, 'A late accept after the emergency was filled is refused (409)');

  // 3. AUTO NEXT WAVE when everyone declines
  const req2 = await newRequest(d, { location: { lat: 18.5089, lng: 73.9260 } });
  const w1 = await call('POST', `/api/requests/${req2}/broadcast`, { max: 2 }, d);
  const wave1 = w1.body.sent_to.map(t => t.hospital_id);
  check(w1.status === 201 && wave1.length === 2, 'WAVE 1: max 2 → two hospitals alerted');
  for (const id of wave1) {
    const h = await holdIdAt(id, req2);
    await call('PATCH', `/api/reservations/${h.reservation_id}`, { action: 'reject', reason: 'No Bed' }, h.token);
  }
  const det2 = (await call('GET', `/api/requests/${req2}`)).body;
  const pendingNow = [...new Set(det2.reservations.filter(x => x.reservation_status === 'PENDING').map(x => x.hospital_id))];
  check(det2.broadcast_round === 2, `WAVE 2: sent automatically after both declined (round ${det2.broadcast_round})`);
  check(pendingNow.length > 0 && pendingNow.every(id => !wave1.includes(id)), `WAVE 2: ${pendingNow.length} NEW hospitals alerted, none repeated`);

  // 4. BED GONE before accept
  const req3 = await newRequest(d, { location: { lat: 18.5074, lng: 73.8077 } });
  const w3 = await call('POST', `/api/requests/${req3}/broadcast`, { max: 1 }, d);
  const target3 = w3.body.sent_to[0].hospital_id;
  const h3 = await holdIdAt(target3, req3);
  const hs = await hosp(target3);
  await call('PATCH', `/api/hospitals/${target3}/resources`, { icu: 0, version: hs.version, source: 'Hospital Staff' }, h3.token);
  const acc3 = await call('PATCH', `/api/reservations/${h3.reservation_id}`, { action: 'accept' }, h3.token);
  check(acc3.status === 409 && acc3.body.code === 'BED_TAKEN', 'BED GONE: accept refused with BED_TAKEN when the last ICU bed is gone');
  check((await hosp(target3)).resources.icu.available === 0, 'BED GONE: availability never goes below zero');
  const det3 = (await call('GET', `/api/requests/${req3}`)).body;
  check(det3.broadcast_round === 2 && det3.reservations.some(x => x.reservation_status === 'PENDING' && x.hospital_id !== target3),
    'BED GONE: the next suitable hospital was alerted automatically');

  // 5. WITHDRAW ALL
  const req4 = await newRequest(d, { location: { lat: 18.5679, lng: 73.9143 } });
  await call('POST', `/api/requests/${req4}/broadcast`, {}, d);
  const wd = await call('POST', `/api/requests/${req4}/withdraw`, {}, d);
  const det4 = (await call('GET', `/api/requests/${req4}`)).body;
  check(wd.status === 200 && det4.reservations.every(x => x.reservation_status === 'CANCELLED'), `WITHDRAW: cancelled at all ${wd.body.withdrawn?.length} hospitals`);
  const hospCant = await call('POST', `/api/requests/${req4}/broadcast`, {}, h3.token);
  check(hospCant.status === 403, 'Only a dispatcher can broadcast (hospital → 403)');
} catch (e) {
  console.error(e); failures++;
} finally {
  server.kill();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: broadcast dispatch, first-accept-wins, auto next wave');
process.exit(failures ? 1 : 0);
