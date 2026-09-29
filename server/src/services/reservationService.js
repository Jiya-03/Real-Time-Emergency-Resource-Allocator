// Bed reservations: hold → hospital accepts / rejects → (or) hold expires.
//
// RANKED CASCADE (default dispatch): the emergency goes out in small waves, best hospitals first.
//   • A wave = the top WAVE_SIZE hospitals that are still close to the best one left
//     (ETA within ETA_BAND_MIN minutes of it, score at least SCORE_BAND × its score). A far,
//     low-ranked hospital is never alerted in the same wave as a much better one.
//   • BEST "YES" WINS: if the best-ranked hospital still deciding accepts, it is confirmed at once.
//     If a lower-ranked one accepts first, its beds are held and it becomes an OFFER; the system
//     waits up to BETTER_WAIT_SECONDS for the better-ranked hospitals, then confirms the best offer.
//   • A decline moves on immediately; no answer within RESPONSE_SECONDS counts as a decline.
//     When nobody in the wave is left, the next wave is alerted automatically.
//   • Dispatcher override: "send to this hospital" alerts one chosen hospital; its accept is
//     confirmed at once (the crew's decision beats the ranking).
// Confirming claims the emergency with a conditional UPDATE (… WHERE request_status = 'MATCHING')
// and takes the beds with the conditional UPDATE below, in one transaction, so two hospitals can
// never both win. Everyone else is withdrawn automatically.
//
// TWO PATIENTS, ONE BED (queueAt): when several emergencies wait on the same hospital and it does
// not have beds for all of them, they are put in order and the free beds go down the list:
//   1. more serious condition first (Critical → Serious → Need Assistance → Stable/Minor)
//   2. then the patient with NO other hospital still able to take them
//   3. then whoever called in first (waited longer)
//   4. then whoever is closer (arrives sooner)
//   5. then the request number (so the answer is never random)
// Accepting a patient who is not next in line is refused (409 PRIORITY_CONFLICT) unless the doctor
// overrides. After an accept, patients who no longer fit are released at once to search elsewhere.
//
// DOUBLE-BOOKING PROTECTION
// Taking a bed is ONE conditional UPDATE inside a transaction:
//     UPDATE hospital_resources SET available_icu_beds = available_icu_beds - 1
//     WHERE hospital_id = ? AND available_icu_beds >= 1
// If two dispatchers race for the last bed, the second UPDATE matches 0 rows, so it
// can never push availability below zero. The loser gets a FAILED reservation + 409 with
// alternatives. SQLite serialises write transactions, so this holds under concurrency.
import db from '../db/index.js';
import { getRequest, formatRequests } from './requestService.js';
import { getHospital, getAllHospitals } from './hospitalService.js';
import { primaryBed, matchRequest } from './rankingService.js';
import { nextId } from '../utils/ids.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';
import { roadDistanceKm, etaMinutes } from './geo.js';

export const HOLD_MINUTES = Number(process.env.HOLD_MINUTES) || 10;   // hospital must answer within this
export const CONFIRMED_HOLD_MINUTES = 15;                              // bed kept for the arriving ambulance
export const DISPATCH_AMBULANCE = 'AMB-012';                           // Ambulance A-12 (the logged-in crew)
export const WAVE_SIZE = Number(process.env.BROADCAST_MAX) || 3;                 // hospitals per wave
export const ETA_BAND_MIN = Number(process.env.ETA_BAND_MIN ?? 10);              // a wave only includes hospitals ≤ this many min slower than the best
export const SCORE_BAND = Number(process.env.SCORE_BAND ?? 0.85);                // … and scoring ≥ this share of the best score
export const RESPONSE_SECONDS = Number(process.env.RESPONSE_SECONDS) || 60;      // time a hospital has to answer an alert
export const BETTER_WAIT_SECONDS = Number(process.env.BETTER_WAIT_SECONDS ?? 30); // how long a lower-ranked "yes" waits for better-ranked hospitals

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
// Many requests at once (2 + 1 queries instead of 2 per request)
async function requestsById(ids) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return {};
  const rows = await db.prepare(`SELECT * FROM emergency_requests WHERE request_id IN (${uniq.map(() => '?').join(',')})`).all(...uniq);
  return Object.fromEntries((await formatRequests(rows)).map(r => [r.request_id, r]));
}
// One emergency's reservations change one transaction at a time (Postgres row lock; no-op on SQLite)
const lockRequest = (requestId) => db.lock('emergency_requests', 'request_id', requestId);
const lockHospital = (hospitalId) => db.lock('hospital_resources', 'hospital_id', hospitalId);
const hospitalsById = async () => Object.fromEntries((await getAllHospitals()).map(h => [h.hospital_id, h]));
const addMin = (m) => iso(Date.now() + m * 60000);

async function logChange(hospitalId, label, oldVal, newVal, source) {
  await db.prepare(`INSERT INTO resource_update_history
    (update_id, hospital_id, resource_type, old_available_count, new_available_count, updated_at, update_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(await nextId(db, 'resource_update_history', 'update_id', 'UPD', 6), hospitalId, label, oldVal, newVal, iso(), source);
}

// Atomic "take N if N are free". Returns false if someone else got there first.
async function takeBeds(hospitalId, label, qty) {
  const col = COLUMN[label];
  const before = (await db.prepare(`SELECT ${col} AS n FROM hospital_resources WHERE hospital_id = ?`).get(hospitalId)).n;
  const res = await db.prepare(`UPDATE hospital_resources SET ${col} = ${col} - @qty, version = version + 1
                          WHERE hospital_id = @id AND ${col} >= @qty`).run({ id: hospitalId, qty });
  if (res.changes === 0) return false;
  await logChange(hospitalId, label, before, before - qty, 'Reservation Hold');
  return true;
}

// Give beds back (never above the hospital's total). Only for holds with holds_capacity = 1:
// dataset reservations never subtracted anything from the snapshot, so releasing them returns nothing.
async function returnBeds(hospitalId, label, qty, source) {
  const col = COLUMN[label];
  const totalCol = col.replace('available_', 'total_');
  await lockHospital(hospitalId);
  const row = await db.prepare(`SELECT ${col} AS n, ${totalCol} AS t FROM hospital_resources WHERE hospital_id = ?`).get(hospitalId);
  const next = Math.min(row.t, row.n + qty);
  if (next === row.n) return;
  await db.prepare(`UPDATE hospital_resources SET ${col} = ?, version = version + 1 WHERE hospital_id = ?`).run(next, hospitalId);
  await logChange(hospitalId, label, row.n, next, source);
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

const reservationsOf = async (requestId, hospitalId) => (await db.prepare(`
  SELECT r.*, h.hospital_name FROM reservations r JOIN hospitals h ON h.hospital_id = r.hospital_id
  WHERE r.request_id = ? ${hospitalId ? 'AND r.hospital_id = ?' : ''} ORDER BY r.requested_at DESC, r.reservation_id DESC`)
  .all(...(hospitalId ? [requestId, hospitalId] : [requestId]))).map(formatReservation);

async function announce(requestId, hospitalId, action, extra = {}) {
  const payload = {
    action,                                         // held | failed | accepted | rejected | cancelled | expired
    request: await getRequest(requestId),
    hospital_id: hospitalId,
    hospital_name: (await getHospital(hospitalId))?.name,
    reservations: await reservationsOf(requestId, hospitalId),
    ...extra,
  };
  bus.emit(EVENTS.RESERVATION_UPDATE, payload);
  bus.emit(EVENTS.REQUEST_UPDATE, payload.request);
  const hospital = await getHospital(hospitalId);
  bus.emit(EVENTS.HOSPITAL_UPDATE, { hospital, changed: [], source: 'Reservation' });
  return payload;
}

// Next eligible hospitals from the saved ranking that still have the primary bed free
async function alternatives(req, excludeId) {
  const pb = primaryBed(req);
  const hs = await hospitalsById();
  return (await db.prepare(`SELECT m.hospital_id, m.rank, m.final_suitability_score AS score, m.estimated_travel_time_min AS eta_min
                     FROM match_ranking_results m WHERE m.request_id = ? AND m.eligibility = 1 AND m.hospital_id != ?
                     ORDER BY m.rank`).all(req.request_id, excludeId))
    .map(a => ({ ...a, hospital: hs[a.hospital_id] }))
    .filter(a => a.hospital && a.hospital.resources[pb.key].available >= req.beds_required)
    .slice(0, 3)
    .map(a => ({ hospital_id: a.hospital_id, hospital_name: a.hospital.name, rank: a.rank, score: a.score, eta_min: a.eta_min,
                 free: a.hospital.resources[pb.key].available }));
}

/** Dispatcher: hold beds at a hospital for a request. */
export async function reserve({ request_id, hospital_id } = {}) {
  const req = await getRequest(request_id);
  if (!req) throw new ApiError(404, `Request ${request_id} not found`);
  if (!await getHospital(hospital_id)) throw new ApiError(404, `Hospital ${hospital_id} not found`);
  if (!['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) {
    throw new ApiError(409, `Request is already ${req.status}`, { code: 'NOT_RESERVABLE' });
  }

  const holds = holdsFor(req);
  const outcome = await db.transaction(async () => {
    await lockRequest(request_id);
    const active = await db.prepare(`SELECT reservation_id, hospital_id FROM reservations
      WHERE request_id = ? AND reservation_status IN ('PENDING','CONFIRMED')`).get(request_id);
    if (active) return { conflict: 'ALREADY_HELD', active };

    const now = iso();
    const taken = [];
    for (const h of holds) {
      if (!await takeBeds(hospital_id, h.label, h.qty)) {
        // Lost the race (or no capacity): undo partial holds, record the FAILED attempt
        for (const t of taken) await returnBeds(hospital_id, t.label, t.qty, 'Reservation Rollback');
        await db.prepare(`INSERT INTO reservations (reservation_id, request_id, hospital_id, resource_type, quantity,
            reservation_status, requested_at, confirmed_at, expires_at) VALUES (?, ?, ?, ?, ?, 'FAILED', ?, NULL, ?)`)
          .run(await nextId(db, 'reservations', 'reservation_id', 'RSV', 6), request_id, hospital_id, h.label, h.qty, now, addMin(HOLD_MINUTES));
        return { conflict: 'BED_TAKEN', label: h.label };
      }
      taken.push(h);
    }

    for (const h of holds) {
      await db.prepare(`INSERT INTO reservations (reservation_id, request_id, hospital_id, resource_type, quantity,
          reservation_status, requested_at, confirmed_at, expires_at, holds_capacity) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, 1)`)
        .run(await nextId(db, 'reservations', 'reservation_id', 'RSV', 6), request_id, hospital_id, h.label, h.qty, now, addMin(HOLD_MINUTES));
    }
    await db.prepare(`INSERT INTO emergency_workflow_handover (workflow_id, request_id, hospital_id, ambulance_id,
        hospital_response, rejection_reason, assignment_time, departure_time, arrival_time, handover_time, handover_status)
        VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, NULL, NULL, NULL, NULL)`)
      .run(await nextId(db, 'emergency_workflow_handover', 'workflow_id', 'WF', 6), request_id, hospital_id, DISPATCH_AMBULANCE, now);
    await db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING', ambulance_id = ? WHERE request_id = ?`)
      .run(DISPATCH_AMBULANCE, request_id);
    return { ok: true };
  })();

  if (outcome.conflict === 'ALREADY_HELD') {
    throw new ApiError(409, `This emergency already has an active hold at ${(await getHospital(outcome.active.hospital_id)).name}. Cancel it first.`,
      { code: 'ALREADY_HELD', reservation_id: outcome.active.reservation_id });
  }
  if (outcome.conflict === 'BED_TAKEN') {
    const alts = await alternatives(req, hospital_id);
    await announce(request_id, hospital_id, 'failed');
    throw new ApiError(409, `${outcome.label} at ${(await getHospital(hospital_id)).name} was just taken by another request.`,
      { code: 'BED_TAKEN', alternatives: alts });
  }
  return await announce(request_id, hospital_id, 'held', { hold_minutes: HOLD_MINUTES });
}

// Shared by accept / reject / cancel / expire: finds the request's active holds at a hospital
async function activeHolds(reservationId) {
  const r = await db.prepare('SELECT * FROM reservations WHERE reservation_id = ?').get(reservationId);
  if (!r) throw new ApiError(404, `Reservation ${reservationId} not found`);
  const group = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ?
    AND reservation_status IN ('PENDING','CONFIRMED')`).all(r.request_id, r.hospital_id);
  return { r, group };
}

async function setWorkflow(requestId, hospitalId, fields) {
  const wf = await db.prepare(`SELECT workflow_id FROM emergency_workflow_handover WHERE request_id = ? AND hospital_id = ?
    ORDER BY assignment_time DESC LIMIT 1`).get(requestId, hospitalId);
  if (!wf) return;
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  await db.prepare(`UPDATE emergency_workflow_handover SET ${sets} WHERE workflow_id = @id`).run({ ...fields, id: wf.workflow_id });
}

const activeCount = async (requestId) => (await db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE request_id = ?
  AND reservation_status IN ('PENDING','CONFIRMED')`).get(requestId)).n;

/** Hospital staff: accept or reject a pending hold. `byHospital` = logged-in hospital (must match). */
export async function respond(reservationId, { action, reason, byHospital, override = false } = {}) {
  if (!['accept', 'reject'].includes(action)) throw new ApiError(400, 'action must be accept or reject');
  if (action === 'reject' && !REJECT_REASONS.includes(reason)) {
    throw new ApiError(400, `reason must be one of: ${REJECT_REASONS.join(', ')}`);
  }
  const { r, group } = await activeHolds(reservationId);
  if (byHospital && byHospital !== r.hospital_id) throw new ApiError(403, 'This reservation belongs to another hospital');
  const pending = group.filter(g => g.reservation_status === 'PENDING');
  if (!pending.length) {
    const filled = (await db.prepare(`SELECT hospital_response FROM emergency_workflow_handover WHERE request_id = ? AND hospital_id = ?
      ORDER BY assignment_time DESC LIMIT 1`).get(r.request_id, r.hospital_id))?.hospital_response === 'WITHDRAWN';
    throw new ApiError(409, filled ? 'Another hospital already accepted this emergency.' : `Reservation is ${r.reservation_status}, not pending`,
      { code: filled ? 'ALREADY_FILLED' : 'NOT_PENDING', status: r.reservation_status });
  }

  if (action === 'reject') {
    await db.transaction(async () => {
      await lockRequest(r.request_id);
      const rows = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'PENDING'`).all(r.request_id, r.hospital_id);
      if (!rows.length) throw new ApiError(409, 'This request is no longer waiting for your answer.', { code: 'NOT_PENDING' });
      for (const g of rows) {
        await db.prepare(`UPDATE reservations SET reservation_status = 'RELEASED' WHERE reservation_id = ? AND reservation_status = 'PENDING'`).run(g.reservation_id);
        if (g.holds_capacity) await returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Released');
      }
      await setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'REJECTED', rejection_reason: reason });
      await db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status IN ('MATCHING','NO_MATCH','CREATED')`).run(r.request_id);
    })();
    const out = await announce(r.request_id, r.hospital_id, 'rejected', { reason, still_waiting: await activeCount(r.request_id) });
    await afterDecline(r.request_id);
    return out;
  }

  // Two patients, one bed: only the patient next in line may take it (unless the doctor overrides)
  if (!override) {
    const mine = (await queueAt(r.hospital_id)).find(q => q.request_id === r.request_id);
    if (mine && !mine.gets_bed && mine.behind) {             // (no bed at all → normal BED_TAKEN path below)
      throw new ApiError(409, mine.reason, { code: 'PRIORITY_CONFLICT', ahead: mine.behind, queue: mine });
    }
  }

  // ACCEPT: confirm now if nobody better-ranked is still deciding (or the dispatcher picked this
  // hospital); otherwise hold the beds as an OFFER and let the best "yes" win.
  const better = (await markOf(r.request_id, r.hospital_id))?.manual ? [] : await betterPending(r.request_id, r.hospital_id);
  if (!better.length) return await confirmHospital(r.request_id, r.hospital_id);
  const offer = await makeOffer(r.request_id, r.hospital_id, better);
  const done = await resolveOffers(r.request_id);             // (with no waiting time configured the offer is confirmed at once)
  if (done) return done;
  const stillMine = await db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'PENDING'`)
    .get(r.request_id, r.hospital_id);
  if (!stillMine.n) throw new ApiError(409, 'Another hospital already accepted this emergency.', { code: 'ALREADY_FILLED' });
  return offer;
}

// ───────────── Best "yes" wins ─────────────
const markOf = async (requestId, hospitalId) => await db.prepare('SELECT * FROM dispatch_marks WHERE request_id = ? AND hospital_id = ?').get(requestId, hospitalId);
const rankOf = async (requestId, hospitalId) => (await db.prepare('SELECT rank FROM match_ranking_results WHERE request_id = ? AND hospital_id = ?').get(requestId, hospitalId))?.rank ?? 999;

// Hospitals still deciding on this emergency, best rank first, with their offer (if they said yes)
async function pendingHospitals(requestId) {
  const ids = (await db.prepare(`SELECT DISTINCT hospital_id FROM reservations WHERE request_id = ? AND reservation_status = 'PENDING'`).all(requestId)).map(x => x.hospital_id);
  const list = [];
  for (const hid of ids) list.push({ hospital_id: hid, rank: await rankOf(requestId, hid), mark: await markOf(requestId, hid) });
  return list
    .map(p => ({ ...p, offered: !!p.mark?.offered_at }))
    .sort((a, b) => a.rank - b.rank);
}
async function betterPending(requestId, hospitalId) {
  const mine = await rankOf(requestId, hospitalId);
  return (await pendingHospitals(requestId)).filter(p => p.hospital_id !== hospitalId && p.rank < mine);
}

// A lower-ranked hospital said yes while better ones are still deciding: hold its beds and wait a little
async function makeOffer(requestId, hospitalId, better) {
  const now = Date.now();
  const earliest = (await db.prepare(`SELECT MIN(m.decide_at) AS d FROM dispatch_marks m WHERE m.request_id = ? AND m.offered_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM reservations r WHERE r.request_id = m.request_id AND r.hospital_id = m.hospital_id AND r.reservation_status = 'PENDING')`).get(requestId)).d;
  const decideAt = earliest || iso(now + BETTER_WAIT_SECONDS * 1000);        // the first offer starts the clock
  try {
    await db.transaction(async () => {
      await lockRequest(requestId);
      const req = await getRequest(requestId);
      if (!['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) throw new ApiError(409, 'Another hospital already accepted this emergency.', { code: 'ALREADY_FILLED' });
      const rows = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'PENDING'`).all(requestId, hospitalId);
      if (!rows.length) throw new ApiError(409, 'This request is no longer waiting for your answer.', { code: 'NOT_PENDING' });
      for (const g of rows) {
        if (!g.holds_capacity && !await takeBeds(hospitalId, g.resource_type, g.quantity)) {
          throw new ApiError(409, `No ${g.resource_type} is free any more at your hospital (taken since the request arrived).`, { code: 'BED_TAKEN', label: g.resource_type });
        }
        await db.prepare(`UPDATE reservations SET holds_capacity = 1, expires_at = ? WHERE reservation_id = ?`)
          .run(iso(new Date(decideAt).getTime() + 60000), g.reservation_id);
      }
      await db.prepare(`INSERT INTO dispatch_marks (request_id, hospital_id, manual, offered_at, decide_at) VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(request_id, hospital_id) DO UPDATE SET offered_at = excluded.offered_at, decide_at = excluded.decide_at`)
        .run(requestId, hospitalId, iso(now), decideAt);
    })();
  } catch (err) {
    if (err.details?.code === 'BED_TAKEN') await autoDecline(requestId, hospitalId);
    throw err;
  }
  const hs = await hospitalsById();
  const waiting_on = better.map(b => ({ hospital_id: b.hospital_id, hospital_name: hs[b.hospital_id]?.name, rank: b.rank }));
  const out = await announce(requestId, hospitalId, 'offered', { decide_at: decideAt, waiting_on });
  return { ...out, offered: true, decide_at: decideAt, waiting_on };
}

// Pick the winner if it is time: the best hospital still deciding has said yes, or the wait is over
export async function resolveOffers(requestId, now = Date.now()) {
  const req = await getRequest(requestId);
  if (!req || !['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) return null;
  const pend = await pendingHospitals(requestId);
  const offers = pend.filter(p => p.offered);
  if (!offers.length) return null;
  const due = offers.some(o => new Date(o.mark.decide_at).getTime() <= now);
  const winner = pend[0].offered ? pend[0] : due ? offers[0] : null;
  if (!winner) return null;
  try { return await confirmHospital(requestId, winner.hospital_id); }
  catch (e) { if (!['ALREADY_FILLED', 'BED_TAKEN'].includes(e.details?.code)) console.error('[offers]', e.message); return null; }
}

// Runs from the sweeper: offers whose wait is over
async function resolveDueOffers(now = Date.now()) {
  const ids = (await db.prepare(`SELECT DISTINCT m.request_id FROM dispatch_marks m JOIN reservations r
    ON r.request_id = m.request_id AND r.hospital_id = m.hospital_id AND r.reservation_status = 'PENDING'
    WHERE m.offered_at IS NOT NULL AND m.decide_at <= ?`).all(iso(now))).map(x => x.request_id);
  for (const id of ids) await resolveOffers(id, now);
  return ids.length;
}

// This hospital can no longer take the patient: record it as a decline so the others (or the next wave) carry on
async function autoDecline(requestId, hospitalId) {
  await db.transaction(async () => {
    await lockRequest(requestId);
    const rows = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'PENDING'`).all(requestId, hospitalId);
    for (const g of rows) {
      const u = await db.prepare(`UPDATE reservations SET reservation_status = 'FAILED' WHERE reservation_id = ? AND reservation_status = 'PENDING'`).run(g.reservation_id);
      if (!u.changes) continue;
      if (g.holds_capacity) await returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Released');
    }
    await setWorkflow(requestId, hospitalId, { hospital_response: 'REJECTED', rejection_reason: 'No Bed' });
  })();
  await announce(requestId, hospitalId, 'rejected', { reason: 'No Bed', auto: true, still_waiting: await activeCount(requestId) });
  await afterDecline(requestId);
}

// Someone dropped out: an offer may now be the best, or the wave may be empty → next wave
async function afterDecline(requestId) {
  if (await resolveOffers(requestId)) return;
  await maybeEscalate(requestId);
}

// Final confirmation: claim the emergency, take the beds, withdraw everyone else (one transaction)
async function confirmHospital(requestId, hospitalId) {
  let withdrawn = [];
  try {
    withdrawn = await db.transaction(async () => {
      await lockRequest(requestId);
      const claim = await db.prepare(`UPDATE emergency_requests SET request_status = 'ASSIGNED'
        WHERE request_id = ? AND request_status IN ('CREATED','MATCHING','NO_MATCH')`).run(requestId);
      if (!claim.changes) throw new ApiError(409, 'Another hospital already accepted this emergency.', { code: 'ALREADY_FILLED' });
      const now = iso();
      const pending = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id = ? AND reservation_status = 'PENDING'`).all(requestId, hospitalId);
      if (!pending.length) throw new ApiError(409, 'This request is no longer waiting for your answer.', { code: 'NOT_PENDING' });
      for (const g of pending) {
        if (!g.holds_capacity && !await takeBeds(g.hospital_id, g.resource_type, g.quantity)) {
          throw new ApiError(409, `No ${g.resource_type} is free any more at your hospital (taken since the request arrived).`, { code: 'BED_TAKEN', label: g.resource_type });
        }
        await db.prepare(`UPDATE reservations SET reservation_status = 'CONFIRMED', confirmed_at = ?, expires_at = ?, holds_capacity = 1 WHERE reservation_id = ?`)
          .run(now, addMin(CONFIRMED_HOLD_MINUTES), g.reservation_id);
      }
      await setWorkflow(requestId, hospitalId, { hospital_response: 'ACCEPTED', handover_status: 'PENDING' });
      // withdraw the request from every other hospital still deciding (offers give their beds back)
      const others = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND hospital_id != ? AND reservation_status = 'PENDING'`)
        .all(requestId, hospitalId);
      for (const o of others) {
        await db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_id = ?`).run(o.reservation_id);
        if (o.holds_capacity) await returnBeds(o.hospital_id, o.resource_type, o.quantity, 'Filled Elsewhere');
      }
      const ids = [...new Set(others.map(o => o.hospital_id))];
      for (const id of ids) await setWorkflow(requestId, id, { hospital_response: 'WITHDRAWN' });
      return ids;
    })();
  } catch (err) {
    if (err.details?.code === 'BED_TAKEN') await autoDecline(requestId, hospitalId);
    throw err;
  }

  const winner = (await getHospital(hospitalId))?.name;
  const out = await announce(requestId, hospitalId, 'accepted', { withdrawn });
  for (const id of withdrawn) await announce(requestId, id, 'filled', { filled_by: winner, filled_by_id: hospitalId });
  await releaseUnfittable(hospitalId);
  return out;
}

// ───────────── Two patients, one bed ─────────────
const SEVERITY_ORDER = { Critical: 0, High: 1, Moderate: 2, Low: 3 };
const fits = (h, holds) => holds.every(x => h.resources[RESOURCE_KEY[x.label]].available >= x.qty);

// Other hospitals still deciding on this emergency that have the beds free right now
async function otherOptions(requestId, hospitalId, holds) {
  const hs = await hospitalsById();
  return (await db.prepare(`SELECT DISTINCT hospital_id FROM reservations WHERE request_id = ? AND hospital_id != ? AND reservation_status = 'PENDING'`)
    .all(requestId, hospitalId)).map(x => hs[x.hospital_id])
    .filter(h => h?.accepting_patients && fits(h, holds)).length;
}

function whyAhead(a, b) {
  const secs = Math.round((new Date(b.req.created_at) - new Date(a.req.created_at)) / 1000);
  if (a.sev !== b.sev) return `${a.req.condition} is more serious than #${b.request_id} (${b.req.condition})`;
  if (!a.options !== !b.options) return `this hospital is the patient's only option (#${b.request_id} has another hospital with a free bed)`;
  if (secs > 0) return `called in first: waited ${secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`} longer than #${b.request_id}`;
  if (a.eta !== b.eta) return `closer: arrives ${Math.abs(b.eta - a.eta)} min sooner than #${b.request_id}`;
  return `equal on every count; tie broken by request number (#${a.request_id} before #${b.request_id})`;
}

/**
 * Order of the emergencies waiting on one hospital and who gets the free beds.
 * Returns one entry per waiting request: { request_id, position, gets_bed, contended, reason, behind }.
 */
export async function queueAt(hospitalId) {
  const h = await getHospital(hospitalId);
  if (!h) return [];
  const rows = await db.prepare(`SELECT * FROM reservations WHERE hospital_id = ? AND reservation_status = 'PENDING' ORDER BY reservation_id`).all(hospitalId);
  const byReq = new Map();
  for (const row of rows) {
    if (!byReq.has(row.request_id)) byReq.set(row.request_id, { request_id: row.request_id, holds: [], locked: false });
    const e = byReq.get(row.request_id);
    e.holds.push({ label: row.resource_type, qty: row.quantity });
    if (row.holds_capacity) e.locked = true;                 // manual hold: its beds are already set aside
  }
  const list = [];
  for (const e of byReq.values()) {
    const req = await getRequest(e.request_id);
    const eta = etaMinutes(roadDistanceKm(req.location.lat, req.location.lng, h.location.lat, h.location.lng));
    list.push({ ...e, req, eta, sev: SEVERITY_ORDER[req.severity] ?? 9, options: await otherOptions(e.request_id, hospitalId, e.holds) });
  }
  list.sort((a, b) => a.sev - b.sev || (a.options ? 1 : 0) - (b.options ? 1 : 0)
    || new Date(a.req.created_at) - new Date(b.req.created_at) || a.eta - b.eta || a.request_id.localeCompare(b.request_id));

  // hand out the free beds down the list
  const free = Object.fromEntries(Object.keys(COLUMN).map(l => [l, h.resources[RESOURCE_KEY[l]].available]));
  const winners = [];
  const out = list.map((e, i) => {
    let gets = e.locked;
    if (!gets && e.holds.every(x => free[x.label] >= x.qty)) { for (const x of e.holds) free[x.label] -= x.qty; gets = true; }
    const item = { request_id: e.request_id, position: i + 1, gets_bed: gets, contended: false, reason: null, behind: null, other_options: e.options, _e: e };
    if (gets && !e.locked) winners.push(item);
    if (!gets) {
      const short = e.holds.find(x => free[x.label] < x.qty);
      const hadRoom = h.resources[RESOURCE_KEY[short.label]].available >= short.qty;   // free before anyone ahead took it?
      const ahead = hadRoom ? [...winners].reverse().find(w => w._e.holds.some(x => x.label === short.label)) : null;
      item.behind = ahead?.request_id || null;
      item.reason = ahead
        ? `Only ${h.resources[RESOURCE_KEY[short.label]].available} ${short.label} free and #${ahead.request_id} is ahead: ${whyAhead(ahead._e, e)}.`
        : `No ${short.label} free right now.`;
      if (ahead) { ahead.contended = true; item.contended = true; ahead.reason ||= `Next in line for the ${short.label}: ${whyAhead(ahead._e, e)}.`; }
    }
    return item;
  });
  return out.map(({ _e, ...x }) => x);
}

// After beds are taken: emergencies still waiting here that no longer fit are released right away
// (recorded as "No Bed"), so they search elsewhere instead of waiting for the hold to expire.
async function releaseUnfittable(hospitalId) {
  const h = await getHospital(hospitalId);
  const rows = await db.prepare(`SELECT * FROM reservations WHERE hospital_id = ? AND reservation_status = 'PENDING' AND holds_capacity = 0`).all(hospitalId);
  const byReq = new Map();
  for (const row of rows) (byReq.get(row.request_id) || byReq.set(row.request_id, []).get(row.request_id)).push(row);
  const released = [];
  for (const [rid, group] of byReq) {
    if (fits(h, group.map(g => ({ label: g.resource_type, qty: g.quantity })))) continue;
    await db.transaction(async () => {
      await lockRequest(rid);
      for (const g of group) await db.prepare(`UPDATE reservations SET reservation_status = 'FAILED' WHERE reservation_id = ? AND reservation_status = 'PENDING'`).run(g.reservation_id);
      await setWorkflow(rid, hospitalId, { hospital_response: 'REJECTED', rejection_reason: 'No Bed' });
    })();
    await announce(rid, hospitalId, 'rejected', { reason: 'No Bed', auto: true, still_waiting: await activeCount(rid) });
    released.push(rid);
  }
  for (const rid of released) await afterDecline(rid);
  return released;
}

/** Dispatcher: cancel a hold (pending or confirmed) and give the beds back. */
export async function cancel(reservationId) {
  const { r, group } = await activeHolds(reservationId);
  if (!group.length) throw new ApiError(409, `Reservation is ${r.reservation_status}; nothing to cancel`, { code: 'NOT_ACTIVE' });
  await db.transaction(async () => {
    await lockRequest(r.request_id);
    for (const g of group) {
      const u = await db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_id = ? AND reservation_status IN ('PENDING','CONFIRMED')`).run(g.reservation_id);
      const now = await db.prepare('SELECT holds_capacity FROM reservations WHERE reservation_id = ?').get(g.reservation_id);
      if (u.changes && now.holds_capacity) await returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Cancelled');
    }
    await setWorkflow(r.request_id, r.hospital_id, { hospital_response: 'WITHDRAWN' });
    await db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status IN ('MATCHING','ASSIGNED')`)
      .run(r.request_id);
  })();
  return await announce(r.request_id, r.hospital_id, 'cancelled');
}

/** Dispatcher: withdraw the emergency from every hospital still deciding (broadcast "Cancel all"). */
export async function withdrawAll(requestId) {
  const req = await getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  const rows = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND reservation_status = 'PENDING'`).all(requestId);
  if (!rows.length) throw new ApiError(409, 'No hospital is waiting on this emergency', { code: 'NOT_ACTIVE' });
  const ids = [...new Set(rows.map(x => x.hospital_id))];
  await db.transaction(async () => {
    await lockRequest(requestId);
    const fresh = await db.prepare(`SELECT * FROM reservations WHERE request_id = ? AND reservation_status = 'PENDING'`).all(requestId);
    for (const g of fresh) {
      await db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_id = ?`).run(g.reservation_id);
      if (g.holds_capacity) await returnBeds(g.hospital_id, g.resource_type, g.quantity, 'Reservation Cancelled');
    }
    for (const id of ids) await setWorkflow(requestId, id, { hospital_response: 'WITHDRAWN' });
  })();
  for (const id of ids) await announce(requestId, id, 'cancelled');
  return { request: await getRequest(requestId), withdrawn: ids };
}

// ───────────── Broadcast ─────────────
const contactedIds = async (requestId) => new Set((await db.prepare('SELECT DISTINCT hospital_id FROM emergency_workflow_handover WHERE request_id = ?')
  .all(requestId)).map(x => x.hospital_id));

// Next wave: eligible hospitals from the (fresh) ranking, not contacted yet, with the beds free right now,
// and CLOSE TO THE BEST ONE LEFT (ETA and score bands), at most `max` of them.
async function suitableTargets(req, max) {
  const seen = await contactedIds(req.request_id);
  const hs = await hospitalsById();
  const holds = holdsFor(req);
  const all = (await db.prepare(`SELECT hospital_id, rank, final_suitability_score AS score, estimated_travel_time_min AS eta_min, distance_km
                     FROM match_ranking_results WHERE request_id = ? AND eligibility = 1 ORDER BY rank`).all(req.request_id))
    .filter(m => !seen.has(m.hospital_id))
    .map(m => ({ ...m, hospital: hs[m.hospital_id] }))
    .filter(m => m.hospital?.accepting_patients && holds.every(h => m.hospital.resources[RESOURCE_KEY[h.label]].available >= h.qty));
  if (!all.length) return [];
  const best = all[0];
  return all.filter(m => m.eta_min <= best.eta_min + ETA_BAND_MIN && m.score >= best.score * SCORE_BAND).slice(0, max);
}

/**
 * Dispatcher: alert the next wave (best hospitals first). Re-ranks first so availability is current.
 * Hospitals already contacted for this emergency are skipped, so calling it again = "next wave".
 * opts.hospital_id → dispatcher override: alert just this hospital; its accept is confirmed at once.
 */
export async function broadcast(requestId, { max = WAVE_SIZE, auto = false, hospital_id = null } = {}) {
  let req = await getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  if (!['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) {
    throw new ApiError(409, `Request is already ${req.status}`, { code: 'NOT_RESERVABLE' });
  }
  await matchRequest(requestId);
  req = await getRequest(requestId);
  let targets;
  if (hospital_id) {
    const m = await db.prepare(`SELECT hospital_id, rank, final_suitability_score AS score, estimated_travel_time_min AS eta_min, distance_km, eligibility
                          FROM match_ranking_results WHERE request_id = ? AND hospital_id = ?`).get(requestId, hospital_id);
    const h = await getHospital(hospital_id);
    if (!h) throw new ApiError(404, `Hospital ${hospital_id} not found`);
    if (!m?.eligibility) throw new ApiError(409, `${h.name} cannot meet this patient's requirements right now.`, { code: 'NOT_ELIGIBLE' });
    if ((await pendingHospitals(requestId)).some(p => p.hospital_id === hospital_id)) throw new ApiError(409, `${h.name} is already deciding on this emergency.`, { code: 'ALREADY_ALERTED' });
    if (!holdsFor(req).every(x => h.resources[RESOURCE_KEY[x.label]].available >= x.qty)) throw new ApiError(409, `${h.name} has no free bed of the right type right now.`, { code: 'BED_TAKEN' });
    targets = [{ ...m, hospital: h }];
  } else {
    targets = await suitableTargets(req, Number(max) > 0 ? Number(max) : Infinity);
  }

  if (!targets.length) {
    const waiting = (await db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE request_id = ? AND reservation_status = 'PENDING'`).get(requestId)).n;
    if (!waiting) await db.prepare(`UPDATE emergency_requests SET request_status = 'NO_MATCH' WHERE request_id = ?`).run(requestId);
    const request = await getRequest(requestId);
    bus.emit(EVENTS.REQUEST_UPDATE, request);
    bus.emit(EVENTS.RESERVATION_UPDATE, { action: 'exhausted', request, hospital_id: null, reservations: [], auto });
    throw new ApiError(409, waiting ? 'Every other suitable hospital has already been alerted.'
      : 'No suitable hospital with free capacity is left to alert. Adjust the requirements or re-run later.', { code: 'NO_SUITABLE' });
  }

  const holds = holdsFor(req);
  const now = iso(), expires = iso(Date.now() + RESPONSE_SECONDS * 1000);
  const wave = await db.transaction(async () => {
    await lockRequest(requestId);
    // another server / click may have alerted some of them a moment ago: never alert a hospital twice
    if (!hospital_id) {
      const seenNow = await contactedIds(requestId);
      targets = targets.filter(t => !seenNow.has(t.hospital_id));
      if (!targets.length) throw new ApiError(409, 'Every other suitable hospital has already been alerted.', { code: 'NO_SUITABLE' });
    }
    for (const t of targets) {
      for (const h of holds) {
        await db.prepare(`INSERT INTO reservations (reservation_id, request_id, hospital_id, resource_type, quantity,
            reservation_status, requested_at, confirmed_at, expires_at, holds_capacity) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, 0)`)
          .run(await nextId(db, 'reservations', 'reservation_id', 'RSV', 6), requestId, t.hospital_id, h.label, h.qty, now, expires);
      }
      await db.prepare(`INSERT INTO emergency_workflow_handover (workflow_id, request_id, hospital_id, ambulance_id,
          hospital_response, rejection_reason, assignment_time, departure_time, arrival_time, handover_time, handover_status)
          VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, NULL, NULL, NULL, NULL)`)
        .run(await nextId(db, 'emergency_workflow_handover', 'workflow_id', 'WF', 6), requestId, t.hospital_id, DISPATCH_AMBULANCE, now);
      await db.prepare(`INSERT INTO dispatch_marks (request_id, hospital_id, manual, offered_at, decide_at) VALUES (?, ?, ?, NULL, NULL)
        ON CONFLICT(request_id, hospital_id) DO UPDATE SET manual = excluded.manual, offered_at = NULL, decide_at = NULL`)
        .run(requestId, t.hospital_id, hospital_id ? 1 : 0);
    }
    // a hand-picked hospital joins the current wave instead of starting a new one
    await db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING', ambulance_id = ?,
      broadcast_round = CASE WHEN ? = 1 THEN (CASE WHEN broadcast_round < 1 THEN 1 ELSE broadcast_round END) ELSE broadcast_round + 1 END WHERE request_id = ?`)
      .run(DISPATCH_AMBULANCE, hospital_id ? 1 : 0, requestId);
    return (await db.prepare('SELECT broadcast_round AS n FROM emergency_requests WHERE request_id = ?').get(requestId)).n;
  })();

  for (const t of targets) await announce(requestId, t.hospital_id, 'held', { broadcast: true, wave, auto, manual: !!hospital_id, response_seconds: RESPONSE_SECONDS });
  return {
    request: await getRequest(requestId),
    wave, auto, manual: !!hospital_id, response_seconds: RESPONSE_SECONDS, better_wait_seconds: BETTER_WAIT_SECONDS, expires_at: expires,
    sent_to: targets.map(t => ({ hospital_id: t.hospital_id, hospital_name: t.hospital.name, rank: t.rank, score: t.score,
                                 eta_min: Math.round(t.eta_min), distance_km: t.distance_km })),
  };
}

// After a decline / expiry: if this was a broadcast and nobody is left deciding, alert the next wave
async function maybeEscalate(requestId) {
  const row = await db.prepare('SELECT broadcast_round, request_status FROM emergency_requests WHERE request_id = ?').get(requestId);
  if (!row?.broadcast_round || !['CREATED', 'MATCHING', 'NO_MATCH'].includes(row.request_status)) return null;
  if (await activeCount(requestId)) return null;
  try { return await broadcast(requestId, { auto: true }); }
  catch (e) { if (e.details?.code !== 'NO_SUITABLE') console.error('[broadcast]', e.message); return null; }
}

/** Release holds the hospital never answered (runs every few seconds). Returns how many expired. */
export async function expireStaleHolds(now = Date.now()) {
  const due = await db.prepare(`SELECT * FROM reservations WHERE reservation_status = 'PENDING' AND expires_at < ?`).all(iso(now));
  const groups = new Map();                          // only holds that really expired now
  for (const d of due) {
    await db.transaction(async () => {
      await lockRequest(d.request_id);
      const res = await db.prepare(`UPDATE reservations SET reservation_status = 'EXPIRED' WHERE reservation_id = ? AND reservation_status = 'PENDING' AND expires_at < ?`)
        .run(d.reservation_id, iso(now));
      const cur = await db.prepare('SELECT holds_capacity FROM reservations WHERE reservation_id = ?').get(d.reservation_id);
      if (res.changes && cur.holds_capacity) await returnBeds(d.hospital_id, d.resource_type, d.quantity, 'Reservation Expired');
      if (res.changes) groups.set(`${d.request_id}|${d.hospital_id}`, d);
    })();
  }
  for (const d of groups.values()) {
    await setWorkflow(d.request_id, d.hospital_id, { hospital_response: 'REJECTED', rejection_reason: 'Other' });
    await db.prepare(`UPDATE emergency_requests SET request_status = 'MATCHING' WHERE request_id = ? AND request_status = 'MATCHING'`).run(d.request_id);
    await announce(d.request_id, d.hospital_id, 'expired');
  }
  for (const id of new Set([...groups.values()].map(d => d.request_id))) await afterDecline(id);
  await resolveDueOffers(now);
  return groups.size;
}

let sweeper = null;
export function startExpirySweeper(everyMs = 2000) {
  let busy = false;
  if (!sweeper) sweeper = setInterval(async () => {
    if (busy) return;                                  // previous run still going (slow remote database)
    busy = true;
    try { await expireStaleHolds(); } catch (e) { console.error('[expiry]', e.message); } finally { busy = false; }
  }, everyMs);
  sweeper.unref?.();
}

/** Hospital inbox: holds waiting for this hospital (+ recently answered, for context). */
export async function listForHospital(hospitalId, { status } = {}) {
  if (!await getHospital(hospitalId)) throw new ApiError(404, `Hospital ${hospitalId} not found`);
  const statuses = status ? status.split(',') : ['PENDING', 'CONFIRMED'];
  const rows = await db.prepare(`
    SELECT r.*, h.hospital_name FROM reservations r
    JOIN hospitals h ON h.hospital_id = r.hospital_id
    JOIN emergency_requests e ON e.request_id = r.request_id
    WHERE r.hospital_id = ? AND r.reservation_status IN (${statuses.map(() => '?').join(',')})
      AND r.requested_at >= ?
      AND (r.reservation_status != 'CONFIRMED' OR e.request_status IN ('ASSIGNED','IN_TRANSIT'))   -- confirmed = patient still on the way
    ORDER BY CASE r.reservation_status WHEN 'PENDING' THEN 0 ELSE 1 END, r.requested_at DESC LIMIT 100`)
    .all(hospitalId, ...statuses, iso(Date.now() - 24 * 3600e3));

  // one entry per request (bed + ventilator holds grouped)
  const reqs = await requestsById(rows.map(r => r.request_id));
  const byReq = new Map();
  for (const row of rows) {
    const f = formatReservation(row);
    if (!byReq.has(row.request_id)) byReq.set(row.request_id, { request: reqs[row.request_id], reservations: [] });
    byReq.get(row.request_id).reservations.push(f);
  }
  const hospital = await getHospital(hospitalId);
  const queue = Object.fromEntries((await queueAt(hospitalId)).map(q => [q.request_id, q]));
  const wfs = byReq.size ? await db.prepare(`SELECT * FROM emergency_workflow_handover WHERE hospital_id = ? AND request_id IN (${[...byReq.keys()].map(() => '?').join(',')})
                           ORDER BY assignment_time DESC`).all(hospitalId, ...byReq.keys()) : [];
  const marks = byReq.size ? await db.prepare(`SELECT * FROM dispatch_marks WHERE hospital_id = ? AND request_id IN (${[...byReq.keys()].map(() => '?').join(',')})`)
    .all(hospitalId, ...byReq.keys()) : [];
  return [...byReq.values()].map(x => {
    const wf = wfs.find(w => w.request_id === x.request.request_id);
    const mark = marks.find(m => m.request_id === x.request.request_id);
    const distance_km = roadDistanceKm(x.request.location.lat, x.request.location.lng, hospital.location.lat, hospital.location.lng);
    const eta_min = etaMinutes(distance_km);
    return {
      ...x,
      queue: x.reservations[0].status === 'PENDING' ? queue[x.request.request_id] || null : null,
      offer: x.reservations[0].status === 'PENDING' ? { manual: !!mark?.manual, offered_at: mark?.offered_at || null, decide_at: mark?.decide_at || null } : null,
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
  }).sort((a, b) => (a.queue && b.queue ? a.queue.position - b.queue.position : 0));   // waiting patients in priority order
}

/** Hospital history: every emergency this hospital was contacted for in the last N hours. */
export async function historyForHospital(hospitalId, { hours = 24 } = {}) {
  if (!await getHospital(hospitalId)) throw new ApiError(404, `Hospital ${hospitalId} not found`);
  const rows = await db.prepare(`SELECT * FROM emergency_workflow_handover WHERE hospital_id = ? AND assignment_time >= ?
                           ORDER BY assignment_time DESC LIMIT 200`).all(hospitalId, iso(Date.now() - hours * 3600e3));
  const adm = await db.prepare('SELECT request_id, ward, room, bed FROM admissions WHERE hospital_id = ?').all(hospitalId);
  const admBy = Object.fromEntries(adm.map(a => [a.request_id, a]));
  const reqs = await requestsById(rows.map(w => w.request_id));
  return rows.map(w => ({
    admission: w.hospital_response === 'ACCEPTED' ? admBy[w.request_id] || null : null,
    workflow_id: w.workflow_id,
    request: reqs[w.request_id],
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
