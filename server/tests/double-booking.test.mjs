// Double-booking + reservation lifecycle test. Run: npm run test:booking
//
// Starts a real server on a throw-away database, then:
//  1. RACE: 20 dispatchers hit "Request Confirmation" at the same hospital at the same instant,
//     but it has only 3 free ICU beds → exactly 3 holds succeed, 17 get 409 BED_TAKEN, availability ends at 0 (never negative).
//  2. ONE HOLD PER EMERGENCY: a second hold for the same emergency is refused.
//  3. REJECT returns the bed; ACCEPT assigns the patient (status ASSIGNED, hold CONFIRMED).
//  4. EXPIRY: an unanswered hold is released automatically and the bed comes back.
//  5. SECURITY: another hospital cannot accept this hospital's hold; dispatchers cannot accept at all.
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-booking-${process.pid}.db`);
const PORT = 5600 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, DB_PATH, PORT: String(PORT), SIMULATOR: 'off', HOLD_MINUTES: '10' };

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

try {
  for (let i = 0; i < 50; i++) {                       // wait for the server
    try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  const dsp = await login('dispatcher', 'DSP-7704');
  const HOSP = 'HSP-001';
  const hsp = await login('hospital', HOSP);
  const otherHsp = await login('hospital', 'HSP-002');

  // Force exactly 3 free ICU beds at HSP-001 (hospital staff update)
  await call('PATCH', `/api/hospitals/${HOSP}/resources`, { icu: 3 });
  const icuNow = async () => (await call('GET', `/api/hospitals/${HOSP}`)).body.resources.icu.available;

  // 20 Critical emergencies needing ICU near HSP-001
  const newReq = async () => (await call('POST', '/api/requests', {
    emergency_type: 'Cardiac', severity: 'Critical', patient_age: 60,
    location: { lat: 18.5592, lng: 73.8031 }, requirements: { icu: true, cardiology: true },
  })).body.request.request_id;
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await newReq());
  for (const id of ids) await call('POST', `/api/requests/${id}/match`);

  // ── 1. The race
  const results = await Promise.all(ids.map(id => call('POST', '/api/reservations', { request_id: id, hospital_id: HOSP }, dsp)));
  const won = results.filter(r => r.status === 201);
  const lost = results.filter(r => r.status === 409 && r.body.code === 'BED_TAKEN');
  check(won.length === 3, `RACE: 20 simultaneous holds for 3 ICU beds → ${won.length} succeeded (expected 3)`);
  check(lost.length === 17, `RACE: ${lost.length} got 409 BED_TAKEN (expected 17)`);
  check(await icuNow() === 0, `RACE: ICU availability is exactly 0 afterwards (never negative)`);
  check(lost.every(r => Array.isArray(r.body.alternatives)), 'RACE: every loser was offered alternative hospitals');

  const winnerIds = won.map(r => r.body.request.request_id);
  const winnerRes = (id) => won.find(r => r.body.request.request_id === id).body.reservations.find(x => x.status === 'PENDING').reservation_id;

  // ── 2. One hold per emergency
  const dup = await call('POST', '/api/reservations', { request_id: winnerIds[0], hospital_id: 'HSP-002' }, dsp);
  check(dup.status === 409 && dup.body.code === 'ALREADY_HELD', 'An emergency cannot hold beds at two hospitals at once');

  // ── 5. Security
  const wrongHosp = await call('PATCH', `/api/reservations/${winnerRes(winnerIds[0])}`, { action: 'accept' }, otherHsp);
  check(wrongHosp.status === 403, 'Another hospital cannot accept this hold (403)');
  const asDispatcher = await call('PATCH', `/api/reservations/${winnerRes(winnerIds[0])}`, { action: 'accept' }, dsp);
  check(asDispatcher.status === 403, 'A dispatcher cannot accept on behalf of a hospital (403)');
  const noToken = await call('POST', '/api/reservations', { request_id: ids[5], hospital_id: HOSP });
  check(noToken.status === 401, 'Reserving without signing in is refused (401)');

  // ── 3. Reject returns the bed, then a waiting emergency can take it; accept assigns
  const rej = await call('PATCH', `/api/reservations/${winnerRes(winnerIds[0])}`, { action: 'reject', reason: 'No Bed' }, hsp);
  check(rej.status === 200 && rej.body.request.status === 'MATCHING', 'REJECT: emergency goes back to MATCHING');
  check(await icuNow() === 1, 'REJECT: the ICU bed returned (availability 0 → 1)');

  const loserId = lost[0] ? ids.find(id => !winnerIds.includes(id)) : null;
  const retry = await call('POST', '/api/reservations', { request_id: loserId, hospital_id: HOSP }, dsp);
  check(retry.status === 201, 'A previously unlucky emergency can now take the freed bed');
  const retryRes = retry.body.reservations.find(x => x.status === 'PENDING').reservation_id;
  const acc = await call('PATCH', `/api/reservations/${retryRes}`, { action: 'accept' }, hsp);
  check(acc.status === 200 && acc.body.request.status === 'ASSIGNED', 'ACCEPT: emergency becomes ASSIGNED');
  check(acc.body.reservations.some(x => x.status === 'CONFIRMED'), 'ACCEPT: hold becomes CONFIRMED');
  const again = await call('PATCH', `/api/reservations/${retryRes}`, { action: 'reject', reason: 'Other' }, hsp);
  check(again.status === 409, 'An answered hold cannot be answered twice (409)');

  // ── 4. Expiry: backdate one pending hold and let the sweeper release it
  const { default: Database } = await import('better-sqlite3');
  const direct = new Database(DB_PATH);
  direct.prepare(`UPDATE reservations SET requested_at = ?, expires_at = ? WHERE reservation_id = ?`)
    .run(new Date(Date.now() - 11 * 60000).toISOString(), new Date(Date.now() - 60000).toISOString(), winnerRes(winnerIds[1]));
  direct.close();
  const before = await icuNow();
  await new Promise(r => setTimeout(r, 6500));            // sweeper runs every 5 s
  const detail = (await call('GET', `/api/requests/${winnerIds[1]}`)).body;
  check(detail.reservations.some(x => x.reservation_id === winnerRes(winnerIds[1]) && x.reservation_status === 'EXPIRED'), 'EXPIRY: unanswered hold marked EXPIRED');
  check(await icuNow() === before + 1, 'EXPIRY: its bed returned automatically');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.kill();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
}

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: no double-booking, full reservation lifecycle works');
process.exit(failures ? 1 : 0);
