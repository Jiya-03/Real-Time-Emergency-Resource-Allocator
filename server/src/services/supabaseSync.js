// Live two-way sync between the app's local SQLite database and Supabase (Postgres).
//
//   App → Supabase  : SQLite triggers write every change to sync_outbox; await flush() pushes them about
//                     once a second (upsert / delete). All tables are mirrored, so Supabase always
//                     shows the live state: hospitals, beds, emergencies, holds, handovers, admissions.
//                     Ambulance positions go to public.ambulance_positions as they stream in.
//   Supabase → App  : Realtime subscription on hospitals / hospital_resources / hospital_services.
//                     Create, edit or delete a hospital (or its beds / departments) in the Supabase
//                     Table Editor and the app applies it within a second and pushes it to every screen.
//
// The local database stays the source of truth for bookings (its conditional UPDATEs are what stop
// double-booking); Supabase is the shared, editable, live window onto it.
// Enabled only when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (server/.env).
import db, { SYNC_TABLES } from '../db/index.js';
import { getHospital } from './hospitalService.js';
import bus, { EVENTS } from '../events.js';

const CHUNK = 500;
const TABLE = Object.fromEntries(SYNC_TABLES.map(([t, pk, twoWay]) => [t, { pk, twoWay }]));
const status = { enabled: false, realtime: 'off', initialized: false, last_push: null, pushed: 0, pulled: 0, pending: 0, errors: [] };
let client = null;
let flushing = false;
let timer = null;

const log = (...a) => console.log('🟢 [supabase]', ...a);
function fail(where, err) {
  const msg = `${where}: ${err?.message || err}`;
  status.errors.unshift({ at: new Date().toISOString(), msg });
  status.errors.length = Math.min(status.errors.length, 20);
  console.warn('🟠 [supabase]', msg);
}
const columns = async (t) => (await db.prepare(`PRAGMA table_info(${t})`).all()).map(c => c.name);
const setEnabled = async (on) => await db.prepare('UPDATE sync_state SET enabled = ? WHERE id = 1').run(on ? 1 : 0);

async function upsert(t, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await client.from(t).upsert(rows.slice(i, i + CHUNK), { onConflict: TABLE[t]?.pk || 'request_id' });
    if (error) throw new Error(`${t} upsert: ${error.message}`);
  }
}
async function remove(t, pks) {
  for (let i = 0; i < pks.length; i += CHUNK) {
    const { error } = await client.from(t).delete().in(TABLE[t].pk, pks.slice(i, i + CHUNK));
    if (error) throw new Error(`${t} delete: ${error.message}`);
  }
}
async function selectAll(t) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from(t).select('*').range(from, from + 999);
    if (error) throw new Error(`${t} select: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ───────────── App → Supabase ─────────────
let subscribed = false, wantRealtime = true;
export async function flush() {
  if (!client || flushing) return;
  flushing = true;
  try {
    if (!status.initialized) {                        // start-up failed earlier (offline?): retry the full copy first
      await fullPush();
      if (wantRealtime && !subscribed) await subscribe();
    }
    const batch = await db.prepare('SELECT * FROM sync_outbox ORDER BY seq LIMIT 5000').all();
    status.pending = (await db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).n;
    if (!batch.length) return;
    const byTable = {};
    for (const r of batch) (byTable[r.tbl] ||= new Map()).set(r.pk, r.op);   // last op per row wins
    for (const [t] of SYNC_TABLES) {                                         // parents before children
      const ops = byTable[t]; if (!ops) continue;
      const ups = [...ops].filter(([, op]) => op === 'upsert').map(([pk]) => pk);
      const dels = [...ops].filter(([, op]) => op === 'delete').map(([pk]) => pk);
      if (ups.length) {
        const rows = [];
        for (let i = 0; i < ups.length; i += CHUNK) {
          const part = ups.slice(i, i + CHUNK);
          rows.push(...(await db.prepare(`SELECT * FROM ${t} WHERE ${TABLE[t].pk} IN (${part.map(() => '?').join(',')})`).all(...part)));
        }
        const found = new Set(rows.map(r => r[TABLE[t].pk]));
        dels.push(...ups.filter(pk => !found.has(pk)));                        // changed then deleted locally
        if (rows.length) await upsert(t, rows);
      }
      if (dels.length) await remove(t, dels);
    }
    await db.prepare('DELETE FROM sync_outbox WHERE seq <= ?').run(batch[batch.length - 1].seq);
    status.pushed += batch.length;
    status.last_push = new Date().toISOString();
    status.pending = (await db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).n;
  } catch (err) {
    fail('push', err);
  } finally {
    flushing = false;
  }
}

/** Full copy (first run / after `npm run seed`): Supabase ends up exactly like the local database. */
export async function fullPush() {
  log('Full sync: uploading the local database to Supabase…');
  for (const [t, pk, twoWay] of SYNC_TABLES) {
    const local = await db.prepare(`SELECT * FROM ${t}`).all();
    const localIds = new Set(local.map(r => r[pk]));
    if (twoWay) {
      // hospital tables: upsert + delete extras (no blanket delete, so realtime never sees a hospital vanish)
      const remote = await selectAll(t);
      const extra = remote.map(r => r[pk]).filter(id => !localIds.has(id));
      if (extra.length) await remove(t, extra);
    } else {
      const { error } = await client.from(t).delete().neq(pk, '__none__');
      if (error) throw new Error(`${t} clear: ${error.message}`);
    }
    await upsert(t, local);
    log(`  ${t}: ${local.length} rows`);
  }
  await client.from('ambulance_positions').delete().neq('request_id', '__none__');
  await db.prepare('DELETE FROM sync_outbox').run();
  await db.prepare('UPDATE sync_state SET initialized = 1 WHERE id = 1').run();
  status.initialized = true;
  status.last_push = new Date().toISOString();
  log('Full sync done.');
}

// Live ambulance position → public.ambulance_positions (called by tracking.js; in Postgres mode it is written there directly)
export function pushPosition(fix) {
  if (!client || db.driver === 'postgres') return;
  client.from('ambulance_positions').upsert({
    request_id: fix.request_id, hospital_id: fix.hospital_id, lat: fix.lat, lng: fix.lng, source: fix.source,
    accuracy_m: fix.accuracy_m, left_km: fix.left_km, eta_min: fix.eta_min, updated_at: fix.at,
  }, { onConflict: 'request_id' }).then(({ error }) => { if (error) fail('position', error); });
}

// ───────────── Supabase → App (hospital tables) ─────────────
const DEFAULT_RESOURCES = (hid) => ({ resource_record_id: `RR-${hid.replace(/^HSP-/, '')}`, hospital_id: hid,
  total_icu_beds: 0, available_icu_beds: 0, total_ventilators: 0, available_ventilators: 0, total_oxygen_beds: 0, available_oxygen_beds: 0,
  total_general_beds: 0, available_general_beds: 0, last_updated_timestamp: new Date().toISOString(), update_source: 'Admin', version: 1 });
const DEFAULT_SERVICES = (hid) => ({ service_record_id: `SRV-${hid.replace(/^HSP-/, '')}`, hospital_id: hid,
  trauma_care: 0, cardiology: 0, neurology: 0, blood_bank: 0, operation_theatre: 0, dialysis: 0, burn_unit: 0, specialists: 'None' });

async function upsertLocal(t, row) {
  const cols = Object.keys(row);
  const pk = TABLE[t].pk;
  await db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})
              ON CONFLICT(${pk}) DO UPDATE SET ${cols.filter(c => c !== pk).map(c => `${c} = excluded.${c}`).join(', ')}`).run(row);
}
const requeue = async (t, pk) => await db.prepare("INSERT INTO sync_outbox (tbl, pk, op) VALUES (?, ?, 'upsert')").run(t, pk);
const same = (a, b, cols) => a && cols.every(c => (a[c] ?? null) === (b[c] ?? null) || String(a[c]) === String(b[c]));

/** Apply one change that happened in Supabase. Returns what was done (for logs/tests). */
export async function applyRemote(t, type, rowNew, rowOld) {
  const cfg = TABLE[t];
  if (!cfg?.twoWay) return 'ignored';
  const cols = await columns(t);
  const pkVal = (rowNew && rowNew[cfg.pk]) || (rowOld && rowOld[cfg.pk]);
  if (!pkVal) return 'ignored';
  const local = await db.prepare(`SELECT * FROM ${t} WHERE ${cfg.pk} = ?`).get(pkVal);
  let hid = local?.hospital_id || rowNew?.hospital_id || (t === 'hospitals' ? pkVal : null);

  try {
    if (type === 'DELETE') {
      if (!local) return 'noop';
      if (t !== 'hospitals') { await requeue(t, pkVal); return 'restored'; }          // beds/departments rows are required: put it back
      try {
        await db.transaction(async () => {
          await db.prepare('DELETE FROM hospital_services WHERE hospital_id = ?').run(pkVal);
          await db.prepare('DELETE FROM hospital_resources WHERE hospital_id = ?').run(pkVal);
          await db.prepare('DELETE FROM hospitals WHERE hospital_id = ?').run(pkVal);
        })();
        log(`Hospital ${pkVal} deleted (from Supabase)`);
        return 'deleted';
      } catch {
        // it has emergency history, so keep it but switch it off
        await db.prepare('UPDATE hospitals SET active_status = 0 WHERE hospital_id = ?').run(pkVal);   // trigger re-sends the row to Supabase
        await requeue('hospitals', pkVal);
        log(`Hospital ${pkVal} has emergency history → deactivated instead of deleted`);
        bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital: await getHospital(pkVal), changed: [{ active_status: 0 }], source: 'Supabase' });
        return 'deactivated';
      }
    }

    // INSERT / UPDATE
    const row = Object.fromEntries(cols.filter(c => c in rowNew).map(c => [c, rowNew[c]]));
    if (same(local, row, Object.keys(row))) return 'noop';                        // our own change coming back
    if (t === 'hospital_resources') {
      row.version = (local?.version || 0) + 1;                                    // invalidate open edit screens
      if (!local || ['total_icu_beds', 'available_icu_beds', 'total_ventilators', 'available_ventilators', 'total_oxygen_beds',
        'available_oxygen_beds', 'total_general_beds', 'available_general_beds'].some(c => local[c] !== row[c])) {
        row.update_source = 'Admin'; row.last_updated_timestamp = new Date().toISOString();
      }
    }
    if (t !== 'hospitals' && !await db.prepare('SELECT 1 FROM hospitals WHERE hospital_id = ?').get(row.hospital_id)) {
      throw new Error(`hospital ${row.hospital_id} does not exist; create it in "hospitals" first`);
    }
    await db.transaction(async () => {
      await upsertLocal(t, { ...(local || {}), ...row });
      if (t === 'hospitals' && !local) {                                          // brand-new hospital: give it empty beds/departments to fill in
        if (!await db.prepare('SELECT 1 FROM hospital_resources WHERE hospital_id = ?').get(pkVal)) await upsertLocal('hospital_resources', DEFAULT_RESOURCES(pkVal));
        if (!await db.prepare('SELECT 1 FROM hospital_services WHERE hospital_id = ?').get(pkVal)) await upsertLocal('hospital_services', DEFAULT_SERVICES(pkVal));
      }
    })();
    hid = hid || row.hospital_id;
    status.pulled++;
    log(`${type} ${t} ${pkVal} applied from Supabase`);
    const hospital = hid && await getHospital(hid);
    if (hospital) bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital, changed: [{ table: t }], source: 'Supabase' });
    return local ? 'updated' : 'inserted';
  } catch (err) {
    // invalid edit (e.g. available > total): put Supabase back to the app's valid values
    fail(`apply ${t} ${pkVal}`, err);
    if (local) await requeue(t, pkVal);
    else if (type !== 'DELETE') client?.from(t).delete().eq(cfg.pk, pkVal).then(() => {});
    return 'rejected';
  }
}

async function pullHospitals() {
  for (const [t, pk, twoWay] of SYNC_TABLES) {
    if (!twoWay) continue;
    const remote = await selectAll(t);
    for (const r of remote) await applyRemote(t, 'UPDATE', r, null);
    // hospitals that exist locally but not in Supabase get pushed
    const ids = new Set(remote.map(r => r[pk]));
    for (const { id } of await db.prepare(`SELECT ${pk} AS id FROM ${t}`).all()) if (!ids.has(id)) await requeue(t, id);
  }
}

let applying = Promise.resolve();
export const settle = () => applying;          // tests: wait until queued Supabase changes are applied
async function subscribe() {
  subscribed = true;
  let ch = client.channel('jeevanroute-hospital-db');
  for (const [t, , twoWay] of SYNC_TABLES) {
    if (!twoWay) continue;
    // one change at a time, in the order Supabase sent them
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t },
      (p) => { applying = applying.then(() => applyRemote(t, p.eventType, p.new, p.old)).catch(e => fail('apply', e)); });
  }
  ch.subscribe((s, err) => {
    status.realtime = s;
    if (s === 'SUBSCRIBED') log('Realtime connected: edits in Supabase flow into the app live.');
    if (err) fail('realtime', err);
  });
}

// ───────────── Postgres mode: Supabase IS the database ─────────────
// Nothing to copy. We only listen for edits made in the Supabase dashboard so every screen
// refreshes, and give a brand-new hospital its empty beds / departments rows to fill in.
async function watchOnly(url, key, opts) {
  status.mode = 'postgres';
  if (!opts.client && !(url && key)) { status.realtime = 'off (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to see dashboard edits live)'; return status; }
  client = opts.client || await makeClient(url, key);
  let ch = client.channel('jeevanroute-hospital-watch');
  for (const [t, , twoWay] of SYNC_TABLES) {
    if (!twoWay) continue;
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => {
      applying = applying.then(async () => {
        const hid = p.new?.hospital_id || p.old?.hospital_id;
        if (!hid) return;
        if (t === 'hospitals' && p.eventType === 'INSERT') {
          const r = DEFAULT_RESOURCES(hid), sv = DEFAULT_SERVICES(hid);
          await db.prepare(`INSERT INTO hospital_resources (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')}) ON CONFLICT (hospital_id) DO NOTHING`).run(...Object.values(r));
          await db.prepare(`INSERT INTO hospital_services (${Object.keys(sv).join(',')}) VALUES (${Object.keys(sv).map(() => '?').join(',')}) ON CONFLICT (hospital_id) DO NOTHING`).run(...Object.values(sv));
        }
        status.pulled++;
        const hospital = await getHospital(hid);
        // _local: every server gets this realtime event itself, so each tells only its own screens
        if (hospital) bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital, changed: [{ table: t }], source: 'Supabase', _local: true });
      }).catch(e => fail('watch', e));
    });
  }
  ch.subscribe((s, err) => { status.realtime = s; if (s === 'SUBSCRIBED') log('Realtime connected: dashboard edits refresh every screen.'); if (err) fail('realtime', err); });
  status.enabled = true;
  return status;
}

async function makeClient(url, key) {
  const { createClient } = await import('@supabase/supabase-js');
  const realtime = typeof globalThis.WebSocket === 'undefined' ? { transport: (await import('ws')).default } : {};
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime });
}

/** Start syncing. `opts.client` lets tests pass a fake Supabase client. */
export async function startSync(opts = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (db.driver === 'postgres') return watchOnly(url, key, opts);
  if (!opts.client && !(url && key)) { await setEnabled(false); return status; }
  wantRealtime = !opts.noRealtime;
  try {
    client = opts.client || await makeClient(url, key);
    await setEnabled(true);
    status.enabled = true;
    const st = await db.prepare('SELECT initialized FROM sync_state WHERE id = 1').get();
    if (!st.initialized) await fullPush();
    else { status.initialized = true; await pullHospitals(); }
    await flush();
    if (!opts.noRealtime) await subscribe();
    if (!opts.noTimer) { timer = setInterval(flush, 1000); timer.unref?.(); }
    log(`Sync on → ${url || 'test client'}`);
  } catch (err) {
    fail('start', err);
    log('Sync could not start; the app keeps working locally and will queue changes. Check SUPABASE_URL / key and that supabase/schema.sql was run.');
    if (!timer && !opts.noTimer) { timer = setInterval(flush, 5000); timer.unref?.(); }
  }
  return status;
}

export const syncStatus = async () => ({ ...status, pending: status.enabled && db.driver === 'sqlite' ? (await db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).n : 0 });
export function stopSync() { clearInterval(timer); timer = null; }
