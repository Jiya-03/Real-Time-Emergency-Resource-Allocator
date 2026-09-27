// Opens the SQLite database and makes sure the tables exist (from schema.sql)
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'emergency.db');

// Bump this whenever schema.sql changes: old local databases get rebuilt automatically.
const SCHEMA_VERSION = 3;

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

export default db;
