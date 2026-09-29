// A throw-away copy of the whole system for the Scenarios page.
// It is a second server process (same code) on its own fresh SQLite file with the full dataset,
// so scenarios can empty beds, age data and fire 20 requests at once without touching real data.
// Started on the first run, stopped after 10 idle minutes (or when the main server stops).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDLE_MS = 10 * 60 * 1000;

// Short timers so "no answer" scenarios finish in seconds (the real app uses 60 s / 30 s)
export const SANDBOX_TIMERS = { RESPONSE_SECONDS: 5, BETTER_WAIT_SECONDS: 3 };

let sb = null;          // { proc, base, dbPath, raw }
let starting = null;
let idleTimer = null;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

function run(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`))));
  });
}

async function start() {
  hookExit();
  const dbPath = path.join(os.tmpdir(), `jeevanroute-sandbox-${process.pid}-${Date.now()}.db`);
  const port = await freePort();
  const env = {
    ...process.env, DB_PATH: dbPath, PORT: String(port), SIMULATOR: 'off',
    DATABASE_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MAPBOX_TOKEN: '',     // offline + deterministic
    BROADCAST_MAX: '3', ETA_BAND_MIN: '10', SCORE_BAND: '0.85', SANDBOX_PARENT_PID: String(process.pid),
    RESPONSE_SECONDS: String(SANDBOX_TIMERS.RESPONSE_SECONDS), BETTER_WAIT_SECONDS: String(SANDBOX_TIMERS.BETTER_WAIT_SECONDS),
  };
  await run(['src/db/seed.js'], env);
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(dbPath);
  raw.pragma('busy_timeout = 3000');
  proc.on('exit', () => { if (sb?.proc === proc) sb = null; });
  return { proc, base, dbPath, raw };
}

/** The running sandbox (starts one if needed). */
export async function getSandbox() {
  clearTimeout(idleTimer);
  if (!sb) {
    starting ||= start().finally(() => { starting = null; });
    sb = await starting;
  }
  idleTimer = setTimeout(stopSandbox, IDLE_MS);
  idleTimer.unref?.();
  return sb;
}

export function stopSandbox() {
  if (!sb) return;
  try { sb.raw.close(); } catch { /* already closed */ }
  sb.proc.kill();
  const dbPath = sb.dbPath;
  sb = null;
  // Windows keeps the file locked for a moment after the process stops
  setTimeout(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + ext, { force: true }); } catch { /* next start overwrites it */ } } }, 500).unref();
}

// Stop the sandbox together with the main server (Ctrl+C, nodemon restart). The sandbox also
// watches this process and exits by itself if it disappears (see SANDBOX_PARENT_PID in index.js).
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on('exit', stopSandbox);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    try { process.once(sig, () => { stopSandbox(); process.kill(process.pid, sig); }); } catch { /* signal not available on this OS */ }
  }
}
