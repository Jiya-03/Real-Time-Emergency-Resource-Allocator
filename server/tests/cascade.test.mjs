// Ranked cascade dispatch. Run: npm run test:cascade
//
// Five lab hospitals around one pickup point (every other hospital has no ICU bed):
//   H1 2 km (best) · H2 3 km · H3 4 km · H5 5 km · H4 12 km (far)
// Checks:
//   1. WAVES: only the top 3 close to the best are alerted; a far hospital is never in the same wave.
//   2. BEST YES WINS: a lower-ranked "yes" waits (bed held) and loses to a better "yes" that follows.
//   3. WAIT OVER: if the better ones stay silent, the best offer is confirmed after the short wait.
//   4. DECLINES MOVE ON: a better hospital declining confirms the offer at once; a whole wave
//      declining or timing out alerts the next wave automatically.
//   5. DISPATCHER OVERRIDE: "send to this hospital" alerts one hospital; its accept is final.
import './_env.mjs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-cascade-${process.pid}.db`);
Object.assign(process.env, { DB_PATH, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
for (const k of ['BROADCAST_MAX', 'ETA_BAND_MIN', 'SCORE_BAND', 'RESPONSE_SECONDS', 'BETTER_WAIT_SECONDS']) delete process.env[k];   // defaults: 3 / 10 min / 0.85 / 60 s / 30 s
execSync('node src/db/seed.js', { cwd: serverDir, env: { ...process.env }, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);

try {
  const { default: db } = await import('../src/db/index.js');
  const rs = await import('../src/services/reservationService.js');
  const { createRequest, getRequest, getRequestDetail } = await import('../src/services/requestService.js');
  const { getHospital } = await import('../src/services/hospitalService.js');

  const P = { lat: 18.5204, lng: 73.8567 };
  const KM = 1 / 111.195;
  const LAB = { H1: ['HSP-001', 2], H2: ['HSP-002', -3], H3: ['HSP-003', 4], H5: ['HSP-005', -5], H4: ['HSP-004', 12] };
  const id = (k) => LAB[k][0];
  const name = Object.fromEntries(Object.entries(LAB).map(([k, [h]]) => [h, k]));

  async function reset() {
    await db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_status IN ('PENDING','CONFIRMED')`).run();
    await db.prepare(`UPDATE emergency_requests SET request_status = 'COMPLETED' WHERE request_status IN ('CREATED','MATCHING','ASSIGNED','IN_TRANSIT','NO_MATCH')`).run();
    await db.prepare('UPDATE hospital_resources SET available_icu_beds = 0, last_updated_timestamp = ?').run(new Date().toISOString());
    for (const [h, north] of Object.values(LAB)) {
      await db.prepare('UPDATE hospitals SET latitude = ?, longitude = ?, active_status = 1, emergency_department = 1 WHERE hospital_id = ?').run(P.lat + north * KM, P.lng, h);
      await db.prepare(`UPDATE hospital_resources SET total_icu_beds = 20, available_icu_beds = 5, last_updated_timestamp = ? WHERE hospital_id = ?`).run(new Date().toISOString(), h);
    }
  }
  const newReq = async () => (await createRequest({ emergency_type: 'Other', patient_condition: 'Critical', patient_age: 45, location: P, requirements: { icu: true } })).request.request_id;
  const resAt = async (h, rid) => (await rs.listForHospital(h)).find(i => i.request.request_id === rid && i.status === 'PENDING');
  const accept = async (k, rid) => await rs.respond((await resAt(id(k), rid)).reservation_id, { action: 'accept', byHospital: id(k) });
  const reject = async (k, rid) => await rs.respond((await resAt(id(k), rid)).reservation_id, { action: 'reject', reason: 'No Bed', byHospital: id(k) });
  const pendingAt = async (rid) => [...new Set((await getRequestDetail(rid)).reservations.filter(r => r.reservation_status === 'PENDING').map(r => name[r.hospital_id]))].sort();
  const winner = async (rid) => name[(await getRequestDetail(rid)).workflow.find(w => w.hospital_response === 'ACCEPTED')?.hospital_id];
  const icu = async (k) => (await getHospital(id(k))).resources.icu.available;

  // ───────── 1. WAVES ─────────
  section('1. Small waves, best hospitals first');
  await reset();
  let r = await newReq();
  let bc = await rs.broadcast(r);
  const sent = bc.sent_to.map(t => name[t.hospital_id]);
  check(sent.join() === 'H1,H2,H3', `Wave 1 = top 3 by rank: ${sent.join(', ')} (H5 waits, far H4 not alerted)`);
  check(bc.response_seconds === 60 && Math.abs(new Date(bc.expires_at) - Date.now() - 60000) < 3000, 'Each hospital has 60 s to answer');
  await reset();
  for (const k of ['H2', 'H3', 'H5']) await db.prepare('UPDATE hospital_resources SET available_icu_beds = 0 WHERE hospital_id = ?').run(id(k));
  r = await newReq(); bc = await rs.broadcast(r);
  check(bc.sent_to.length === 1 && name[bc.sent_to[0].hospital_id] === 'H1',
    `Only H1 (${bc.sent_to[0].eta_min} min) and far H4 have beds → H4 is NOT in the same wave (more than 10 min slower)`);

  // ───────── 2. BEST YES WINS ─────────
  section('2. A lower-ranked "yes" waits for better-ranked hospitals');
  await reset(); r = await newReq(); await rs.broadcast(r);
  const icu3 = await icu('H3');
  const o3 = await accept('H3', r);
  check(o3.offered && (await getRequest(r)).status === 'MATCHING', 'H3 says yes first → becomes an offer, patient NOT assigned yet');
  check(o3.waiting_on.map(w => name[w.hospital_id]).join() === 'H1,H2' && Math.abs(new Date(o3.decide_at) - Date.now() - 30000) < 3000,
    'Waiting on H1 and H2 for up to 30 s');
  check(await icu('H3') === icu3 - 1, 'H3\'s bed is held while it waits (ICU −1), so it cannot vanish');
  const inbox3 = await resAt(id('H3'), r);
  check(inbox3.offer?.offered_at && inbox3.offer.decide_at, 'H3\'s inbox shows its offer and the decision time');
  const icu1 = await icu('H1');
  await accept('H1', r);
  check(await winner(r) === 'H1' && (await getRequest(r)).status === 'ASSIGNED', 'H1 (best) says yes → confirmed at once');
  check(await icu('H3') === icu3 && await icu('H1') === icu1 - 1 && (await pendingAt(r)).length === 0, 'H3\'s held bed goes back; H2 is withdrawn; only H1 lost a bed');

  // ───────── 3. WAIT OVER ─────────
  section('3. Better hospitals stay silent → best offer confirmed after 30 s');
  await reset(); r = await newReq(); await rs.broadcast(r);
  await accept('H3', r);
  await accept('H2', r);
  check((await getRequest(r)).status === 'MATCHING' && (await pendingAt(r)).join() === 'H1,H2,H3', 'H3 then H2 say yes; H1 silent → still waiting');
  await rs.expireStaleHolds(Date.now() + 20000);
  check((await getRequest(r)).status === 'MATCHING', 'After 20 s: still waiting for H1');
  await rs.expireStaleHolds(Date.now() + 31000);
  check(await winner(r) === 'H2', 'After 30 s: H2 confirmed (the better of the two offers), H3 released');

  // ───────── 4. DECLINES MOVE ON ─────────
  section('4. Declines and time-outs move on straight away');
  await reset(); r = await newReq(); await rs.broadcast(r);
  await accept('H2', r);
  await reject('H1', r);
  check(await winner(r) === 'H2', 'H2 offered, H1 declines → H2 is now the best left → confirmed immediately (no waiting)');

  await reset(); r = await newReq(); await rs.broadcast(r);
  await reject('H1', r); await reject('H2', r);
  check((await getRequestDetail(r)).broadcast_round === 1 && (await pendingAt(r)).join() === 'H3', 'H1, H2 decline → H3 still deciding, no new wave yet');
  await reject('H3', r);
  check((await getRequestDetail(r)).broadcast_round === 2 && (await pendingAt(r)).join() === 'H5', 'Whole wave declined → wave 2 sent automatically: H5 only (far H4 still held back)');
  await reject('H5', r);
  check((await pendingAt(r)).join() === 'H4', 'H5 declines → wave 3: H4, the last one left');

  await reset(); r = await newReq(); await rs.broadcast(r);
  await rs.expireStaleHolds(Date.now() + 61000);
  check((await pendingAt(r)).join() === 'H5' && (await getRequestDetail(r)).broadcast_round === 2, 'No answer from wave 1 within 60 s → next wave alerted automatically');

  // ───────── 5. DISPATCHER OVERRIDE ─────────
  section('5. Dispatcher can pick a hospital by hand');
  await reset(); r = await newReq(); await rs.broadcast(r);
  const pick = await rs.broadcast(r, { hospital_id: id('H5') });
  check(pick.manual && pick.sent_to.length === 1 && (await pendingAt(r)).includes('H5'), '"Send to H5" alerts H5 alongside wave 1');
  await accept('H5', r);
  check(await winner(r) === 'H5', 'H5 accepts → confirmed at once, although H1–H3 rank higher (crew\'s choice)');
  await reset(); r = await newReq(); await rs.broadcast(r);
  let err = null; try { await rs.broadcast(r, { hospital_id: id('H1') }); } catch (e) { err = e; }
  check(err?.details?.code === 'ALREADY_ALERTED', 'Picking a hospital that is already deciding → 409 ALREADY_ALERTED');
  err = null; try { await rs.broadcast(r, { hospital_id: 'HSP-010' }); } catch (e) { err = e; }
  check(err?.details?.code === 'NOT_ELIGIBLE', 'Picking a hospital that cannot take the patient → 409 NOT_ELIGIBLE');
  const next = await rs.broadcast(r);
  check(next.sent_to.map(t => name[t.hospital_id]).join() === 'H5', '"Send to next hospitals" alerts the next wave now (H5), without waiting');
} catch (e) {
  console.error(e); failures++;
} finally {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: ranked cascade: small waves, best "yes" wins, auto next wave, dispatcher override');
process.exit(failures ? 1 : 0);
