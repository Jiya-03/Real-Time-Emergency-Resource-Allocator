// Loads Jiya's ERRA synthetic dataset (data/erra_dataset/*.csv) into SQLite.
//
//   npm run seed              → load + time-shift so the data looks "live" right now
//   npm run seed -- --no-shift → load with the original timestamps (2026-09-28 12:00 IST snapshot)
//
// Why time-shift? The dataset's "now" is 2026-09-28 12:00 IST. Freshness is measured
// against the real clock, so without shifting every hospital would look hours stale.
// Shifting moves ALL timestamps by the same amount, so fresh/aging/stale stay exactly as designed.
import '../env.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import db from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', 'erra_dataset');

const SNAPSHOT_IST = '2026-09-28 12:00:00';
const SHIFT = !process.argv.includes('--no-shift');

// Dataset timestamps are Pune local time (IST, UTC+05:30)
const parseIST = (s) => new Date(s.replace(' ', 'T') + '+05:30');
const shiftMs = SHIFT ? Date.now() - parseIST(SNAPSHOT_IST).getTime() : 0;
const toISO = (s) => new Date(parseIST(s).getTime() + shiftMs).toISOString();

// Load order matters for readability; FKs are checked once at the end.
const TABLES = [
  { name: 'hospitals',                   file: 'hospitals.csv',                   time: [] },
  { name: 'hospital_resources',          file: 'hospital_resources.csv',          time: ['last_updated_timestamp'] },
  { name: 'hospital_services',           file: 'hospital_services.csv',           time: [] },
  { name: 'ambulances',                  file: 'ambulances.csv',                  time: ['last_location_update'] },
  { name: 'emergency_requests',          file: 'emergency_requests.csv',          time: ['request_timestamp'] },
  { name: 'resource_update_history',     file: 'resource_update_history.csv',     time: ['updated_at'] },
  { name: 'reservations',                file: 'reservations.csv',                time: ['requested_at', 'confirmed_at', 'expires_at'] },
  { name: 'emergency_workflow_handover', file: 'emergency_workflow_handover.csv', time: ['assignment_time', 'departure_time', 'arrival_time', 'handover_time'] },
  { name: 'match_ranking_results',       file: 'match_ranking_results.csv',       time: [] },
];

function convert(value, column, timeCols) {
  if (value === '') return null;                 // empty CSV field = NULL
  if (value === 'TRUE') return 1;
  if (value === 'FALSE') return 0;
  if (timeCols.includes(column)) return toISO(value);
  return value;                                  // SQLite converts numeric strings via column type
}

if (!existsSync(DATA_DIR)) {
  console.error(`❌ Dataset folder not found: ${DATA_DIR}`);
  process.exit(1);
}

console.log(`📂 Loading dataset from ${DATA_DIR}`);
console.log(SHIFT
  ? `⏱️  Time-shifted: dataset snapshot (${SNAPSHOT_IST} IST) → now`
  : `⏱️  Original timestamps kept (--no-shift)`);

db.pragma('foreign_keys = OFF');   // ambulances ↔ requests reference each other

const load = db.transaction(() => {
  // Clear old data (reverse order), then insert fresh
  db.prepare('DELETE FROM admissions').run();          // our own table (not in the dataset)
  for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t.name}`).run();

  const counts = {};
  for (const t of TABLES) {
    const rows = parse(readFileSync(path.join(DATA_DIR, t.file)), { columns: true, skip_empty_lines: true, bom: true });
    const cols = Object.keys(rows[0]);
    const insert = db.prepare(
      `INSERT INTO ${t.name} (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
    );
    for (const row of rows) {
      const clean = {};
      for (const c of cols) clean[c] = convert(row[c], c, t.time);
      insert.run(clean);
    }
    counts[t.name] = rows.length;
  }
  return counts;
});

try {
  const counts = load();
  const broken = db.pragma('foreign_key_check');
  db.pragma('foreign_keys = ON');
  if (broken.length) {
    console.error(`❌ ${broken.length} broken foreign-key references`, broken.slice(0, 5));
    process.exit(1);
  }
  console.table(counts);
  console.log('✅ Dataset loaded successfully');
} catch (err) {
  console.error('❌ Seeding failed:', err.message);
  process.exit(1);
}
