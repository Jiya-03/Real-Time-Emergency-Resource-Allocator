// Bed reservations: hold → hospital accepts / rejects → (or) hold expires.
//
// BROADCAST (default dispatch): the emergency is sent to ALL suitable hospitals at once.
// No beds are locked while they decide; the FIRST hospital to accept wins. Its accept claims the
// emergency with a conditional UPDATE (… WHERE request_status = 'MATCHING') and takes the beds with
// the same conditional UPDATE as below, all in one transaction, so two hospitals accepting in the
// same instant can never both win. Everyone else is withdrawn automatically. If every hospital
// declines or times out, the next wave of suitable hospitals is alerted automatically.
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
import { primaryBed, matchRequest } from './rankingService.js';
import { nextId } from '../utils/ids.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';
import { roadDistanceKm, etaMinutes } from './geo.js';

export const HOLD_MINUTES = Number(process.env.HOLD_MINUTES) || 10;   // hospital must answer within this
export const CONFIRMED_HOLD_MINUTES = 15;                              // bed kept for the arriving ambulance
export const DISPATCH_AMBULANCE = 'AMB-012';                           // Ambulance A-12 (the logged-in crew)
export const BROADCAST_MAX = Number(process.env.BROADCAST_MAX) || 0;   // optional cap per wave (0 = every suitable hospital)

const COLUMN = {                                   // reservation resource label → column
  'ICU': 'available_icu_beds',
  'Ventilator': 'available_ventilators',
  'Oxygen Bed': 'available_oxygen_beds',
  'General Bed': 'available_general_beds',
};
const ACTIVE = ['PENDING', 'CONFIRMED'];
const RESOURCE_KEY = { 'ICU': 'icu', 'Ventilator': 'ventilator', 'Oxygen Bed': 'oxygen_bed', 'General Bed': 'general_bed' };
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

const activeCount = (requestId) => db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE request_id = ?
  AND reservation_status IN ('PENDING','CONFIRMED')`).get(requestId).n;

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
    const filled = db.prepare(`SELECT hospital_response FROM emergency_workflow_handover WHERE request_id = ? AND hospital_id = ?
      ORDER BY assignment_time DESC LIMIT 1`).get(r.request_id, r.hospital_id)?.hospital_response === 'WITHDRAWN';
    throw new ApiError(409, filled ? 'Another hospital already accepted this emergency.' : `Reservation is ${r.reservation_status}, not pending`,
      { code: filled ? 'ALREADY_FILLED' : 'NOT_PENDING', status: r.reservation_status });
  }

  if (action === 'reject') {
    db.transaction(() => {
      for (const g of pending) {
        db.prepare(`UPDATE reservations SET reservation_status = 'RELEASED' WHERE reservation_id = ?`).run(g.reservation_id);
        if (g.holds_capacity) returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Released');
      }
      setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'REJECTED', rejection_reason: reason });
      db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status IN ('MATCHING','NO_MATCH','CREATED')`).run(r.request_id);
    })();
    const out = announce(r.request_id, r.hospital_id, 'rejected', { reason, still_waiting: activeCount(r.request_id) });
    maybeEscalate(r.request_id);
    return out;
  }

  // ACCEPT: first hospital wins; beds are taken now (broadcast holds did not lock any)
  let withdrawn = [];
  try {
    withdrawn = db.transaction(() => {
      const claim = db.prepare(`UPDATE emergency_requests SET request_status = 'ASSIGNED'
        WHERE request_id = ? AND request_status IN ('CREATED','MATCHING','NO_MATCH')`).run(r.request_id);
      if (!claim.changes) throw new ApiError(409, 'Another hospital already accepted this emergency.', { code: 'ALREADY_FILLED' });
      const now = iso();
      for (const g of pending) {
        if (!g.holds_capacity && !takeBeds(g.hospital_id, g.resource_type, g.quantity)) {
          throw new ApiError(409, `No ${g.resource_type} is free any more at your hospital (taken since the request arrived).`, { code: 'BED_TAKEN', label: g.resource_type });
        }
        db.prepare(`UPDATE reservations SET reservation_status = 'CONFIRMED', confirmed_at = ?, expires_at = ?, holds_capacity = 1 WHERE reservation_id = ?`)
          .run(now, addMin(CONFIRMED_HOLD_MINUTES), g.reservation_id);
      }
      setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'ACCEPTED', handover_status: 'PENDING' });
      // withdraw the request from every other hospital that was still deciding
      const others = db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id != ? AND reservation_status = 'PENDING'`)
        .all(r.request_id, r.hospital_id);
      for (const o of others) {
        db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_id = ?`).run(o.reservation_id);
        if (o.holds_capacity) returnBeds(o.hospital_id, o.resource_type, o.quantity, 'Filled Elsewhere');
      }
      const ids = [...new Set(others.map(o => o.hospital_id))];
      for (const id of ids) setWorkflow(r.request_id, id, { hospital_response: 'WITHDRAWN' });
      return ids;
    })();
  } catch (err) {
    if (err.details?.code === 'BED_TAKEN') {
      // This hospital can no longer take the patient: record it as a decline so the others (or the next wave) carry on
      db.transaction(() => {
        for (const g of pending) db.prepare(`UPDATE reservations SET reservation_status = 'FAILED' WHERE reservation_id = ?`).run(g.reservation_id);
        setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'REJECTED', rejection_reason: 'No Bed' });
      })();
      announce(r.request_id, r.hospital_id, 'rejected', { reason: 'No Bed', auto: true, still_waiting: activeCount(r.request_id) });
      maybeEscalate(r.request_id);
    }
    throw err;
  }

  const winner = getHospital(r.hospital_id)?.name;
  const out = announce(r.request_id, r.hospital_id, 'accepted', { withdrawn });
  for (const id of withdrawn) announce(r.request_id, id, 'filled', { filled_by: winner, filled_by_id: r.hospital_id });
  return out;
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
    setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'WITHDRAWN' });
    db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status IN ('MATCHING','ASSIGNED')`)
      .run(r.request_id);
  })();
  return announce(r.request_id, r.hospital_id, 'cancelled');
}

/** Dispatcher: withdraw the emergency from every hospital still deciding (broadcast "Cancel all"). */
export function withdrawAll(requestId) {
  const req = getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  const rows = db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND reservation_status = 'PENDING'`).all(requestId);
  if (!rows.length) throw new ApiError(409, 'No hospital is waiting on this emergency', { code: 'NOT_ACTIVE' });
  const ids = [...new Set(rows.map(x => x.hospital_id))];
  db.transaction(() => {
    for (const g of rows) {
      db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_id = ?`).run(g.reservation_id);
      if (g.holds_capacity) returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Cancelled');
    }
    for (const id of ids) setWorkflow(requestId, id, { hospital_response: 'WITHDRAWN' });
  })();
  for (const id of ids) announce(requestId, id, 'cancelled');
  return { request: getRequest(requestId), withdrawn: ids };
}

// ───────────── Broadcast ─────────────
const contactedIds = (requestId) => new Set(db.prepare('SELECT DISTINCT hospital_id FROM emergency_workflow_handover WHERE request_id = ?')
  .all(requestId).map(x => x.hospital_id));

// Eligible hospitals from the (fresh) ranking that were not contacted yet and have the beds free right now
function suitableTargets(req, max) {
  const seen = contactedIds(req.request_id);
  const holds = holdsFor(req);
  return db.prepare(`SELECT hospital_id, rank, final_suitability_score AS score, estimated_travel_time_min AS eta_min, distance_km
                     FROM match_ranking_results WHERE request_id = ? AND eligibility = 1 ORDER BY rank`).all(req.request_id)
    .filter(m => !seen.has(m.hospital_id))
    .map(m => ({ ...m, hospital: getHospital(m.hospital_id) }))
    .filter(m => m.hospital?.accepting_patients && holds.every(h => m.hospital.resources[RESOURCE_KEY[h.label]].available >= h.qty))
    .slice(0, max);
}

/**
 * Dispatcher: alert ALL suitable hospitals at once (one wave). Re-ranks first so availability is current.
 * Hospitals already contacted for this emergency are skipped, so calling it again = "next wave".
 */
export function broadcast(requestId, { max = BROADCAST_MAX, auto = false } = {}) {
  let req = getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  if (!['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) {
    throw new ApiError(409, `Request is already ${req.status}`, { code: 'NOT_RESERVABLE' });
  }
  matchRequest(requestId);
  req = getRequest(requestId);
  const targets = suitableTargets(req, Number(max) > 0 ? Number(max) : Infinity);

  if (!targets.length) {
    const waiting = db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE request_id = ? AND reservation_status = 'PENDING'`).get(requestId).n;
    if (!waiting) db.prepare(`UPDATE emergency_requests SET request_status = 'NO_MATCH' WHERE request_id = ?`).run(requestId);
    const request = getRequest(requestId);
    bus.emit(EVENTS.REQUEST_UPDATE, request);
    bus.emit(EVENTS.RESERVATION_UPDATE, { action: 'exhausted', request, hospital_id: null, reservations: [], auto });
    throw new ApiError(409, waiting ? 'Every other suitable hospital has already been alerted.'
      : 'No suitable hospital with free capacity is left to alert. Adjust the requirements or re-run later.', { code: 'NO_SUITABLE' });
  }

  const holds = holdsFor(req);
  const now = iso(), expires = addMin(HOLD_MINUTES);
  const wave = db.transaction(() => {
    for (const t of targets) {
      for (const h of holds) {
        db.prepare(`INSERT INTO reservations (reservation_id, request_id, hospital_id, resource_type, quantity,
            reservation_status, requested_at, confirmed_at, expires_at, holds_capacity) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, 0)`)
          .run(nextId(db, 'reservations', 'reservation_id', 'RSV', 6), requestId, t.hospital_id, h.label, h.qty, now, expires);
      }
      db.prepare(`INSERT INTO emergency_workflow_handover (workflow_id, request_id, hospital_id, ambulance_id,
          hospital_response, rejection_reason, assignment_time, departure_time, arrival_time, handover_time, handover_status)
          VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, NULL, NULL, NULL, NULL)`)
        .run(nextId(db, 'emergency_workflow_handover', 'workflow_id', 'WF', 6), requestId, t.hospital_id, DISPATCH_AMBULANCE, now);
    }
    db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING', ambulance_id = ?, broadcast_round = broadcast_round + 1 WHERE request_id = ?`)
      .run(DISPATCH_AMBULANCE, requestId);
    return db.prepare('SELECT broadcast_round AS n FROM emergency_requests WHERE request_id = ?').get(requestId).n;
  })();

  for (const t of targets) announce(requestId, t.hospital_id, 'held', { broadcast: true, wave, auto, hold_minutes: HOLD_MINUTES });
  return {
    request: getRequest(requestId),
    wave, auto, hold_minutes: HOLD_MINUTES, expires_at: expires,
    sent_to: targets.map(t => ({ hospital_id: t.hospital_id, hospital_name: t.hospital.name, rank: t.rank, score: t.score,
                                 eta_min: Math.round(t.eta_min), distance_km: t.distance_km })),
  };
}

// After a decline / expiry: if this was a broadcast and nobody is left deciding, alert the next wave
function maybeEscalate(requestId) {
  const row = db.prepare('SELECT broadcast_round, request_status FROM emergency_requests WHERE request_id = ?').get(requestId);
  if (!row?.broadcast_round || !['CREATED', 'MATCHING', 'NO_MATCH'].includes(row.request_status)) return null;
  if (activeCount(requestId)) return null;
  try { return broadcast(requestId, { auto: true }); }
  catch (e) { if (e.details?.code !== 'NO_SUITABLE') console.error('[broadcast]', e.message); return null; }
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
  for (const id of new Set([...groups.values()].map(d => d.request_id))) maybeEscalate(id);
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
