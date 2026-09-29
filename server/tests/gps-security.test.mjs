// Live GPS can only come from the crew that logged the emergency. Run: npm run test:gps
//
// Starts a real server, logs an emergency as dispatcher DSP-7704, gets it accepted, then five
// sockets try to send an ambulance position for it:
//   anonymous · hospital staff · another dispatcher · the owner (before + after acceptance)
// Only the owner's position (once a hospital has accepted) may reach the other screens.
import './_env.mjs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { io as connect } from 'socket.io-client';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-gps-${process.pid}.db`);
const PORT = 6700 + (process.pid % 200);
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, DB_PATH, PORT: String(PORT), SIMULATOR: 'off' };
execSync('node src/db/seed.js', { cwd: serverDir, env, stdio: 'ignore' });
const server = spawn('node', ['src/index.js'], { cwd: serverDir, env, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, url, body, token) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const login = async (role, id) => (await call('POST', '/api/auth/login', { role, identifier: id, password: 'x' })).body.token;
const sockets = [];
const open = (token) => new Promise((resolve) => { const s = connect(BASE, { auth: token ? { token } : {}, transports: ['websocket'] }); sockets.push(s); s.on('connect', () => resolve(s)); });

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); } }
  const owner = await login('dispatcher', 'DSP-7704');
  const other = await login('dispatcher', 'DSP-1111');
  const H = 'HSP-001';
  const hosp = await login('hospital', H);

  check((await call('POST', '/api/requests', { emergency_type: 'Other', patient_condition: 'Stable', patient_age: 30, location: { lat: 18.53, lng: 73.85 } })).status === 401,
    'Logging an emergency now needs a signed-in dispatcher (401 without)');
  const rid = (await call('POST', '/api/requests', { emergency_type: 'Other', patient_condition: 'Critical', patient_age: 50, location: { lat: 18.5308, lng: 73.8475 }, requirements: { icu: true } }, owner)).body.request.request_id;

  const watcher = await open(null);
  const got = [];
  watcher.on('ambulance:position', (p) => got.push(p));
  const rejections = {};
  const send = async (who, token, extra = {}) => {
    const s = await open(token);
    s.on('ambulance:position:rejected', (p) => { rejections[who] = p.reason; });
    s.emit('ambulance:position', { request_id: rid, lat: 18.52, lng: 73.85, source: 'gps', ...extra });
    await sleep(300);
  };

  // before any hospital accepted
  await send('owner-early', owner);
  check(got.length === 0 && /no hospital confirmed/.test(rejections['owner-early'] || ''), `Owner before a hospital accepted → ignored ("${rejections['owner-early']}")`);

  // get it accepted by H (hand-picked so its accept is final)
  await call('POST', `/api/requests/${rid}/broadcast`, { hospital_id: H }, owner);
  const item = (await call('GET', '/api/reservations', null, hosp)).body.items.find(i => i.request.request_id === rid);
  await call('PATCH', `/api/reservations/${item.reservation_id}`, { action: 'accept' }, hosp);

  await send('anonymous', null);
  await send('hospital', hosp);
  await send('other crew', other);
  check(got.length === 0, 'Anonymous, hospital staff and another crew → none of their positions reached any screen');
  check(rejections.anonymous === 'not signed in' && /only the ambulance crew/.test(rejections.hospital) && /another crew/.test(rejections['other crew']),
    `Each is told why: "${rejections.anonymous}" · "${rejections.hospital}" · "${rejections['other crew']}"`);

  await send('owner', owner, { lat: 18.5251, lng: 73.8512 });
  check(got.length === 1 && got[0].request_id === rid && got[0].lat === 18.5251, 'The crew that logged it → position relayed to every screen');
  const pos = (await call('GET', `/api/requests/${rid}/position`)).body.position || {};
  check(pos.lat === 18.5251, 'Last position stored for the hospital map (GET /position)');

  const s = await open(owner);
  for (let i = 0; i < 5; i++) s.emit('ambulance:position', { request_id: rid, lat: 18.52 + i / 1000, lng: 73.85, source: 'gps' });
  await sleep(300);
  check(got.length === 1, 'A burst of 5 positions in the same second is throttled (max 1 per second)');

  const bad = await open(owner);
  bad.emit('ambulance:position', { request_id: rid, lat: 999, lng: 73.85 });
  await sleep(200);
  check(got.length === 1, 'Impossible coordinates are rejected');
} catch (e) {
  console.error(e); failures++;
} finally {
  for (const s of sockets) s.close();
  server.kill();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: live GPS only from the crew that logged the emergency');
process.exit(failures ? 1 : 0);
