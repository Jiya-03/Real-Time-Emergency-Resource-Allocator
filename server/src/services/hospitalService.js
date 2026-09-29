// All hospital reads/writes live here so routes stay thin and logic is reusable (ranking, simulator…)
import db from '../db/index.js';
import { RESOURCES, RESOURCE_KEYS, SERVICES, UPDATE_SOURCES } from './resources.js';
import { getFreshness } from './freshness.js';
import { nextId } from '../utils/ids.js';
import bus, { EVENTS } from '../events.js';
import { ApiError } from '../utils/errors.js';
import { SPECIALISTS } from './requestConfig.js';

const BASE_QUERY = `
  SELECT h.*, r.*, s.*
  FROM hospitals h
  JOIN hospital_resources r ON r.hospital_id = h.hospital_id
  JOIN hospital_services  s ON s.hospital_id = h.hospital_id`;

// Turns one flat DB row into the clean JSON shape the UI uses
export function formatHospital(row, now = Date.now()) {
  const resources = {};
  for (const key of RESOURCE_KEYS) {
    const { label, total, available } = RESOURCES[key];
    const t = row[total], a = row[available];
    resources[key] = {
      label, total: t, available: a,
      occupancy_pct: t ? Math.round(((t - a) / t) * 100) : null,
    };
  }
  const services = {};
  for (const s of SERVICES) services[s] = !!row[s];

  return {
    hospital_id: row.hospital_id,
    name: row.hospital_name,
    type: row.hospital_type,
    location: { lat: row.latitude, lng: row.longitude },
    address: row.address,
    emergency_department: !!row.emergency_department,
    active: !!row.active_status,
    accepting_patients: !!row.emergency_department && !!row.active_status,
    resources,
    services,
    specialists: row.specialists && row.specialists !== 'None' ? row.specialists.split(';') : [],
    freshness: getFreshness(row.last_updated_timestamp, now),
    update_source: row.update_source,
    version: row.version,
  };
}

export async function listHospitals({ freshness, has, service, accepting } = {}) {
  const now = Date.now();
  let list = (await db.prepare(`${BASE_QUERY} ORDER BY h.hospital_id`).all()).map(r => formatHospital(r, now));

  if (freshness) list = list.filter(h => h.freshness.status === freshness);
  if (has)       list = list.filter(h => h.resources[has]?.available > 0);
  if (service)   list = list.filter(h => h.services[service]);
  if (accepting !== undefined) list = list.filter(h => h.accepting_patients === accepting);
  return list;
}

// All hospitals, formatted, with freshness measured at `now` (used by the ranking engine)
export async function getAllHospitals(now = Date.now()) {
  return (await db.prepare(`${BASE_QUERY} ORDER BY h.hospital_id`).all()).map(r => formatHospital(r, now));
}

export async function getHospital(id) {
  const row = await db.prepare(`${BASE_QUERY} WHERE h.hospital_id = ?`).get(id);
  return row ? formatHospital(row) : null;
}

// Network-wide numbers for the dashboard header
export async function getSummary() {
  const list = await listHospitals();
  const summary = {
    hospitals: list.length,
    accepting_patients: list.filter(h => h.accepting_patients).length,
    freshness: { fresh: 0, aging: 0, stale: 0 },
    resources: {},
  };
  for (const key of RESOURCE_KEYS) summary.resources[key] = { label: RESOURCES[key].label, total: 0, available: 0 };
  for (const h of list) {
    summary.freshness[h.freshness.status]++;
    for (const key of RESOURCE_KEYS) {
      summary.resources[key].total += h.resources[key].total;
      summary.resources[key].available += h.resources[key].available;
    }
  }
  return summary;
}

export async function getHistory(id, { type, limit = 20 } = {}) {
  const params = [id];
  let where = 'hospital_id = ?';
  if (type) { where += ' AND resource_type = ?'; params.push(RESOURCES[type].label); }
  params.push(Math.min(Number(limit) || 20, 200));
  return await db.prepare(
    `SELECT * FROM resource_update_history WHERE ${where} ORDER BY updated_at DESC, update_id DESC LIMIT ?`
  ).all(...params);
}

// ApiError lives in utils/errors.js (shared by all services); re-exported for existing imports
export { ApiError };

/**
 * Hospital staff update availability.
 *   changes: { icu: 5, ventilator: 2 }  → new AVAILABLE counts
 *   expectedVersion (optional): if another update landed first, reject with 409
 * Also used with empty changes to simply re-confirm (refresh) stale data.
 */
const updateResources = db.transaction(async (id, changes = {}, { expectedVersion, source = 'Hospital Staff' } = {}) => {
  const row = await db.prepare('SELECT * FROM hospital_resources WHERE hospital_id = ?').get(id);
  if (!row) throw new ApiError(404, `Hospital ${id} not found`);
  if (!UPDATE_SOURCES.includes(source)) throw new ApiError(400, `source must be one of: ${UPDATE_SOURCES.join(', ')}`);

  // Validate every requested change before touching anything
  const sets = [];
  const params = {};
  const logs = [];
  for (const [key, value] of Object.entries(changes)) {
    const res = RESOURCES[key];
    if (!res) throw new ApiError(400, `Unknown resource "${key}". Use: ${RESOURCE_KEYS.join(', ')}`);
    if (!Number.isInteger(value) || value < 0 || value > row[res.total]) {
      throw new ApiError(400, `${key} must be a whole number between 0 and ${row[res.total]}`);
    }
    if (value !== row[res.available]) {
      sets.push(`${res.available} = @${key}`);
      params[key] = value;
      logs.push({ label: res.label, old: row[res.available], new: value });
    }
  }

  const nowISO = new Date().toISOString();
  // Optimistic lock: only succeeds if nobody changed this row since the client read it
  const result = await db.prepare(`
    UPDATE hospital_resources
    SET ${[...sets, 'last_updated_timestamp = @now', 'update_source = @source', 'version = version + 1'].join(', ')}
    WHERE hospital_id = @id ${expectedVersion !== undefined ? 'AND version = @expectedVersion' : ''}
  `).run({ ...params, now: nowISO, source, id, expectedVersion });

  if (result.changes === 0) {
    throw new ApiError(409, 'Availability was changed by someone else. Reload and try again.', {
      current: await getHospital(id),
    });
  }

  const insertLog = db.prepare(`
    INSERT INTO resource_update_history
      (update_id, hospital_id, resource_type, old_available_count, new_available_count, updated_at, update_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const l of logs) {
    await insertLog.run(await nextId(db, 'resource_update_history', 'update_id', 'UPD', 6), id, l.label, l.old, l.new, nowISO, source);
  }

  return { hospital: await getHospital(id), changed: logs, source };
});

// Public version: runs the DB transaction, then tells everyone (sockets) what changed
export async function updateHospitalResources(id, changes, opts) {
  const result = await updateResources(id, changes, opts);
  bus.emit(EVENTS.HOSPITAL_UPDATE, result);
  return result;
}

/** Hospital staff: mark departments available / unavailable and set specialists on call. Changes ranking eligibility at once. */
export async function updateHospitalServices(id, { services = {}, specialists } = {}) {
  const row = await db.prepare('SELECT * FROM hospital_services WHERE hospital_id = ?').get(id);
  if (!row) throw new ApiError(404, `Hospital ${id} not found`);
  const sets = [], params = { id }, changed = [];
  for (const [k, v] of Object.entries(services)) {
    if (!SERVICES.includes(k)) throw new ApiError(400, `Unknown department "${k}". Use: ${SERVICES.join(', ')}`);
    if (typeof v !== 'boolean') throw new ApiError(400, `${k} must be true or false`);
    if ((row[k] ? true : false) !== v) { sets.push(`${k} = @${k}`); params[k] = v ? 1 : 0; changed.push({ service: k, available: v }); }
  }
  if (specialists !== undefined) {
    if (!Array.isArray(specialists) || specialists.some(x => !SPECIALISTS.includes(x))) throw new ApiError(400, `specialists must be a list from: ${SPECIALISTS.join(', ')}`);
    const val = specialists.length ? [...new Set(specialists)].join(';') : 'None';
    if (val !== row.specialists) { sets.push('specialists = @specialists'); params.specialists = val; changed.push({ specialists: val }); }
  }
  if (sets.length) {
    await db.transaction(async () => {
      await db.prepare(`UPDATE hospital_services SET ${sets.join(', ')} WHERE hospital_id = @id`).run(params);
      await db.prepare(`UPDATE hospital_resources SET last_updated_timestamp = ?, update_source = 'Hospital Staff', version = version + 1 WHERE hospital_id = ?`)
        .run(new Date().toISOString(), id);
    })();
  }
  const hospital = await getHospital(id);
  if (sets.length) bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital, changed, source: 'Hospital Staff' });
  return { hospital, changed };
}
