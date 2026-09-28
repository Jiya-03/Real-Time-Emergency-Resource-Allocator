// Live ambulance position (from the crew's device GPS, or the simulated drive on the dispatcher screen).
// Kept in memory only: it is a stream, not a record. The hospital's Live Route map listens for it.
import { getRequest } from './requestService.js';
import { pushPosition } from './supabaseSync.js';

const positions = new Map();          // request_id → last fix
const MAX_AGE_MS = 10 * 60 * 1000;

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Validate + store a fix. Returns the cleaned fix, or null if it is not usable. */
export function recordPosition(p = {}) {
  if (typeof p.request_id !== 'string' || !num(p.lat, -90, 90) || !num(p.lng, -180, 180)) return null;
  const req = getRequest(p.request_id);
  if (!req || !['ASSIGNED', 'IN_TRANSIT'].includes(req.status)) return null;
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
  positions.set(fix.request_id, fix);
  pushPosition(fix);                    // live tracking table in Supabase (if connected)
  return fix;
}

export function lastPosition(requestId) {
  const fix = positions.get(requestId);
  if (!fix) return null;
  if (Date.now() - new Date(fix.at) > MAX_AGE_MS) { positions.delete(requestId); return null; }
  return fix;
}
