// Admission at handover: where the patient goes (ward / block / floor / room / bed, attending doctor, nurse)
// and which tracked resources they use. Changing the resources updates the hospital's live inventory
// straight away (same conditional-UPDATE protection as bed holds), so every screen sees it in real time.
//
// Ownership: when the admission is first saved, the beds already held by the confirmed reservation
// are handed over to the admission (reservations.holds_capacity → 0), so they are never returned twice.
import db from '../db/index.js';
import { RESOURCES, RESOURCE_KEYS, SERVICES } from './resources.js';
import { getRequest } from './requestService.js';
import { getHospital } from './hospitalService.js';
import { acceptedWorkflow } from './handoffService.js';
import { nextId } from '../utils/ids.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';

// Hospital layout used for suggestions (same for every hospital in the prototype)
export const WARDS = {
  'ICU':                     { block: 'B', floor: '2nd floor',    rooms: ['201', '202', '203', '204', '205', '206'], beds: ['1', '2'] },
  'Trauma Resus Bay':        { block: 'A', floor: 'Ground floor', rooms: ['R1', 'R2', 'R3', 'R4'],                   beds: ['1'] },
  'Cardiac Care Unit (CCU)': { block: 'B', floor: '3rd floor',    rooms: ['301', '302', '303', '304'],               beds: ['1', '2'] },
  'Stroke Unit':             { block: 'C', floor: '3rd floor',    rooms: ['311', '312', '313'],                      beds: ['1', '2'] },
  'Respiratory Ward (O₂)':   { block: 'C', floor: '1st floor',    rooms: ['101', '102', '103', '104'],               beds: ['A', 'B', 'C', 'D'] },
  'Burns Unit':              { block: 'D', floor: '1st floor',    rooms: ['121', '122', '123'],                      beds: ['1', '2'] },
  'Emergency Observation':   { block: 'A', floor: 'Ground floor', rooms: ['E1', 'E2', 'E3'],                         beds: ['A', 'B', 'C', 'D', 'E', 'F'] },
  'General Ward':            { block: 'D', floor: '2nd floor',    rooms: ['211', '212', '213', '214', '215'],        beds: ['A', 'B', 'C', 'D', 'E', 'F'] },
};
const MAX_UNITS = 5;
const iso = () => new Date().toISOString();
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function format(row) {
  if (!row) return null;
  return {
    request_id: row.request_id, hospital_id: row.hospital_id,
    ward: row.ward, block: row.block, floor: row.floor, room: row.room, bed: row.bed,
    attending: row.attending, nurse: row.nurse,
    resources: parse(row.resources, {}), services: parse(row.services, []),
    created_at: row.created_at, updated_at: row.updated_at, admitted_at: row.admitted_at,
    location: row.ward && row.room && row.bed ? `${row.ward} · Block ${row.block} · ${row.floor} · Room ${row.room} · Bed ${row.bed}` : null,
  };
}
export const getAdmission = (requestId) => format(db.prepare('SELECT * FROM admissions WHERE request_id = ?').get(requestId));

// Units the confirmed reservation is holding for this patient (the starting point of the admission)
function heldByReservation(requestId, hospitalId) {
  const held = {};
  const key = Object.fromEntries(RESOURCE_KEYS.map(k => [RESOURCES[k].label, k]));
  for (const r of db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'CONFIRMED' AND holds_capacity = 1`).all(requestId, hospitalId)) {
    held[key[r.resource_type]] = (held[key[r.resource_type]] || 0) + r.quantity;
  }
  return held;
}

function primaryWard(req) {
  if (req.emergency_type === 'Burn') return 'Burns Unit';
  if (req.requirements.icu) return req.requirements.cardiology ? 'Cardiac Care Unit (CCU)' : req.requirements.neurology ? 'Stroke Unit' : 'ICU';
  if (req.requirements.oxygen) return 'Respiratory Ward (O₂)';
  if (req.requirements.trauma_care) return 'Trauma Resus Bay';
  return req.severity === 'Low' ? 'Emergency Observation' : 'General Ward';
}

// First free room + bed in a ward (not used by another active admission at this hospital)
function suggestSpot(hospitalId, ward, exceptRequest) {
  const w = WARDS[ward]; if (!w) return null;
  const taken = new Set(db.prepare(`SELECT a.room, a.bed FROM admissions a JOIN emergency_requests e ON e.request_id = a.request_id
      WHERE a.hospital_id = ? AND a.ward = ? AND a.request_id != ? AND a.room IS NOT NULL`).all(hospitalId, ward, exceptRequest || '')
    .map(x => `${x.room}|${x.bed}`));
  for (const room of w.rooms) for (const bed of w.beds) if (!taken.has(`${room}|${bed}`)) return { ward, block: w.block, floor: w.floor, room, bed };
  return { ward, block: w.block, floor: w.floor, room: w.rooms[0], bed: w.beds[0] };
}

function assertHospital(requestId, user) {
  const req = getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  const wf = acceptedWorkflow(requestId);
  if (!wf) throw new ApiError(409, 'No hospital has accepted this emergency yet', { code: 'NOT_ASSIGNED' });
  if (user?.role !== 'hospital' || user.hospital_id !== wf.hospital_id) throw new ApiError(403, 'Only the receiving hospital can manage this admission');
  return { req, wf };
}

/** GET: the saved admission, or a ready-made draft (suggested ward/room/bed + what the reservation holds). */
export function admissionView(requestId, user, { ward } = {}) {
  const { req, wf } = assertHospital(requestId, user);
  const saved = getAdmission(requestId);
  const suggestedWard = ward && WARDS[ward] ? ward : saved?.ward || primaryWard(req);
  const draft = saved || {
    request_id: requestId, hospital_id: wf.hospital_id, ...suggestSpot(wf.hospital_id, suggestedWard, requestId),
    attending: req.required_specialist ? `${req.required_specialist} on call` : null, nurse: null,
    resources: heldByReservation(requestId, wf.hospital_id),
    services: SERVICES.filter(s => req.requirements[s]),
    admitted_at: null, draft: true,
  };
  return { admission: draft, suggestion: suggestSpot(wf.hospital_id, suggestedWard, requestId), wards: WARDS, hospital: getHospital(wf.hospital_id) };
}

// Atomic inventory change for one resource: take (+) only if enough are free, give back (−) up to the total
function adjust(hospitalId, key, delta) {
  const { label, total, available } = RESOURCES[key];
  const row = db.prepare(`SELECT ${available} AS a, ${total} AS t FROM hospital_resources WHERE hospital_id = ?`).get(hospitalId);
  if (delta > 0) {
    const r = db.prepare(`UPDATE hospital_resources SET ${available} = ${available} - @d, version = version + 1, last_updated_timestamp = @now
                          WHERE hospital_id = @id AND ${available} >= @d`).run({ d: delta, id: hospitalId, now: iso() });
    if (!r.changes) throw new ApiError(409, `No ${label} is free right now (${row.a} available).`, { code: 'NO_CAPACITY', resource: key });
  } else {
    const next = Math.min(row.t, row.a - delta);
    db.prepare(`UPDATE hospital_resources SET ${available} = ?, version = version + 1, last_updated_timestamp = ? WHERE hospital_id = ?`).run(next, iso(), hospitalId);
  }
  db.prepare(`INSERT INTO resource_update_history (update_id, hospital_id, resource_type, old_available_count, new_available_count, updated_at, update_source)
              VALUES (?, ?, ?, ?, ?, ?, 'Handover Allocation')`)
    .run(nextId(db, 'resource_update_history', 'update_id', 'UPD', 6), hospitalId, label, row.a, delta > 0 ? row.a - delta : Math.min(row.t, row.a - delta), iso());
  return { resource: key, label, delta };
}

/** PUT: save ward/room/bed/staff + resources/services. Resource changes hit the live inventory immediately. */
export function saveAdmission(requestId, body = {}, user) {
  const { req, wf } = assertHospital(requestId, user);
  if (!wf.arrival_time) throw new ApiError(409, 'Mark the ambulance as arrived before allocating a bed', { code: 'NOT_ARRIVED' });
  if (wf.handover_status === 'COMPLETED') throw new ApiError(409, 'This patient is already admitted', { code: 'BAD_STATE' });

  const errors = [];
  const text = (v, max = 60) => (v === undefined || v === null || v === '' ? null : String(v).trim().slice(0, max));
  if (body.ward !== undefined && body.ward !== null && !WARDS[body.ward]) errors.push(`ward must be one of: ${Object.keys(WARDS).join(', ')}`);
  let resources = null;
  if (body.resources !== undefined) {
    resources = {};
    for (const [k, v] of Object.entries(body.resources || {})) {
      if (!RESOURCES[k]) { errors.push(`Unknown resource "${k}"`); continue; }
      if (!Number.isInteger(v) || v < 0 || v > MAX_UNITS) { errors.push(`${k} must be 0–${MAX_UNITS}`); continue; }
      if (v) resources[k] = v;
    }
  }
  const services = body.services === undefined ? null : [...new Set((body.services || []).filter(s => SERVICES.includes(s)))];
  if (errors.length) throw new ApiError(400, 'Invalid admission', { details: errors });

  const changes = [];
  db.transaction(() => {
    let row = db.prepare('SELECT * FROM admissions WHERE request_id = ?').get(requestId);
    if (!row) {
      // take over whatever the confirmed reservation is holding
      const held = heldByReservation(requestId, wf.hospital_id);
      db.prepare(`UPDATE reservations SET holds_capacity = 0 WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'CONFIRMED'`).run(requestId, wf.hospital_id);
      db.prepare(`INSERT INTO admissions (request_id, hospital_id, resources, services, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)`)
        .run(requestId, wf.hospital_id, JSON.stringify(held), iso(), iso());
      row = db.prepare('SELECT * FROM admissions WHERE request_id = ?').get(requestId);
    }
    if (resources) {
      const current = parse(row.resources, {});
      for (const k of RESOURCE_KEYS) {
        const delta = (resources[k] || 0) - (current[k] || 0);
        if (delta) changes.push(adjust(wf.hospital_id, k, delta));   // throws 409 NO_CAPACITY → whole save rolls back
      }
    }
    const ward = body.ward !== undefined ? text(body.ward) : row.ward;
    const w = WARDS[ward];
    db.prepare(`UPDATE admissions SET ward = @ward, block = @block, floor = @floor, room = @room, bed = @bed, attending = @attending, nurse = @nurse,
                resources = @resources, services = @services, updated_at = @now WHERE request_id = @id`).run({
      id: requestId, ward,
      block: w ? w.block : row.block, floor: w ? w.floor : row.floor,
      room: body.room !== undefined ? text(body.room, 12) : row.room,
      bed: body.bed !== undefined ? text(body.bed, 8) : row.bed,
      attending: body.attending !== undefined ? text(body.attending) : row.attending,
      nurse: body.nurse !== undefined ? text(body.nurse) : row.nurse,
      resources: resources ? JSON.stringify(resources) : row.resources,
      services: services ? JSON.stringify(services) : row.services,
      now: iso(),
    });
  })();

  const admission = getAdmission(requestId);
  const hospital = getHospital(wf.hospital_id);
  if (changes.length) bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital, changed: changes.map(c => ({ label: c.label, delta: -c.delta })), source: 'Handover Allocation' });
  bus.emit(EVENTS.ADMISSION_UPDATE, { request_id: requestId, hospital_id: wf.hospital_id, admission, request: req });
  return { admission, hospital, changes };
}

/** Called when the handover is completed: stamp the admission time. */
export function markAdmitted(requestId) {
  db.prepare('UPDATE admissions SET admitted_at = ?, updated_at = ? WHERE request_id = ?').run(iso(), iso(), requestId);
}
