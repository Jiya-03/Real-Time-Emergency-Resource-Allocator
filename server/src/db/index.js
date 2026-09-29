// Database access for the whole server. Two drivers, one API:
//
//   • SQLite (default)  → a local file (emergency.db). Zero setup, works offline: best for demos.
//   • Postgres          → set DATABASE_URL (e.g. your Supabase project's connection string).
//                         Several server instances can then run side by side on the same data,
//                         and Socket.io shares live events between them (sockets/index.js).
//
// Every call is async:
//   await db.prepare(sql).get(...params)   → one row (or undefined)
//   await db.prepare(sql).all(...params)   → rows
//   await db.prepare(sql).run(...params)   → { changes }
//   await db.transaction(async () => { ... })()   → all-or-nothing; nested calls join the outer one
// SQL is written once with `?` (or @name) placeholders and works on both databases.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DRIVER = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

// Tables mirrored to Supabase by services/supabaseSync.js (SQLite mode only; in Postgres mode Supabase IS the database)
export const SYNC_TABLES = [
  // [table, primary key, two-way?]  two-way = edits made in Supabase flow back into the app
  ['hospitals', 'hospital_id', true],
  ['hospital_resources', 'resource_record_id', true],
  ['hospital_services', 'service_record_id', true],
  ['ambulances', 'ambulance_id', false],
  ['emergency_requests', 'request_id', false],
  ['reservations', 'reservation_id', false],
  ['emergency_workflow_handover', 'workflow_id', false],
  ['admissions', 'request_id', false],
  ['resource_update_history', 'update_id', false],
  ['match_ranking_results', 'match_id', false],
];

// Our own bookkeeping tables (both drivers)
const EXTRA_TABLES = `
  -- which hospital the dispatcher picked by hand, and which hospitals said yes while a better-ranked one was still deciding
  CREATE TABLE IF NOT EXISTS dispatch_marks (
    request_id TEXT NOT NULL, hospital_id TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,       -- 1 = alerted by the dispatcher's own choice: its accept is final
    offered_at TEXT, decide_at TEXT,         -- set when it said yes; decide_at = when the best offer is confirmed at the latest
    PRIMARY KEY (request_id, hospital_id));
  -- which dispatcher (ambulance crew) logged each emergency: only they may stream its GPS position
  CREATE TABLE IF NOT EXISTS request_owners (
    request_id TEXT PRIMARY KEY, dispatcher_id TEXT NOT NULL, created_at TEXT NOT NULL);
`;

// '@name' placeholders → '?' + an ordered parameter list
function bind(sql, args) {
  const a = args[0];
  if (args.length === 1 && a && typeof a === 'object' && !Array.isArray(a) && /@\w/.test(sql)) {
    const params = [];
    const out = sql.replace(/@(\w+)/g, (_, k) => { params.push(a[k] === undefined ? null : a[k]); return '?'; });
    return [out, params];
  }
  return [sql, args.map(v => (v === undefined ? null : v))];
}

// '?' → '$1, $2, …' (Postgres), skipping anything inside quotes
function toPg(sql) {
  let n = 0, out = '', q = null;
  for (const ch of sql) {
    if (q) { if (ch === q) q = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

const als = new AsyncLocalStorage();          // the open transaction for this async flow, if any
const inTx = () => { const s = als.getStore(); return s && !s.done ? s : null; };

let raw = null;        // better-sqlite3 handle (SQLite mode)
let pool = null;       // pg.Pool (Postgres mode)

// ───────────────────────────── SQLite ─────────────────────────────
if (DRIVER === 'sqlite') {
  const { default: Database } = await import('better-sqlite3');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'emergency.db');
  // Bump this whenever schema.sql changes: old local databases get rebuilt automatically.
  const SCHEMA_VERSION = 8;

  raw = new Database(DB_PATH);
  raw.pragma('journal_mode = WAL');   // better for many simultaneous reads/writes
  raw.pragma('foreign_keys = ON');

  if (raw.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) {
    raw.pragma('foreign_keys = OFF');
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) raw.exec(`DROP TABLE IF EXISTS "${name}"`);
    raw.pragma('foreign_keys = ON');
    console.log(`🛠️  Database schema updated to v${SCHEMA_VERSION}. Run "npm run seed" to load data.`);
  }
  raw.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  raw.pragma(`user_version = ${SCHEMA_VERSION}`);
  raw.exec(EXTRA_TABLES);
  // live ambulance position (in Postgres mode this is the Supabase table of the same name)
  raw.exec(`CREATE TABLE IF NOT EXISTS ambulance_positions (
    request_id TEXT PRIMARY KEY, hospital_id TEXT, lat REAL NOT NULL, lng REAL NOT NULL, source TEXT NOT NULL,
    accuracy_m INTEGER, left_km REAL, eta_min INTEGER, updated_at TEXT NOT NULL)`);

  // Supabase sync bookkeeping: every insert/update/delete on a mirrored table adds a row to sync_outbox
  // while sync is enabled; services/supabaseSync.js pushes those rows about once a second.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0, initialized INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO sync_state (id, enabled, initialized) VALUES (1, 0, 0);
  `);
  for (const [t, pk] of SYNC_TABLES) {
    const on = `WHEN (SELECT enabled FROM sync_state WHERE id = 1) = 1`;
    raw.exec(`
      CREATE TRIGGER IF NOT EXISTS sync_${t}_ins AFTER INSERT ON ${t} ${on} BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('${t}', NEW.${pk}, 'upsert'); END;
      CREATE TRIGGER IF NOT EXISTS sync_${t}_upd AFTER UPDATE ON ${t} ${on} BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('${t}', NEW.${pk}, 'upsert'); END;
      CREATE TRIGGER IF NOT EXISTS sync_${t}_del AFTER DELETE ON ${t} ${on} BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('${t}', OLD.${pk}, 'delete'); END;
    `);
  }
}

// ───────────────────────────── Postgres ─────────────────────────────
if (DRIVER === 'postgres') {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v));                       // COUNT(*), bigint → number
  pg.types.setTypeParser(1700, (v) => Number(v));                     // numeric → number
  pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());     // timestamptz → ISO text (same as SQLite)
  pg.types.setTypeParser(1114, (v) => new Date(v + 'Z').toISOString());
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /sslmode=disable/.test(url);
  pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: Number(process.env.PG_POOL_SIZE) || 6 });
  pool.on('error', (e) => console.error('🟠 [postgres]', e.message));
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727000)');                 // several servers starting at once: one sets up at a time
    await c.query(readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8'));
    await c.query(EXTRA_TABLES);
  } finally {
    await c.query('SELECT pg_advisory_unlock(727000)').catch(() => {});
    c.release();
  }
}

// ───────────────────────────── one API for both ─────────────────────────────
async function query(kind, sql, args) {
  const [s, params] = bind(sql, args);
  if (DRIVER === 'sqlite') {
    const stmt = raw.prepare(s);
    if (kind === 'get') return stmt.get(...params);
    if (kind === 'all') return stmt.all(...params);
    return { changes: stmt.run(...params).changes };
  }
  const client = inTx()?.client || pool;
  const res = await client.query(toPg(s), params);
  if (kind === 'get') return res.rows[0];
  if (kind === 'all') return res.rows;
  return { changes: res.rowCount };
}

let chain = Promise.resolve();                   // SQLite: one transaction at a time
async function tx(fn) {
  if (inTx()) return fn();                       // nested → part of the outer transaction
  if (DRIVER === 'sqlite') {
    const run = async () => {
      const store = { done: false };
      raw.exec('BEGIN IMMEDIATE');
      try { const r = await als.run(store, fn); raw.exec('COMMIT'); return r; }
      catch (e) { if (raw.inTransaction) raw.exec('ROLLBACK'); throw e; }
      finally { store.done = true; }
    };
    const p = chain.then(run, run);
    chain = p.then(() => {}, () => {});
    return p;
  }
  const client = await pool.connect();
  const store = { client, done: false };
  try {
    await client.query('BEGIN');
    const r = await als.run(store, fn);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    store.done = true;
    client.release();
  }
}

// Background jobs (expiry sweeper, simulator) must run on ONE server only: the one holding this lock
let leaderClient = null;
async function isLeader() {
  if (DRIVER === 'sqlite') return true;
  if (leaderClient) return true;
  const c = await pool.connect();
  const ok = (await c.query('SELECT pg_try_advisory_lock(727001) AS ok')).rows[0].ok;
  if (!ok) { c.release(); return false; }
  leaderClient = c;
  c.on('error', () => { leaderClient = null; });
  return true;
}

const db = {
  driver: DRIVER,
  prepare: (sql) => ({
    get: (...a) => query('get', sql, a),
    all: (...a) => query('all', sql, a),
    run: (...a) => query('run', sql, a),
  }),
  async exec(sql) {
    if (DRIVER === 'sqlite') return raw.exec(sql);
    await (inTx()?.client || pool).query(sql);
  },
  transaction: (fn) => (...args) => tx(() => fn(...args)),
  tx,
  // Fast bulk insert (seeding): multi-row VALUES in chunks
  async insertMany(table, cols, rows) {
    const per = Math.max(1, Math.floor(30000 / cols.length));
    for (let i = 0; i < rows.length; i += per) {
      const part = rows.slice(i, i + per);
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}`;
      await query('run', sql, part.flatMap(r => cols.map(c => r[c] ?? null)));
    }
  },
  isLeader,
  inTransaction: () => !!inTx(),
  // Postgres: lock this row until the transaction ends, so concurrent changes to the same emergency /
  // hospital run one after the other (SQLite already runs one transaction at a time: no-op there)
  async lock(table, keyCol, id) {
    if (DRIVER === 'postgres' && inTx()) await query('get', `SELECT 1 AS ok FROM ${table} WHERE ${keyCol} = ? FOR UPDATE`, [id]);
  },
  get pool() { return pool; },
  get raw() { return raw; },
  async close() { if (raw) raw.close(); if (leaderClient) leaderClient.release(); if (pool) await pool.end(); },
};

export default db;
