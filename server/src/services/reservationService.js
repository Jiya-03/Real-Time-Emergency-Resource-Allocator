// Bed reservations: hold → hospital accepts / rejects → (or) hold expires.
//
// DOUBLE-BOOKING PROTECTION
// Taking a bed is ONE conditional UPDATE inside a transaction:
//     UPDATE hospital_resources SET available_icu_beds = available_icu_beds - 1
//     WHERE hospital_id = ? AND available_icu_beds >= 1
// If two dispatchers race for the last bed, the second UPDATE matches 0 rows, so it
// can never push availability below zero. The loser gets a FAILED reservation + 409 with
// alternatives. SQLite serialises write transactions, so this holds under concurrency.
import db from '../db/index.js';
import { getRequest } from './requestService.js';
import { getHospital } from './hospitalService.js';
import { primaryBed } from './rankingService.js';
import { nextId } from '../utils/ids.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';
import { roadDistanceKm, etaMinutes } from './geo.js';

export const HOLD_MINUTES = Number(process.env.HOLD_MINUTES) || 10;   // hospital must answer within this
export const CONFIRMED_HOLD_MINUTES = 15;                              // bed kept for the arriving ambulance
export const DISPATCH_AMBULANCE = 'AMB-012';                           // Ambulance A-12 (the logged-in crew)

const COLUMN = {                                   // reservation resource label → column
  'ICU': 'available_icu_beds',
  'Ventilator': 'available_ventilators',
  'Oxygen Bed': 'available_oxygen_beds',
  'General Bed': 'available_general_beds',
};
const ACTIVE = ['PENDING', 'CONFIRMED'];
const REJECT_REASONS = ['No Bed', 'No Equipment', 'Specialist Unavailable', 'Stale Data', 'Other'];

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const addMin = (m) => iso(Date.now() + m * 60000);

function logChange(hospitalId, label, oldVal, newVal, source) {
  db.prepare(`INSERT INTO resource_update_history
    (update_id, hospital_id, resource_type, old_available_count, new_available_count, updated_at, update_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(nextId(db, 'resource_update_history', 'update_id', 'UPD', 6), hospitalId, label, oldVal, newVal, iso(), source);
}

// Atomic "take N if N are free". Returns false if someone else got there first.
function takeBeds(hospitalId, label, qty) {
  const col = COLUMN[label];
  const before = db.prepare(`SELECT ${col} AS n FROM hospital_resources WHERE hospital_id = ?`).get(hospitalId).n;
  const res = db.prepare(`UPDATE hospital_resources SET ${col} = ${col} - @qty, version = version + 1
                          WHERE hospital_id = @id AND ${col} >= @qty`).run({ id: hospitalId, qty });
  if (res.changes === 0) return false;
  logChange(hospitalId, label, before, before - qty, 'Reservation Hold');
  return true;
}

// Give beds back (never above the hospital's total). Only for holds with holds_capacity = 1:
// dataset reservations never subtracted anything from the snapshot, so releasing them returns nothing.
function returnBeds(hospitalId, label, qty, source) {
  const col = COLUMN[label];
  const totalCol = col.replace('available_', 'total_');
  const row = db.prepare(`SELECT ${col} AS n, ${totalCol} AS t FROM hospital_resources WHERE hospital_id = ?`).get(hospitalId);
  const next = Math.min(row.t, row.n + qty);
  if (next === row.n) return;
  db.prepare(`UPDATE hospital_resources SET ${col} = ?, version = version + 1 WHERE hospital_id = ?`).run(next, hospitalId);
  logChange(hospitalId, label, row.n, next, source);
}

// What a request needs to hold at one hospital: primary bed × beds_required (+ 1 ventilator)
function holdsFor(req) {
  const holds = [{ label: primaryBed(req).label, qty: req.beds_required }];
  if (req.requirements.ventilator) holds.push({ label: 'Ventilator', qty: 1 });
  return holds;
}

function formatReservation(r) {
  return {
    reservation_id: r.reservation_id,
    request_id: r.request_id,
    hospital_id: r.hospital_id,
    hospital_name: r.hospital_name,
    resource_type: r.resource_type,
    quantity: r.quantity,
    status: r.reservation_status,
    requested_at: r.requested_at,
    confirmed_at: r.confirmed_at,
    expires_at: r.expires_at,
    seconds_left: r.reservation_status === 'PENDING' || r.reservation_status === 'CONFIRMED'
      ? Math.max(0, Math.round((new Date(r.expires_at) - Date.now()) / 1000)) : 0,
  };
}

const reservationsOf = (requestId, hospitalId) => db.prepare(`
  SELECT r.*, h.hospital_name FROM reservations r JOIN hospitals h ON h.hospital_id = r.hospital_id
  WHERE r.request_id = ? ${hospitalId ? 'AND r.hospital_id = ?' : ''} ORDER BY r.requested_at DESC, r.reservation_id DESC`)
  .all(...(hospitalId ? [requestId, hospitalId] : [requestId])).map(formatReservation);

function announce(requestId, hospitalId, action, extra = {}) {
  const payload = {
    action,                                         // held | failed | accepted | rejected | cancelled | expired
    request: getRequest(requestId),
    hospital_id: hospitalId,
    hospital_name: getHospital(hospitalId)?.name,
    reservations: reservationsOf(requestId, hospitalId),
    ...extra,
  };
  bus.emit(EVENTS.RESERVATION_UPDATE, payload);
  bus.emit(EVENTS.REQUEST_UPDATE, payload.request);
  const hospital = getHospital(hospitalId);
  bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital, changed: [], source: 'Reservation' });
  return payload;
}

// Next eligible hospitals from the saved ranking that still have the primary bed free
function alternatives(req, excludeId) {
  const pb = primaryBed(req);
  return db.prepare(`SELECT m.hospital_id, m.rank, m.final_suitability_score AS score, m.estimated_travel_time_min AS eta_min
                     FROM match_ranking_results m WHERE m.request_id = ? AND m.eligibility = 1 AND m.hospital_id != ?
                     ORDER BY m.rank`).all(req.request_id, excludeId)
    .map(a => ({ ...a, hospital: getHospital(a.hospital_id) }))
    .filter(a => a.hospital && a.hospital.resources[pb.key].available >= req.beds_required)
    .slice(0, 3)
    .map(a => ({ hospital_id: a.hospital_id, hospital_name: a.hospital.name, rank: a.rank, score: a.score, eta_min: a.eta_min,
                 free: a.hospital.resources[pb.key].available }));
}

/** Dispatcher: hold beds at a hospital for a request. */
export function reserve({ request_id, hospital_id } = {}) {
  const req = getRequest(request_id);
  if (!req) throw new ApiError(404, `Request ${request_id} not found`);
  if (!getHospital(hospital_id)) throw new ApiError(404, `Hospital ${hospital_id} not found`);
  if (!['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) {
    throw new ApiError(409, `Request is already ${req.status}`, { code: 'NOT_RESERVABLE' });
  }

  const holds = holdsFor(req);
  const outcome = db.transaction(() => {
    const active = db.prepare(`SELECT reservation_id, hospital_id FROM reservations
      WHERE request_id = ? AND reservation_status IN ('PENDING','CONFIRMED')`).get(request_id);
    if (active) return { conflict: 'ALREADY_HELD', active };

    const now = iso();
    const taken = [];
    for (const h of holds) {
      if (!takeBeds(hospital_id, h.label, h.qty)) {
        // Lost the race (or no capacity): undo partial holds, record the FAILED attempt
        for (const t of taken) returnBeds(hospital_id, t.label, t.qty, 'Reservation Rollback');
        db.prepare(`INSERT INTO reservations (reservation_id, request_id, hospital_id, resource_type, quantity,
            reservation_status, requested_at, confirmed_at, expires_at) VALUES (?, ?, ?, ?, ?, 'FAILED', ?, NULL, ?)`)
          .run(nextId(db, 'reservations', 'reservation_id', 'RSV', 6), request_id, hospital_id, h.label, h.qty, now, addMin(HOLD_MINUTES));
        return { conflict: 'BED_TAKEN', label: h.label };
      }
      taken.push(h);
    }

    for (const h of holds) {
      db.prepare(`INSERT INTO reservations (reservation_id, request_id, hospital_id, resource_type, quantity,
          reservation_status, requested_at, confirmed_at, expires_at, holds_capacity) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, 1)`)
        .run(nextId(db, 'reservations', 'reservation_id', 'RSV', 6), request_id, hospital_id, h.label, h.qty, now, addMin(HOLD_MINUTES));
    }
    db.prepare(`INSERT INTO emergency_workflow_handover (workflow_id, request_id, hospital_id, ambulance_id,
        hospital_response, rejection_reason, assignment_time, departure_time, arrival_time, handover_time, handover_status)
        VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, NULL, NULL, NULL, NULL)`)
      .run(nextId(db, 'emergency_workflow_handover', 'workflow_id', 'WF', 6), request_id, hospital_id, DISPATCH_AMBULANCE, now);
    db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING', ambulance_id = ? WHERE request_id = ?`)
      .run(DISPATCH_AMBULANCE, request_id);
    return { ok: true };
  })();

  if (outcome.conflict === 'ALREADY_HELD') {
    throw new ApiError(409, `This emergency already has an active hold at ${getHospital(outcome.active.hospital_id).name}. Cancel it first.`,
      { code: 'ALREADY_HELD', reservation_id: outcome.active.reservation_id });
  }
  if (outcome.conflict === 'BED_TAKEN') {
    const alts = alternatives(req, hospital_id);
    announce(request_id, hospital_id, 'failed');
    throw new ApiError(409, `${outcome.label} at ${getHospital(hospital_id).name} was just taken by another request.`,
      { code: 'BED_TAKEN', alternatives: alts });
  }
  return announce(request_id, hospital_id, 'held', { hold_minutes: HOLD_MINUTES });
}

// Shared by accept / reject / cancel / expire: finds the request's active holds at a hospital
function activeHolds(reservationId) {
  const r = db.prepare('SELECT * FROM reservations WHERE reservation_id = ?').get(reservationId);
  if (!r) throw new ApiError(404, `Reservation ${reservationId} not found`);
  const group = db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ?
    AND reservation_status IN ('PENDING','CONFIRMED')`).all(r.request_id, r.hospital_id);
  return { r, group };
}

function setWorkflow(requestId, hospitalId, fields) {
  const wf = db.prepare(`SELECT workflow_id FROM emergency_workflow_handover WHERE request_id = ? AND hospital_id = ?
    ORDER BY assignment_time DESC LIMIT 1`).get(requestId, hospitalId);
  if (!wf) return;
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE emergency_workflow_handover SET ${sets} WHERE workflow_id = @id`).run({ ...fields, id: wf.workflow_id });
}

/** Hospital staff: accept or reject a pending hold. `byHospital` = logged-in hospital (must match). */
export function respond(reservationId, { action, reason, byHospital } = {}) {
  if (!['accept', 'reject'].includes(action)) throw new ApiError(400, 'action must be accept or reject');
  if (action === 'reject' && !REJECT_REASONS.includes(reason)) {
    throw new ApiError(400, `reason must be one of: ${REJECT_REASONS.join(', ')}`);
  }
  const { r, group } = activeHolds(reservationId);
  if (byHospital && byHospital !== r.hospital_id) throw new ApiError(403, 'This reservation belongs to another hospital');
  const pending = group.filter(g => g.reservation_status === 'PENDING');
  if (!pending.length) {
    throw new ApiError(409, `Reservation is ${r.reservation_status}, not pending`, { code: 'NOT_PENDING', status: r.reservation_status });
  }

  db.transaction(() => {
    const now = iso();
    if (action === 'accept') {
      for (const g of pending) {
        db.prepare(`UPDATE reservations SET reservation_status = 'CONFIRMED', confirmed_at = ?, expires_at = ? WHERE reservation_id = ?`)
          .run(now, addMin(CONFIRMED_HOLD_MINUTES), g.reservation_id);
      }
      setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'ACCEPTED', handover_status: 'PENDING' });
      db.prepare(`UPDATE emergency_requests SET request_status = 'ASSIGNED' WHERE request_id = ?`).run(r.request_id);
    } else {
      for (const g of pending) {
        db.prepare(`UPDATE reservations SET reservation_status = 'RELEASED' WHERE reservation_id = ?`).run(g.reservation_id);
        if (g.holds_capacity) returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Released');
      }
      setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'REJECTED', rejection_reason: reason });
      db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ?`).run(r.request_id);
    }
  })();

  return announce(r.request_id, r.hospital_id, action === 'accept' ? 'accepted' : 'rejected', { reason: reason || null });
}

/** Dispatcher: cancel a hold (pending or confirmed) and give the beds back. */
export function cancel(reservationId) {
  const { r, group } = activeHolds(reservationId);
  if (!group.length) throw new ApiError(409, `Reservation is ${r.reservation_status}; nothing to cancel`, { code: 'NOT_ACTIVE' });
  db.transaction(() => {
    for (const g of group) {
      db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_id = ?`).run(g.reservation_id);
      if (g.holds_capacity) returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Cancelled');
    }
    setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'REJECTED', rejection_reason: 'Other' });
    db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status IN ('MATCHING','ASSIGNED')`)
      .run(r.request_id);
  })();
  return announce(r.request_id, r.hospital_id, 'cancelled');
}

/** Release holds the hospital never answered (runs every few seconds). Returns how many expired. */
export function expireStaleHolds(now = Date.now()) {
  const due = db.prepare(`SELECT * FROM reservations WHERE reservation_status = 'PENDING' AND expires_at < ?`).all(iso(now));
  const groups = new Map();
  for (const d of due) groups.set(`${d.request_id}|${d.hospital_id}`, d);
  for (const d of due) {
    db.transaction(() => {
      const res = db.prepare(`UPDATE reservations SET reservation_status = 'EXPIRED' WHERE reservation_id = ? AND reservation_status = 'PENDING'`)
        .run(d.reservation_id);
      if (res.changes && d.holds_capacity) returnBeds(d.hospital_id, d.resource_type, d.quantity, 'Reservation Expired');
    })();
  }
  for (const d of groups.values()) {
    setWorkflow(d.request_id, d.hospital_id, { hospital_response: 'REJECTED', rejection_reason: 'Other' });
    db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status = 'MATCHING'`).run(d.request_id);
    announce(d.request_id, d.hospital_id, 'expired');
  }
  return groups.size;
}

let sweeper = null;
export function startExpirySweeper(everyMs = 5000) {
  if (!sweeper) sweeper = setInterval(() => { try { expireStaleHolds(); } catch (e) { console.error('[expiry]', e.message); } }, everyMs);
  sweeper.unref?.();
}

/** Hospital inbox: holds waiting for this hospital (+ recently answered, for context). */
export function listForHospital(hospitalId, { status } = {}) {
  if (!getHospital(hospitalId)) throw new ApiError(404, `Hospital ${hospitalId} not found`);
  const statuses = status ? status.split(',') : ['PENDING', 'CONFIRMED'];
  const rows = db.prepare(`
    SELECT r.*, h.hospital_name FROM reservations r
    JOIN hospitals h ON h.hospital_id = r.hospital_id
    JOIN emergency_requests e ON e.request_id = r.request_id
    WHERE r.hospital_id = ? AND r.reservation_status IN (${statuses.map(() => '?').join(',')})
      AND r.requested_at >= ?
      AND (r.reservation_status != 'CONFIRMED' OR e.request_status IN ('ASSIGNED','IN_TRANSIT'))   -- confirmed = patient still on the way
    ORDER BY CASE r.reservation_status WHEN 'PENDING' THEN 0 ELSE 1 END, r.requested_at DESC LIMIT 100`)
    .all(hospitalId, ...statuses, iso(Date.now() - 24 * 3600e3));

  // one entry per request (bed + ventilator holds grouped)
  const byReq = new Map();
  for (const row of rows) {
    const f = formatReservation(row);
    if (!byReq.has(row.request_id)) byReq.set(row.request_id, { request: getRequest(row.request_id), reservations: [] });
    byReq.get(row.request_id).reservations.push(f);
  }
  const hospital = getHospital(hospitalId);
  return [...byReq.values()].map(x => {
    const wf = db.prepare(`SELECT * FROM emergency_workflow_handover WHERE request_id = ? AND hospital_id = ?
                           ORDER BY assignment_time DESC LIMIT 1`).get(x.request.request_id, hospitalId);
    const distance_km = roadDistanceKm(x.request.location.lat, x.request.location.lng, hospital.location.lat, hospital.location.lng);
    const eta_min = etaMinutes(distance_km);
    return {
      ...x,
      status: x.reservations[0].status,
      reservation_id: x.reservations[0].reservation_id,
      seconds_left: Math.min(...x.reservations.map(r => r.seconds_left)),
      distance_km,
      eta_min,
      // en route: ETA counts down from departure
      arrival_eta: wf?.departure_time && !wf.arrival_time ? new Date(new Date(wf.departure_time).getTime() + eta_min * 60000).toISOString() : null,
      workflow: wf ? {
        response: wf.hospital_response, assignment_time: wf.assignment_time, departure_time: wf.departure_time,
        arrival_time: wf.arrival_time, handover_time: wf.handover_time, handover_status: wf.handover_status,
      } : null,
    };
  });
}

/** Hospital history: every emergency this hospital was contacted for in the last N hours. */
export function historyForHospital(hospitalId, { hours = 24 } = {}) {
  if (!getHospital(hospitalId)) throw new ApiError(404, `Hospital ${hospitalId} not found`);
  const rows = db.prepare(`SELECT * FROM emergency_workflow_handover WHERE hospital_id = ? AND assignment_time >= ?
                           ORDER BY assignment_time DESC LIMIT 200`).all(hospitalId, iso(Date.now() - hours * 3600e3));
  return rows.map(w => ({
    workflow_id: w.workflow_id,
    request: getRequest(w.request_id),
    response: w.hospital_response,
    rejection_reason: w.rejection_reason,
    assignment_time: w.assignment_time,
    departure_time: w.departure_time,
    arrival_time: w.arrival_time,
    handover_time: w.handover_time,
    handover_status: w.handover_status,
  }));
}

export { REJECT_REASONS, reservationsOf };
