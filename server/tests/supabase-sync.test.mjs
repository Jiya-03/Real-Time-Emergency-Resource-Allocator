// Supabase two-way sync, tested offline against an in-memory fake of the Supabase client.
// Run: npm run test:sync
//  1. FIRST RUN: the whole local database is copied to Supabase.
//  2. APP → SUPABASE: a bed change in the app reaches Supabase on the next flush (≈1 s live).
//  3. SUPABASE → APP: editing beds / adding a hospital / deleting one in Supabase updates the app.
//  4. SAFETY: invalid edits are rejected and Supabase is put back; hospitals with history are
//     deactivated instead of deleted; our own changes echoing back are ignored.
import { PG } from './_env.mjs';
if (PG) { console.log('⏭️  Supabase mirror sync is SQLite-only (in Postgres mode Supabase IS the database): skipped'); process.exit(0); }
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-sync-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SUPABASE_URL = ''; process.env.SUPABASE_SERVICE_ROLE_KEY = '';
execSync('node src/db/seed.js', { cwd: serverDir, env: { ...process.env }, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };

// ── in-memory fake of the parts of supabase-js we use ──
function fakeSupabase() {
  const tables = {};
  const handlers = [];
  const T = (t) => (tables[t] ||= new Map());
  const PK = { hospitals: 'hospital_id', hospital_resources: 'resource_record_id', hospital_services: 'service_record_id', ambulances: 'ambulance_id',
    emergency_requests: 'request_id', reservations: 'reservation_id', emergency_workflow_handover: 'workflow_id', admissions: 'request_id',
    resource_update_history: 'update_id', match_ranking_results: 'match_id', ambulance_positions: 'request_id' };
  const ok = (data = null, extra = {}) => Promise.resolve({ data, error: null, ...extra });
  return {
    tables, handlers,
    from(t) {
      const map = T(t), pk = PK[t];
      return {
        upsert(rows) { for (const r of [].concat(rows)) map.set(r[pk], { ...(map.get(r[pk]) || {}), ...r }); return ok(); },
        delete() {
          return {
            in(col, vals) { for (const v of vals) for (const [k, r] of map) if (r[col] === v) map.delete(k); return ok(); },
            neq(col, v) { for (const [k, r] of map) if (r[col] !== v) map.delete(k); return ok(); },
            eq(col, v) { for (const [k, r] of map) if (r[col] === v) map.delete(k); return ok(); },
          };
        },
        select(_, opts) {
          if (opts?.head) return ok(null, { count: map.size });
          return { range(a, b) { return ok([...map.values()].slice(a, b + 1).map(r => ({ ...r }))); } };
        },
      };
    },
    channel() {
      const ch = { on(_, filter, cb) { handlers.push({ table: filter.table, cb }); return ch; }, subscribe(cb) { cb?.('SUBSCRIBED'); return ch; } };
      return ch;
    },
    // simulate an edit made in the Supabase dashboard
    remote(t, eventType, row, old) {
      if (eventType === 'DELETE') T(t).delete(old[PK[t]]); else T(t).set(row[PK[t]], { ...row });
      for (const h of handlers) if (h.table === t) h.cb({ eventType, new: row || {}, old: old || {} });
    },
  };
}

try {
  const { default: db } = await import('../src/db/index.js');
  const sync = await import('../src/services/supabaseSync.js');
  const { updateHospitalResources, getHospital } = await import('../src/services/hospitalService.js');
  const { default: bus, EVENTS } = await import('../src/events.js');
  const fake = fakeSupabase();
  const seen = [];
  bus.on(EVENTS.HOSPITAL_UPDATE, (p) => seen.push(p));

  // 1. FIRST RUN
  await sync.startSync({ client: fake, noTimer: true });
  const n = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  check(fake.tables.hospitals.size === await n('hospitals') && fake.tables.emergency_requests.size === await n('emergency_requests')
    && fake.tables.match_ranking_results.size === await n('match_ranking_results'), `FIRST RUN: full copy (${fake.tables.hospitals.size} hospitals, ${fake.tables.emergency_requests.size} emergencies, ${fake.tables.match_ranking_results.size} rankings)`);
  check(fake.handlers.length === 3, 'Realtime subscribed to hospitals / hospital_resources / hospital_services');

  // 2. APP → SUPABASE
  const H = 'HSP-003';
  const h0 = await getHospital(H);
  const newIcu = h0.resources.icu.available > 0 ? h0.resources.icu.available - 1 : 1;
  await updateHospitalResources(H, { icu: newIcu }, { source: 'Hospital Staff' });
  check((await sync.syncStatus()).pending > 0, `APP → SUPABASE: change queued (${(await sync.syncStatus()).pending} pending)`);
  await sync.flush();
  const rr = [...fake.tables.hospital_resources.values()].find(r => r.hospital_id === H);
  check(rr.available_icu_beds === newIcu && (await sync.syncStatus()).pending === 0, `APP → SUPABASE: ICU ${h0.resources.icu.available} → ${newIcu} visible in Supabase`);

  // 3a. SUPABASE → APP: edit beds in the dashboard
  const edited = { ...rr, available_general_beds: Math.max(0, rr.available_general_beds - 3) };
  seen.length = 0;
  fake.remote('hospital_resources', 'UPDATE', edited);
  await sync.settle();
  const h1 = await getHospital(H);
  check(h1.resources.general_bed.available === edited.available_general_beds, `SUPABASE → APP: general beds edited in Supabase → app shows ${edited.available_general_beds}`);
  check(h1.update_source === 'Admin' && h1.version === rr.version + 1, 'SUPABASE → APP: marked as an Admin update, version bumped (open edit screens refresh)');
  check(seen.some(p => p.source === 'Supabase' && p.hospital.hospital_id === H), 'SUPABASE → APP: every screen is notified (hospital:update)');
  await sync.flush();
  check(fake.tables.hospital_resources.get(rr.resource_record_id).version === rr.version + 1, 'Normalised row (version / source) pushed back to Supabase');
  check(await sync.applyRemote('hospital_resources', 'UPDATE', fake.tables.hospital_resources.get(rr.resource_record_id)) === 'noop', 'ECHO: our own change coming back is ignored');

  // 3b. new hospital created in Supabase
  fake.remote('hospitals', 'INSERT', { hospital_id: 'HSP-026', hospital_name: 'Symbiosis Test Hospital', hospital_type: 'Private', latitude: 18.54, longitude: 73.73,
    address: 'Lavale, Pune', emergency_department: 1, active_status: 1 });
  await sync.settle();
  const nh = await getHospital('HSP-026');
  check(nh && nh.name === 'Symbiosis Test Hospital' && nh.resources.icu.total === 0, 'NEW HOSPITAL: created in Supabase → appears in the app (empty beds to fill in)');
  await sync.flush();
  check([...fake.tables.hospital_resources.values()].some(r => r.hospital_id === 'HSP-026'), 'NEW HOSPITAL: its beds / departments rows appear in Supabase to edit');
  const nr = [...fake.tables.hospital_resources.values()].find(r => r.hospital_id === 'HSP-026');
  fake.remote('hospital_resources', 'UPDATE', { ...nr, total_icu_beds: 10, available_icu_beds: 6 });
  await sync.settle();
  check((await getHospital('HSP-026')).resources.icu.available === 6, 'NEW HOSPITAL: beds filled in Supabase → 6 of 10 ICU in the app');
  const ns = [...fake.tables.hospital_services.values()].find(r => r.hospital_id === 'HSP-026');
  fake.remote('hospital_services', 'UPDATE', { ...ns, trauma_care: 1, specialists: 'Trauma Surgeon' });
  await sync.settle();
  check((await getHospital('HSP-026')).services.trauma_care === true && (await getHospital('HSP-026')).specialists[0] === 'Trauma Surgeon', 'NEW HOSPITAL: departments switched on in Supabase');

  // 4a. invalid edit
  const before = (await getHospital(H)).resources.ventilator;
  const cur = fake.tables.hospital_resources.get(rr.resource_record_id);
  fake.remote('hospital_resources', 'UPDATE', { ...cur, available_ventilators: before.total + 5 });
  await sync.settle();
  check((await getHospital(H)).resources.ventilator.available === before.available, 'INVALID: available > total is rejected, app unchanged');
  await sync.flush();
  check(fake.tables.hospital_resources.get(rr.resource_record_id).available_ventilators === before.available, 'INVALID: Supabase put back to the valid value');

  // 4b. delete a hospital with history → deactivated
  fake.remote('hospitals', 'DELETE', null, { hospital_id: 'HSP-001' });
  await sync.settle();
  check((await getHospital('HSP-001'))?.active === false, 'DELETE with history: HSP-001 kept but deactivated (emergency records stay intact)');
  await sync.flush();
  check(fake.tables.hospitals.get('HSP-001')?.active_status === 0, 'DELETE with history: row reappears in Supabase as inactive');

  // 4c. delete a hospital without history → deleted
  fake.remote('hospitals', 'DELETE', null, { hospital_id: 'HSP-026' });
  await sync.settle();
  check(!await getHospital('HSP-026'), 'DELETE: HSP-026 (no history) deleted from the app');
  await sync.flush();
  check(![...fake.tables.hospital_resources.values()].some(r => r.hospital_id === 'HSP-026'), 'DELETE: its beds / departments rows removed from Supabase too');

  // positions
  sync.pushPosition({ request_id: 'REQ-000001', hospital_id: H, lat: 18.5, lng: 73.8, source: 'gps', accuracy_m: 12, left_km: 3.2, eta_min: 7, at: new Date().toISOString() });
  await new Promise(r => setTimeout(r, 10));
  check(fake.tables.ambulance_positions.get('REQ-000001')?.eta_min === 7, 'LIVE TRACKING: ambulance position written to ambulance_positions');
  sync.stopSync();
} catch (e) {
  console.error(e); failures++;
} finally {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: Supabase two-way live sync');
process.exit(failures ? 1 : 0);
