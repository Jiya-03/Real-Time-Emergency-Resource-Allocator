// Handover admission + department toggles. Run: npm run test:admission
//
//  1. DEPARTMENTS: hospital staff switch a department off → the ranking stops treating the hospital as eligible for it.
//  2. ADMISSION: at handover the reserved ICU bed is taken over by the admission (not counted twice).
//  3. LIVE INVENTORY: adding a ventilator at handover takes one from availability immediately; removing it gives it back.
//  4. NO CAPACITY: asking for a resource that is not free is refused (409) and nothing changes.
//  5. COMPLETE needs a ward / room / bed; afterwards the admission is stamped and shown in the request.
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-admission-${process.pid}.db`);
const PORT = 6300 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, DB_PATH, PORT: String(PORT), SIMULATOR: 'off' };

execSync('node src/db/seed.js', { cwd: serverDir, env, stdio: 'ignore' });
const server = spawn('node', ['src/index.js'], { cwd: serverDir, env, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
async function call(method, url, body, token) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const login = async (role, identifier) => (await call('POST', '/api/auth/login', { role, identifier, password: 'x' })).body.token;
const hosp = async (id) => (await call('GET', `/api/hospitals/${id}`)).body;

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const d = await login('dispatcher', 'DSP-7704');

  // 1. DEPARTMENTS
  const H = 'HSP-001';
  const h = await login('hospital', H);
  const before = await hosp(H);
  const off = await call('PATCH', `/api/hospitals/${H}/services`, { services: { trauma_care: false } }, h);
  check(off.status === 200 && off.body.hospital.services.trauma_care === false, 'DEPARTMENTS: staff switched Trauma & Emergency to unavailable');
  const other = await login('hospital', 'HSP-002');
  check((await call('PATCH', `/api/hospitals/${H}/services`, { services: { trauma_care: true } }, other)).status === 403, 'DEPARTMENTS: another hospital cannot change it (403)');
  const req0 = (await call('POST', '/api/requests', { emergency_type: 'Road Accident', patient_condition: 'Critical', patient_age: 40,
    location: { lat: 18.559, lng: 73.8078 }, requirements: { icu: true, trauma_care: true } }, d)).body.request.request_id;
  const m0 = (await call('POST', `/api/requests/${req0}/match`, {}, d)).body;
  check(m0.rankings.find(r => r.hospital_id === H)?.eligible === false, 'DEPARTMENTS: the ranking no longer treats it as eligible for trauma');
  await call('PATCH', `/api/hospitals/${H}/services`, { services: { trauma_care: before.services.trauma_care }, specialists: ['Trauma Surgeon', 'Cardiologist'] }, h);
  check((await hosp(H)).specialists.join() === 'Trauma Surgeon,Cardiologist', 'DEPARTMENTS: specialists on call updated');

  // accepted + arrived patient at H
  const req = (await call('POST', '/api/requests', { emergency_type: 'Road Accident', patient_condition: 'Critical', patient_age: 40,
    location: { lat: 18.5308, lng: 73.8475 }, requirements: { icu: true } }, d)).body.request.request_id;
  await call('POST', '/api/reservations', { request_id: req, hospital_id: H }, d);
  const inbox = (await call('GET', '/api/reservations', null, h)).body.items.find(i => i.request.request_id === req);
  await call('PATCH', `/api/reservations/${inbox.reservation_id}`, { action: 'accept' }, h);
  const tooEarly = await call('PUT', `/api/requests/${req}/admission`, { ward: 'ICU' }, h);
  check(tooEarly.status === 409, 'ADMISSION: cannot allocate a bed before the ambulance arrives (409)');
  await call('POST', `/api/requests/${req}/handoff`, { step: 'depart' }, d);
  await call('POST', `/api/requests/${req}/handoff`, { step: 'arrive' }, h);

  // 2. ADMISSION draft + take-over of the reserved bed
  const view = (await call('GET', `/api/requests/${req}/admission`, null, h)).body;
  check(view.admission.ward === 'ICU' && view.admission.room && view.admission.bed, `ADMISSION: suggested ${view.admission.ward} · Room ${view.admission.room} · Bed ${view.admission.bed}`);
  check(view.admission.resources.icu === 1, 'ADMISSION: starts with the ICU bed the reservation is holding');
  const icu0 = (await hosp(H)).resources.icu.available;
  const s1 = await call('PUT', `/api/requests/${req}/admission`, { ward: 'ICU', room: view.admission.room, bed: view.admission.bed, attending: 'Dr. Mehta', nurse: 'Sr. Kulkarni', resources: { icu: 1 } }, h);
  check(s1.status === 200 && (await hosp(H)).resources.icu.available === icu0, 'ADMISSION: the reserved ICU bed is taken over, not taken twice');

  // 3. LIVE INVENTORY
  const vent0 = (await hosp(H)).resources.ventilator.available;
  const s2 = await call('PUT', `/api/requests/${req}/admission`, { resources: { icu: 1, ventilator: 1 }, services: ['operation_theatre', 'blood_bank'] }, h);
  check(s2.status === 200 && (await hosp(H)).resources.ventilator.available === vent0 - 1, `LIVE INVENTORY: ventilator added → available ${vent0} → ${vent0 - 1}`);
  const s3 = await call('PUT', `/api/requests/${req}/admission`, { resources: { icu: 1 } }, h);
  check(s3.status === 200 && (await hosp(H)).resources.ventilator.available === vent0, 'LIVE INVENTORY: ventilator removed → given back');

  // 4. NO CAPACITY
  const cur = await hosp(H);
  await call('PATCH', `/api/hospitals/${H}/resources`, { oxygen_bed: 0, version: cur.version, source: 'Hospital Staff' }, h);
  const s4 = await call('PUT', `/api/requests/${req}/admission`, { resources: { icu: 1, oxygen_bed: 1 } }, h);
  check(s4.status === 409 && s4.body.code === 'NO_CAPACITY', 'NO CAPACITY: an oxygen bed that is not free is refused (409)');
  check((await hosp(H)).resources.oxygen_bed.available === 0 && (await call('GET', `/api/requests/${req}/admission`, null, h)).body.admission.resources.oxygen_bed === undefined, 'NO CAPACITY: nothing changed');

  // 5. COMPLETE
  const done = await call('POST', `/api/requests/${req}/handoff`, { step: 'complete' }, h);
  check(done.status === 200 && done.body.admission?.admitted_at, `COMPLETE: admitted to ${done.body.admission?.ward} Room ${done.body.admission?.room} Bed ${done.body.admission?.bed}`);
  const det = (await call('GET', `/api/requests/${req}`)).body;
  check(det.admission?.attending === 'Dr. Mehta' && det.status === 'COMPLETED', 'COMPLETE: request shows the admission details');
  const locked = await call('PUT', `/api/requests/${req}/admission`, { resources: {} }, h);
  check(locked.status === 409, 'An admitted patient\'s allocation cannot be changed through handover (409)');
} catch (e) {
  console.error(e); failures++;
} finally {
  server.kill();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: department toggles, bed allocation, live inventory at handover');
process.exit(failures ? 1 : 0);
