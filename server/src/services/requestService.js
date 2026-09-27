// Emergency requests: what the dispatcher logs when a call comes in
import db from '../db/index.js';
import { nextId } from '../utils/ids.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';
import { roadDistanceKm, etaMinutes } from './geo.js';
import {
  EMERGENCY_TYPES, SEVERITIES, SPECIALISTS, REQUEST_STATUSES, ACTIVE_STATUSES,
  REQUIREMENTS, REQUIREMENT_KEYS, SERVICE_AREA,
} from './requestConfig.js';

// Which hospital is this patient going to? Accepted handover first, else a confirmed bed hold.
function findAssignment(row) {
  const wf = db.prepare(`
    SELECT w.*, h.hospital_name, h.latitude, h.longitude
    FROM emergency_workflow_handover w JOIN hospitals h ON h.hospital_id = w.hospital_id
    WHERE w.request_id = ? AND w.hospital_response = 'ACCEPTED'
    ORDER BY w.assignment_time DESC LIMIT 1`).get(row.request_id);
  const target = wf || db.prepare(`
    SELECT r.hospital_id, h.hospital_name, h.latitude, h.longitude
    FROM reservations r JOIN hospitals h ON h.hospital_id = r.hospital_id
    WHERE r.request_id = ? AND r.reservation_status IN ('CONFIRMED','PENDING') AND r.resource_type != 'Ventilator'
    ORDER BY r.requested_at DESC LIMIT 1`).get(row.request_id);
  if (!target) return null;

  const distance_km = roadDistanceKm(row.patient_latitude, row.patient_longitude, target.latitude, target.longitude);
  const actual = wf?.departure_time && wf?.arrival_time
    ? Math.round((new Date(wf.arrival_time) - new Date(wf.departure_time)) / 60000)
    : null;
  return {
    hospital_id: target.hospital_id,
    hospital_name: target.hospital_name,
    distance_km,
    transit_minutes: actual ?? etaMinutes(distance_km, new Date(row.request_timestamp)),
    transit_source: actual !== null ? 'actual' : 'estimated',
  };
}

// DB row → clean JSON for the UI
export function formatRequest(row) {
  const requirements = {};
  for (const key of REQUIREMENT_KEYS) requirements[key] = !!row[REQUIREMENTS[key]];
  return {
    request_id: row.request_id,
    patient_id: row.patient_id,
    emergency_type: row.emergency_type,
    severity: row.severity,
    patient_age: row.patient_age,
    location: { lat: row.patient_latitude, lng: row.patient_longitude },
    requirements,
    required_specialist: row.required_specialist,
    beds_required: row.beds_required,
    ambulance_id: row.ambulance_id,
    additional_needs: row.additional_needs ? JSON.parse(row.additional_needs) : [],
    status: row.request_status,
    created_at: row.request_timestamp,
    waiting_minutes: Math.round((Date.now() - new Date(row.request_timestamp)) / 6000) / 10,
    assignment: findAssignment(row),
  };
}

function validate(body) {
  const errors = [];
  const {
    emergency_type, severity, patient_age, location, requirements = {},
    required_specialist = null, beds_required = 1, additional_needs = [],
  } = body || {};

  if (!EMERGENCY_TYPES.includes(emergency_type)) errors.push(`emergency_type must be one of: ${EMERGENCY_TYPES.join(', ')}`);
  if (!SEVERITIES.includes(severity)) errors.push(`severity must be one of: ${SEVERITIES.join(', ')}`);
  if (!Number.isInteger(patient_age) || patient_age < 0 || patient_age > 120) errors.push('patient_age must be a whole number 0–120');

  const lat = location?.lat, lng = location?.lng;
  if (typeof lat !== 'number' || lat < -90 || lat > 90 || typeof lng !== 'number' || lng < -180 || lng > 180) {
    errors.push('location must be { "lat": number, "lng": number }');
  }
  if (typeof requirements !== 'object' || Array.isArray(requirements)) {
    errors.push(`requirements must be an object like { "icu": true }`);
  } else {
    for (const [k, v] of Object.entries(requirements)) {
      if (!REQUIREMENT_KEYS.includes(k)) errors.push(`unknown requirement "${k}". Use: ${REQUIREMENT_KEYS.join(', ')}`);
      else if (typeof v !== 'boolean') errors.push(`requirements.${k} must be true or false`);
    }
  }
  if (required_specialist !== null && !SPECIALISTS.includes(required_specialist)) {
    errors.push(`required_specialist must be null or one of: ${SPECIALISTS.join(', ')}`);
  }
  if (!Number.isInteger(beds_required) || beds_required < 1 || beds_required > 10) errors.push('beds_required must be 1–10');
  if (!Array.isArray(additional_needs) || additional_needs.length > 20 ||
      additional_needs.some(x => typeof x !== 'string' || !x.trim() || x.length > 60)) {
    errors.push('additional_needs must be a list of up to 20 short text items');
  }

  if (errors.length) throw new ApiError(400, 'Invalid emergency request', { details: errors });
  return {
    emergency_type, severity, patient_age, lat, lng, requirements, required_specialist, beds_required,
    additional_needs: [...new Set(additional_needs.map(x => x.trim()))],
  };
}

const insertRequest = db.transaction((data) => {
  const request_id = nextId(db, 'emergency_requests', 'request_id', 'REQ', 6);
  const row = {
    request_id,
    patient_id: `PT-${String(Math.floor(100000 + Math.random() * 900000))}`,
    emergency_type: data.emergency_type,
    severity: data.severity,
    patient_age: data.patient_age,
    patient_latitude: data.lat,
    patient_longitude: data.lng,
    required_specialist: data.required_specialist,
    beds_required: data.beds_required,
    ambulance_id: null,                      // set when an ambulance is dispatched (later step)
    request_timestamp: new Date().toISOString(),
    request_status: 'CREATED',
    additional_needs: data.additional_needs.length ? JSON.stringify(data.additional_needs) : null,
  };
  for (const key of REQUIREMENT_KEYS) row[REQUIREMENTS[key]] = data.requirements[key] ? 1 : 0;

  const cols = Object.keys(row);
  db.prepare(`INSERT INTO emergency_requests (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(row);
  return request_id;
});

export function createRequest(body) {
  const data = validate(body);
  const id = insertRequest(data);
  const request = getRequest(id);

  const { minLat, maxLat, minLng, maxLng } = SERVICE_AREA;
  const warnings = [];
  if (data.lat < minLat || data.lat > maxLat || data.lng < minLng || data.lng > maxLng) {
    warnings.push('Location is outside the Pune service area. Double-check the coordinates.');
  }
  if (!REQUIREMENT_KEYS.some(k => data.requirements[k])) {
    warnings.push('No special requirements selected: a general bed will be requested.');
  }

  bus.emit(EVENTS.REQUEST_NEW, request);
  return { request, warnings };
}

export function getRequest(id) {
  const row = db.prepare('SELECT * FROM emergency_requests WHERE request_id = ?').get(id);
  return row ? formatRequest(row) : null;
}

// Full picture for the request detail screen: request + reservations + handover timeline
export function getRequestDetail(id) {
  const request = getRequest(id);
  if (!request) return null;
  const reservations = db.prepare(`
    SELECT r.*, h.hospital_name FROM reservations r JOIN hospitals h ON h.hospital_id = r.hospital_id
    WHERE r.request_id = ? ORDER BY r.requested_at`).all(id);
  const workflow = db.prepare(`
    SELECT w.*, h.hospital_name FROM emergency_workflow_handover w JOIN hospitals h ON h.hospital_id = w.hospital_id
    WHERE w.request_id = ? ORDER BY w.assignment_time`).all(id);
  return { ...request, reservations, workflow };
}

export function listRequests({ status, severity, emergency_type, active, since_minutes, sort = 'priority', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];

  const statuses = active ? ACTIVE_STATUSES : status ? status.split(',') : null;
  if (statuses) {
    for (const s of statuses) if (!REQUEST_STATUSES.includes(s)) throw new ApiError(400, `status must be from: ${REQUEST_STATUSES.join(', ')}`);
    where.push(`request_status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (severity) {
    if (!SEVERITIES.includes(severity)) throw new ApiError(400, `severity must be one of: ${SEVERITIES.join(', ')}`);
    where.push('severity = ?'); params.push(severity);
  }
  if (emergency_type) {
    if (!EMERGENCY_TYPES.includes(emergency_type)) throw new ApiError(400, `emergency_type must be one of: ${EMERGENCY_TYPES.join(', ')}`);
    where.push('emergency_type = ?'); params.push(emergency_type);
  }

  if (since_minutes !== undefined) {
    const mins = Number(since_minutes);
    if (!(mins > 0)) throw new ApiError(400, 'since_minutes must be a positive number');
    where.push('request_timestamp >= ?'); params.push(new Date(Date.now() - mins * 60000).toISOString());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM emergency_requests ${whereSql}`).get(...params).n;
  if (!['priority', 'recent'].includes(sort)) throw new ApiError(400, 'sort must be priority or recent');
  // priority: Critical first, then newest (the dispatcher queue). recent: newest first (the log).
  const orderSql = sort === 'recent'
    ? 'request_timestamp DESC, request_id DESC'
    : `CASE severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Moderate' THEN 2 ELSE 3 END, request_timestamp DESC`;
  const rows = db.prepare(`
    SELECT * FROM emergency_requests ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?`).all(...params, lim, off);

  return { total, limit: lim, offset: off, requests: rows.map(formatRequest) };
}

export function getRequestSummary() {
  const byStatus = Object.fromEntries(REQUEST_STATUSES.map(s => [s, 0]));
  for (const r of db.prepare('SELECT request_status s, COUNT(*) n FROM emergency_requests GROUP BY 1').all()) byStatus[r.s] = r.n;
  const activeBySeverity = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (const r of db.prepare(`SELECT severity s, COUNT(*) n FROM emergency_requests
      WHERE request_status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) GROUP BY 1`).all(...ACTIVE_STATUSES)) {
    activeBySeverity[r.s] = r.n;
  }
  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    active: ACTIVE_STATUSES.reduce((a, s) => a + byStatus[s], 0),
    by_status: byStatus,
    active_by_severity: activeBySeverity,
  };
}
