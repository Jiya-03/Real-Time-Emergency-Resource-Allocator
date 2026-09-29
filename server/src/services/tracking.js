// Live ambulance position (from the crew's device GPS, or the simulated drive on the dispatcher screen).
// The latest fix per emergency is kept in the ambulance_positions table, so every server (and the
// Supabase dashboard in Postgres mode) sees the same position. The hospital's Live Route map listens for it.
// Only the signed-in crew (dispatcher) who logged the emergency may send positions for it.
import db from '../db/index.js';
import { getRequest } from './requestService.js';
import { pushPosition } from './supabaseSync.js';

const MAX_AGE_MS = 10 * 60 * 1000;

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

const MIN_GAP_MS = 1000;              // at most one fix per second per emergency

/** Who may send positions for this emergency? Returns null if allowed, else the reason. */
export async function positionDenied(requestId, user) {
  if (!user) return 'not signed in';
  if (user.role !== 'dispatcher') return 'only the ambulance crew can send positions';
  const owner = (await db.prepare('SELECT dispatcher_id FROM request_owners WHERE request_id = ?').get(requestId))?.dispatcher_id;
  if (!owner) return 'emergency was not logged from this app';
  if (owner !== user.id) return 'this emergency belongs to another crew';
  return null;
}

/**
 * Validate + store a fix sent by `user` (the signed-in socket).
 * Returns { fix } when accepted, or { error } saying why it was ignored.
 */
export async function recordPosition(p = {}, user = null) {
  if (typeof p.request_id !== 'string' || !num(p.lat, -90, 90) || !num(p.lng, -180, 180)) return { error: 'bad position' };
  const denied = await positionDenied(p.request_id, user);
  if (denied) return { error: denied };
  const req = await getRequest(p.request_id);
  if (!req || !['ASSIGNED', 'IN_TRANSIT'].includes(req.status)) return { error: 'no hospital confirmed yet, or the trip is over' };
  const prev = await lastPosition(p.request_id);
  if (prev && Date.now() - new Date(prev.at) < MIN_GAP_MS) return { error: 'too frequent' };
  const fix = {
    request_id: p.request_id,
    lat: p.lat, lng: p.lng,
    source: p.source === 'gps' ? 'gps' : 'simulated',
    accuracy_m: num(p.accuracy_m, 0, 100000) ? Math.round(p.accuracy_m) : null,
    left_km: num(p.left_km, 0, 1000) ? Math.round(p.left_km * 10) / 10 : null,
    eta_min: num(p.eta_min, 0, 1000) ? Math.round(p.eta_min) : null,
    hospital_id: typeof p.hospital_id === 'string' ? p.hospital_id : null,
    at: new Date().toISOString(),
  };
  await db.prepare(`INSERT INTO ambulance_positions (request_id, hospital_id, lat, lng, source, accuracy_m, left_km, eta_min, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (request_id) DO UPDATE SET hospital_id = excluded.hospital_id, lat = excluded.lat, lng = excluded.lng, source = excluded.source,
      accuracy_m = excluded.accuracy_m, left_km = excluded.left_km, eta_min = excluded.eta_min, updated_at = excluded.updated_at`)
    .run(fix.request_id, fix.hospital_id, fix.lat, fix.lng, fix.source, fix.accuracy_m, fix.left_km, fix.eta_min, fix.at);
  pushPosition(fix);                    // live tracking table in Supabase (if connected)
  return { fix };
}

export async function lastPosition(requestId) {
  const r = await db.prepare('SELECT * FROM ambulance_positions WHERE request_id = ?').get(requestId);
  if (!r || Date.now() - new Date(r.updated_at) > MAX_AGE_MS) return null;
  return { request_id: r.request_id, hospital_id: r.hospital_id, lat: r.lat, lng: r.lng, source: r.source, accuracy_m: r.accuracy_m,
           left_km: r.left_km, eta_min: r.eta_min, at: r.updated_at };
}
