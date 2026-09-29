// Two servers, one Postgres database. Run: TEST_DATABASE_URL=postgres://… npm run test:multi
// (Postgres only: skipped on SQLite.)
//
//   Server A (dispatcher side) and server B (hospital side) run at the same time on the same database.
//   1. Only ONE of them runs the background jobs (leader lock).
//   2. Live events cross servers: an alert logged on A reaches the hospital's screen on B, and B's accept
//      reaches the dispatcher's screen on A (Socket.io Postgres adapter).
//   3. Live GPS sent to A shows on B, and B can read the last position (stored in the database).
//   4. Two hospitals accepting at the same instant on DIFFERENT servers → exactly one winner, beds correct.
//   5. If the leader stops, the other server takes over the background jobs (hold expiry keeps working).
import { PG, directSql } from './_env.mjs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { io as connect } from 'socket.io-client';

if (!PG) { console.log('⏭️  Multi-server test needs Postgres (set TEST_DATABASE_URL): skipped'); process.exit(0); }

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = { ...process.env, SIMULATOR: 'off', ETA_BAND_MIN: '999', SCORE_BAND: '0', BETTER_WAIT_SECONDS: '0', BROADCAST_MAX: '6', RESPONSE_SECONDS: '600' };
execSync('node src/db/seed.js', { cwd: serverDir, env: base, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const servers = {};
function start(name, port) {
  const p = spawn('node', ['src/index.js'], { cwd: serverDir, env: { ...base, PORT: String(port) } });
  p.log = '';
  p.stdout.on('data', d => { p.log += d; });
  p.stderr.on('data', d => { p.log += d; });
  p.url = `http://localhost:${port}`;
  servers[name] = p;
  return p;
}
async function up(p) { for (let i = 0; i < 80; i++) { try { await fetch(p.url + '/api/health'); return; } catch { await sleep(100); } } throw new Error('server did not start'); }
async function call(p, method, url, body, token) {
  const res = await fetch(p.url + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const sockets = [];
const open = (p, token) => new Promise((resolve) => { const s = connect(p.url, { auth: token ? { token } : {}, transports: ['websocket'] }); sockets.push(s); s.on('connect', () => resolve(s)); });
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; };

try {
  const A = start('A', 6901), B = start('B', 6902);
  await up(A); await up(B);
  await sleep(1500);
  const leaders = [A, B].filter(p => /runs the background jobs/.test(p.log));
  check(leaders.length === 1, `1. Exactly one server runs the background jobs (${leaders.length === 1 ? (leaders[0] === A ? 'A' : 'B') : leaders.length})`);

  const login = async (p, role, id) => (await call(p, 'POST', '/api/auth/login', { role, identifier: id, password: 'x' })).body.token;
  const d = await login(A, 'dispatcher', 'DSP-7704');
  const H1 = 'HSP-001', H2 = 'HSP-002';
  const h1 = await login(B, 'hospital', H1), h2 = await login(A, 'hospital', H2);

  const onB = await open(B, h1), onA = await open(A, d);
  const heardOnB = [], heardOnA = [];
  onB.on('reservation:update', (p) => heardOnB.push(p));
  onA.on('reservation:update', (p) => heardOnA.push(p));

  // 2. events cross servers
  const rid = (await call(A, 'POST', '/api/requests', { emergency_type: 'Other', patient_condition: 'Critical', patient_age: 50, location: { lat: 18.5308, lng: 73.8475 }, requirements: { icu: true } }, d)).body.request.request_id;
  await call(A, 'POST', `/api/requests/${rid}/broadcast`, { hospital_id: H1 }, d);
  check(await waitFor(() => heardOnB.some(p => p.request?.request_id === rid && p.action === 'held' && p.hospital_id === H1)),
    '2. Alert sent on server A → the hospital screen connected to server B hears it at once');
  const item = (await call(B, 'GET', '/api/reservations', null, h1)).body.items.find(i => i.request.request_id === rid);
  const acc = await call(B, 'PATCH', `/api/reservations/${item.reservation_id}`, { action: 'accept' }, h1);
  check(acc.status === 200 && await waitFor(() => heardOnA.some(p => p.request?.request_id === rid && p.action === 'accepted')),
    '2. Hospital accepts on server B → the dispatcher screen on server A hears "accepted"');

  // 3. GPS across servers
  const got = [];
  onB.on('ambulance:position', (p) => got.push(p));
  onA.emit('ambulance:position', { request_id: rid, lat: 18.5251, lng: 73.8512, source: 'gps' });
  check(await waitFor(() => got.some(p => p.request_id === rid)), '3. Crew GPS sent to server A → shows on the hospital map on server B');
  const pos = (await call(B, 'GET', `/api/requests/${rid}/position`)).body.position;
  check(pos?.lat === 18.5251, '3. Server B can read the last position (stored in Postgres, not in one server\'s memory)');

  // 4. simultaneous accepts on different servers
  const icu = async (h) => (await call(A, 'GET', `/api/hospitals/${h}`)).body.resources.icu.available;
  const rid2 = (await call(A, 'POST', '/api/requests', { emergency_type: 'Other', patient_condition: 'Critical', patient_age: 50, location: { lat: 18.5308, lng: 73.8475 }, requirements: { icu: true } }, d)).body.request.request_id;
  await call(A, 'POST', `/api/requests/${rid2}/broadcast`, { hospital_id: H1 }, d);
  await call(A, 'POST', `/api/requests/${rid2}/broadcast`, { hospital_id: H2 }, d);
  const before = { [H1]: await icu(H1), [H2]: await icu(H2) };
  const r1 = (await call(B, 'GET', '/api/reservations', null, h1)).body.items.find(i => i.request.request_id === rid2);
  const r2 = (await call(A, 'GET', '/api/reservations', null, h2)).body.items.find(i => i.request.request_id === rid2);
  const [x, y] = await Promise.all([
    call(B, 'PATCH', `/api/reservations/${r1.reservation_id}`, { action: 'accept' }, h1),
    call(A, 'PATCH', `/api/reservations/${r2.reservation_id}`, { action: 'accept' }, h2),
  ]);
  const wins = [x, y].filter(r => r.status === 200), lost = [x, y].filter(r => r.status === 409);
  check(wins.length === 1 && lost.length === 1 && lost[0].body.code === 'ALREADY_FILLED',
    `4. Two hospitals accept at the same instant on different servers → ${wins.length} winner, ${lost.length} told "already filled"`);
  const winner = wins[0]?.body.hospital_id, loser = winner === H1 ? H2 : H1;
  check(await icu(winner) === before[winner] - 1 && await icu(loser) === before[loser], '4. Only the winner lost a bed; the other hospital\'s beds are untouched');

  // 5. leader failover
  const rid3 = (await call(A, 'POST', '/api/requests', { emergency_type: 'Other', patient_condition: 'Stable', patient_age: 30, location: { lat: 18.5308, lng: 73.8475 }, requirements: { icu: true } }, d)).body.request.request_id;
  await call(A, 'POST', `/api/requests/${rid3}/broadcast`, { hospital_id: H2 }, d);
  const leader = leaders[0], other = leader === A ? B : A;
  leader.kill();
  await directSql(null, `UPDATE reservations SET requested_at = ?, expires_at = ? WHERE request_id = ? AND reservation_status = 'PENDING'`,
    [new Date(Date.now() - 120000).toISOString(), new Date(Date.now() - 1000).toISOString(), rid3]);
  const took = await waitFor(() => /runs the background jobs/.test(other.log), 25000);
  let expired = false;
  for (let i = 0; took && i < 40 && !expired; i++) {
    const det = (await call(other, 'GET', `/api/requests/${rid3}`)).body;
    expired = !!det.reservations?.some(r => r.reservation_status === 'EXPIRED');
    if (!expired) await sleep(250);
  }
  check(took, '5. The leader stops → the other server takes over the background jobs');
  check(expired, '5. …and unanswered holds still expire (the sweeper now runs there)');
} catch (e) {
  console.error(e); failures++;
} finally {
  for (const s of sockets) s.close();
  for (const p of Object.values(servers)) p.kill();
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: several servers share one Postgres database and live events');
process.exit(failures ? 1 : 0);
