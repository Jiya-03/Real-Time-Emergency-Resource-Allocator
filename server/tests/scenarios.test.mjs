// The Scenarios page runs end to end (it starts its own sandbox copy). Run: npm run test:scenarios
import './_env.mjs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-scen-${process.pid}.db`);
const PORT = 7100 + (process.pid % 200);
const env = { ...process.env, DB_PATH, PORT: String(PORT), SIMULATOR: 'off' };
execSync('node src/db/seed.js', { cwd: serverDir, env, stdio: 'ignore' });
const server = spawn('node', ['src/index.js'], { cwd: serverDir, env, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
try {
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const before = (await (await fetch(BASE + '/api/health')).json()).db.emergency_requests;
  const list = (await (await fetch(BASE + '/api/scenarios')).json()).scenarios;
  check(list.length === 6, `${list.length} scenarios listed`);
  const text = await (await fetch(`${BASE}/api/scenarios/run?id=all`)).text();
  const events = text.split('\n\n').filter(Boolean).map(b => ({ ev: b.match(/event: (\w+)/)?.[1], data: JSON.parse(b.match(/data: (.*)/)?.[1] || '{}') }));
  for (const d of events.filter(e => e.ev === 'done')) check(d.data.pass, `Scenario "${d.data.id}" passes on the sandbox`);
  const end = events.find(e => e.ev === 'end');
  check(end?.data.pass, `All scenarios pass (${(end?.data.ms / 1000).toFixed(1)} s)`);
  const after = (await (await fetch(BASE + '/api/health')).json()).db.emergency_requests;
  check(after === before, `Real data untouched (${after} emergencies before and after)`);
} catch (e) {
  console.error(e); failures++;
} finally {
  server.kill();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: Scenarios page (stale data, double-booking, simultaneous requests, full workflow)');
process.exit(failures ? 1 : 0);
