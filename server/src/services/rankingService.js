// Ranking engine: which hospital should this patient go to?
//
// Same model as the ERRA dataset's reference engine (match_ranking_results.csv):
//   resource_match = 0.7 × (share of requirements met) + 0.3 × headroom
//                    headroom = min(1, free primary beds ÷ (5 × beds_required))
//   travel         = max(0, 1 − ETA/60)
//   freshness      = exp(−data_age_minutes / 45)
//   final          = 0.5 × resource + 0.3 × travel + 0.2 × freshness
//   ineligible hospitals (a mandatory need missing, inactive, no ED) → final × 0.3
// Eligible hospitals always rank above ineligible ones.
//
// Candidates: the 5 nearest hospitals (so the dispatcher sees why the nearest may be
// unsuitable) + every other ELIGIBLE hospital reachable within 55 minutes.
import db from '../db/index.js';
import { getAllHospitals } from './hospitalService.js';
import { getRequest } from './requestService.js';
import { roadDistanceKm, etaMinutes } from './geo.js';
import { nextId } from '../utils/ids.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';

const NEAREST_ALWAYS = 5;
const MAX_ETA_MIN = 55;
const W = { resource: 0.5, travel: 0.3, freshness: 0.2 };
const INELIGIBLE_PENALTY = 0.3;

const SERVICE_NEEDS = {
  trauma_care: 'Trauma Care', cardiology: 'Cardiology', neurology: 'Neurology',
  blood_bank: 'Blood Bank', operation_theatre: 'Operation Theatre', dialysis: 'Dialysis',
};

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ICU if needed, else oxygen bed, else general bed (dataset rule)
export function primaryBed(req) {
  if (req.requirements.icu) return { key: 'icu', label: 'ICU' };
  if (req.requirements.oxygen) return { key: 'oxygen_bed', label: 'Oxygen Bed' };
  return { key: 'general_bed', label: 'General Bed' };
}

// List of mandatory needs for a request, e.g. ["ICU", "Trauma Care", "Trauma Surgeon"]
export function needsOf(req) {
  const r = req.requirements;
  const needs = [];
  if (r.icu) needs.push('ICU');
  if (r.ventilator) needs.push('Ventilator');
  if (r.oxygen) needs.push('Oxygen Bed');
  for (const [k, label] of Object.entries(SERVICE_NEEDS)) if (r[k]) needs.push(label);
  if (!r.icu && !r.oxygen) needs.push('General Bed');
  if (req.required_specialist) needs.push(req.required_specialist);
  return needs;
}

// Does hospital h satisfy the request? Returns score parts + human-readable gaps.
export function evaluate(req, h) {
  const beds = req.beds_required;
  const needs = needsOf(req);
  const met = [];
  const missing = [];
  const check = (ok, need, why) => (ok ? met.push(need) : missing.push(why));

  for (const n of needs) {
    if (n === 'ICU') check(h.resources.icu.available >= beds, n, `ICU needs ${beds}, ${h.resources.icu.available} available`);
    else if (n === 'Ventilator') check(h.resources.ventilator.available >= 1, n,
      h.resources.ventilator.total === 0 ? 'no ventilators at facility' : '0 ventilators available');
    else if (n === 'Oxygen Bed') check(h.resources.oxygen_bed.available >= beds, n, `oxygen beds ${h.resources.oxygen_bed.available} available`);
    else if (n === 'General Bed') check(h.resources.general_bed.available >= beds, n, 'no general beds');
    else {
      const svcKey = Object.keys(SERVICE_NEEDS).find(k => SERVICE_NEEDS[k] === n);
      if (svcKey) check(h.services[svcKey], n, `no ${n.toLowerCase()} service`);
      else check(h.specialists.includes(n), n, `${n} not on staff`);
    }
  }

  const blockers = [];
  if (!h.active) blockers.push('hospital inactive');
  if (!h.emergency_department) blockers.push('no emergency department');

  const pb = primaryBed(req);
  const coverage = met.length / needs.length;
  const headroom = Math.min(1, h.resources[pb.key].available / (5 * beds));
  return {
    resource_match_score: round(0.7 * coverage + 0.3 * headroom),
    eligible: missing.length === 0 && blockers.length === 0,
    needs, missing, blockers,
    primary_bed: { ...pb, available: h.resources[pb.key].available },
  };
}

/**
 * Rank hospitals for a request.
 * opts.now → clock for freshness (default: real time)
 * opts.at  → time used for traffic speed (default: now)
 */
export function rankHospitals(req, { now = Date.now(), at = new Date(now) } = {}) {
  const hospitals = getAllHospitals(now);
  const origin = req.location;

  const all = hospitals.map((h) => {
    const distance_km = roadDistanceKm(origin.lat, origin.lng, h.location.lat, h.location.lng);
    const eta = distance_km / speedFor(at) * 60 + 2;
    return { h, distance_km, eta, ev: evaluate(req, h) };
  }).sort((a, b) => a.distance_km - b.distance_km);

  const candidates = all.filter((c, i) => i < NEAREST_ALWAYS || (c.ev.eligible && c.eta <= MAX_ETA_MIN));
  const nearestId = all[0]?.h.hospital_id;

  const rows = candidates.map(({ h, distance_km, eta, ev }) => {
    const travel = Math.max(0, 1 - eta / 60);
    const fresh = h.freshness.score;
    const raw = W.resource * ev.resource_match_score + W.travel * travel + W.freshness * fresh;
    return {
      hospital_id: h.hospital_id,
      hospital_name: h.name,
      hospital_type: h.type,
      location: h.location,
      eligible: ev.eligible,
      scores: {
        resource: ev.resource_match_score,
        travel: round(travel),
        freshness: fresh,
        final: round(ev.eligible ? raw : raw * INELIGIBLE_PENALTY),
      },
      distance_km: round(distance_km, 2),
      eta_min: round(eta, 1),
      freshness: h.freshness,
      primary_bed: ev.primary_bed,
      needs: ev.needs,
      missing: [...ev.blockers, ...ev.missing],
      is_nearest: h.hospital_id === nearestId,
    };
  });

  rows.sort((a, b) => (a.eligible === b.eligible ? b.scores.final - a.scores.final : a.eligible ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; r.explanation = explain(r); });
  return rows;
}

// Same speed bands as geo.js, but for an arbitrary moment (dataset replays use the request time)
function speedFor(date) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(date));
  if (h >= 23 || h < 6) return 40;
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return 20;
  return 28;
}

function explain(r) {
  const age = Math.round(r.freshness.age_minutes);
  const label = r.freshness.status === 'stale' ? 'STALE' : r.freshness.status;
  const base = `${r.distance_km} km (~${Math.round(r.eta_min)} min); data ${age} min old (${label}). ` +
    `Score ${r.scores.final.toFixed(3)} = 0.5x${r.scores.resource.toFixed(2)} resource + 0.3x${r.scores.travel.toFixed(2)} travel + 0.2x${r.scores.freshness.toFixed(2)} freshness`;
  if (r.eligible) {
    let e = `ELIGIBLE: meets all requirements (${r.needs.join(', ')}). ${base}.`;
    if (r.freshness.status === 'stale') e += ' Availability data is stale - confirm with hospital before dispatch.';
    if (r.rank === 1 && !r.is_nearest) e += ' Ranked first although not the nearest candidate.';
    return e;
  }
  let e = `INELIGIBLE: ${r.missing.join('; ')}. ${base} x 0.3 ineligibility penalty.`;
  if (r.is_nearest) e += ' Nearest hospital but cannot satisfy mandatory requirements.';
  return e;
}

/**
 * Run the match for a stored request: rank, save to match_ranking_results,
 * move the request CREATED → MATCHING (or NO_MATCH), and notify live screens.
 */
export const matchRequest = (requestId) => {
  const req = getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  if (!['CREATED', 'MATCHING', 'NO_MATCH'].includes(req.status)) {
    throw new ApiError(409, `Request is already ${req.status}; it can no longer be re-matched`);
  }

  const rankings = rankHospitals(req);
  const eligibleCount = rankings.filter(r => r.eligible).length;
  const newStatus = eligibleCount ? 'MATCHING' : 'NO_MATCH';

  db.transaction(() => {
    db.prepare('DELETE FROM match_ranking_results WHERE request_id = ?').run(requestId);
    const insert = db.prepare(`
      INSERT INTO match_ranking_results
        (match_id, request_id, hospital_id, resource_match_score, distance_km, estimated_travel_time_min,
         freshness_score, final_suitability_score, rank, eligibility, explanation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rankings) {
      insert.run(nextId(db, 'match_ranking_results', 'match_id', 'MR', 6), requestId, r.hospital_id,
        r.scores.resource, r.distance_km, Math.max(0.1, r.eta_min), r.scores.freshness, r.scores.final,
        r.rank, r.eligible ? 1 : 0, r.explanation);
    }
    db.prepare('UPDATE emergency_requests SET request_status = ? WHERE request_id = ?').run(newStatus, requestId);
  })();

  const request = getRequest(requestId);
  bus.emit(EVENTS.REQUEST_UPDATE, request);
  return {
    request,
    summary: {
      evaluated: rankings.length,
      eligible: eligibleCount,
      best: rankings[0]?.eligible ? { hospital_id: rankings[0].hospital_id, hospital_name: rankings[0].hospital_name, eta_min: rankings[0].eta_min } : null,
      stale_in_results: rankings.filter(r => r.freshness.status === 'stale').length,
      ranked_at: new Date().toISOString(),
    },
    rankings,
  };
};

// Saved rankings (works for dataset requests too), with each hospital's CURRENT freshness
export function getSavedRankings(requestId) {
  const req = getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  const hospitals = Object.fromEntries(getAllHospitals().map(h => [h.hospital_id, h]));
  const rows = db.prepare('SELECT * FROM match_ranking_results WHERE request_id = ? ORDER BY rank').all(requestId);
  return {
    request_id: requestId,
    rankings: rows.map(r => {
      const h = hospitals[r.hospital_id];
      return {
        rank: r.rank,
        hospital_id: r.hospital_id,
        hospital_name: h?.name,
        hospital_type: h?.type,
        location: h?.location,
        eligible: !!r.eligibility,
        scores: { resource: r.resource_match_score, freshness: r.freshness_score, final: r.final_suitability_score },
        distance_km: r.distance_km,
        eta_min: r.estimated_travel_time_min,
        freshness: h?.freshness,           // live freshness now (may differ from when it was ranked)
        explanation: r.explanation,
      };
    }),
  };
}
