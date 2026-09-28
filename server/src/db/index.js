// Opens the SQLite database and makes sure the tables exist (from schema.sql)
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'emergency.db');

// Bump this whenever schema.sql changes: old local databases get rebuilt automatically.
const SCHEMA_VERSION = 8;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better for many simultaneous reads/writes
db.pragma('foreign_keys = ON');

if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) {
  // Drop whatever old tables exist, then create the current ones
  db.pragma('foreign_keys = OFF');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.pragma('foreign_keys = ON');
  console.log(`🛠️  Database schema updated to v${SCHEMA_VERSION}. Run "npm run seed" to load data.`);
}

db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
db.pragma(`user_version = ${SCHEMA_VERSION}`);

// ───────────── Supabase sync bookkeeping (outbox filled by triggers) ─────────────
// Every insert/update/delete on a mirrored table adds a row to sync_outbox while sync is enabled;
// services/supabaseSync.js pushes those rows to Supabase about once a second. Works for every
// writer (API, simulator, sweeper) without touching their code.
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
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0, initialized INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO sync_state (id, enabled, initialized) VALUES (1, 0, 0);
`);
for (const [t, pk] of SYNC_TABLES) {
  const on = `WHEN (SELECT enabled FROM sync_state WHERE id = 1) = 1`;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_${t}_ins AFTER INSERT ON ${t} ${on} BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('${t}', NEW.${pk}, 'upsert'); END;
    CREATE TRIGGER IF NOT EXISTS sync_${t}_upd AFTER UPDATE ON ${t} ${on} BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('${t}', NEW.${pk}, 'upsert'); END;
    CREATE TRIGGER IF NOT EXISTS sync_${t}_del AFTER DELETE ON ${t} ${on} BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('${t}', OLD.${pk}, 'delete'); END;
  `);
}

export default db;
