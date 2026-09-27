// Opens the SQLite database and creates tables from schema.sql
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'emergency.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better for many simultaneous reads/writes
db.pragma('foreign_keys = ON');

db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

export default db;
