// Verifies the three ranking parameters and the "two patients, one bed" rule.
// Run: npm run test:verify
//
// Every check is a controlled experiment: two hospitals are made IDENTICAL, then exactly one
// thing is changed (distance, free beds or data age) and we check the ranking moves the right way
// and by the right amount (numbers recomputed by hand from the formulas).
//
//   1. CLOSEST HOSPITAL   travel = 1 − ETA/60, ETA = road km ÷ traffic speed × 60 + 2
//   2. BED AVAILABILITY   resource = 0.7 × needs met + 0.3 × min(1, free ÷ (5 × beds needed))
//   3. DATA FRESHNESS     freshness = e^(−age/45); fresh ≤ 5 min, aging ≤ 30, stale > 30
//   4. TWO REQUESTS, ONE BED  priority: severity → no other option → waited longer → closer → ID
import './_env.mjs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-verify-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SUPABASE_URL = ''; process.env.SUPABASE_SERVICE_ROLE_KEY = '';
execSync('node src/db/seed.js', { cwd: serverDir, env: { ...process.env }, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
const near = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;
const section = (t) => console.log(`\n── ${t} ──`);

try {
  const { default: db } = await import('../src/db/index.js');
  const { rankHospitals } = await import('../src/services/rankingService.js');
  const { haversineKm, roadDistanceKm, etaMinutes } = await import('../src/services/geo.js');
  const { getFreshness } = await import('../src/services/freshness.js');
  const { updateHospitalResources, getHospital } = await import('../src/services/hospitalService.js');
  const { createRequest, getRequest } = await import('../src/services/requestService.js');
  const rs = await import('../src/services/reservationService.js');

  // Fixed clock: 13:00 IST (off-peak, 28 km/h) so ETAs are exact
  const NOW = new Date('2026-09-28T13:00:00+05:30').getTime();
  const AT = new Date(NOW);
  const P = { lat: 18.5204, lng: 73.8567 };        // pickup: central Pune
  const KM_LAT = 1 / 111.195;                       // degrees of latitude per km
  const A = 'HSP-001', B = 'HSP-002';

  // Make a hospital a clean lab copy: all departments, every specialist, given beds + data age
  async function lab(id, { north = 0, icu = 5, oxygen = 5, general = 10, ventilator = 3, ageMin = 1 } = {}) {
    await db.prepare('UPDATE hospitals SET latitude = ?, longitude = ?, active_status = 1, emergency_department = 1 WHERE hospital_id = ?')
      .run(P.lat + north * KM_LAT, P.lng, id);
    await db.prepare(`UPDATE hospital_services SET trauma_care = 1, cardiology = 1, neurology = 1, blood_bank = 1, operation_theatre = 1,
      dialysis = 1, burn_unit = 1, specialists = 'Cardiologist;Neurologist;Trauma Surgeon;General Surgeon;Pulmonologist;Nephrologist' WHERE hospital_id = ?`).run(id);
    await db.prepare(`UPDATE hospital_resources SET total_icu_beds = 20, total_oxygen_beds = 20, total_general_beds = 40, total_ventilators = 10,
      available_icu_beds = ?, available_oxygen_beds = ?, available_general_beds = ?, available_ventilators = ?, last_updated_timestamp = ? WHERE hospital_id = ?`)
      .run(icu, oxygen, general, ventilator, new Date(NOW - ageMin * 60000).toISOString(), id);
  }
  const req = (over = {}) => ({ location: P, requirements: { icu: true }, beds_required: 1, required_specialist: null, ...over });
  const rank = async (r = req(), at = AT) => {
    const rows = await rankHospitals(r, { now: NOW, at });
    return { rows, a: rows.find(x => x.hospital_id === A), b: rows.find(x => x.hospital_id === B), pos: (id) => rows.findIndex(x => x.hospital_id === id) };
  };

  // ───────────────── 1. CLOSEST HOSPITAL ─────────────────
  section('1. Closest hospital (distance → ETA → travel score)');
  check(near(haversineKm(18.5, 73.8, 19.5, 73.8), 111.195, 0.01), 'Straight-line distance is exact: 1° of latitude = 111.195 km');
  check(roadDistanceKm(18.5, 73.8, 18.5 + 4 * KM_LAT, 73.8) === 5.7, 'Road distance = straight line × 1.35 + 0.3 km (4 km → 5.70 km)');
  const peak = new Date('2026-09-28T09:00:00+05:30'), night = new Date('2026-09-28T02:00:00+05:30');
  check(etaMinutes(10, peak) === 32 && etaMinutes(10, AT) === 23 && etaMinutes(10, night) === 17, 'ETA for 10 km: 32 min at 9 AM peak (20 km/h), 23 min midday (28), 17 min at night (40)');

  await lab(A, { north: 2 }); await lab(B, { north: -6 });
  let r1 = await rank();
  const etaA = roadDistanceKm(P.lat, P.lng, P.lat + 2 * KM_LAT, P.lng) / 28 * 60 + 2;
  check(near(r1.a.scores.travel, 1 - etaA / 60), `Travel score = 1 − ETA/60 (A: ${r1.a.distance_km} km, ${r1.a.eta_min} min → ${r1.a.scores.travel})`);
  check(r1.a.scores.resource === r1.b.scores.resource && r1.a.scores.freshness === r1.b.scores.freshness && r1.pos(A) < r1.pos(B),
    `Identical hospitals: the closer one ranks higher (A ${r1.a.distance_km} km #${r1.a.rank} vs B ${r1.b.distance_km} km #${r1.b.rank})`);
  check(near(r1.a.scores.final - r1.b.scores.final, 0.3 * (r1.a.scores.travel - r1.b.scores.travel), 0.002), 'Final score gap is exactly 0.3 × travel gap (distance is the only difference)');
  await lab(A, { north: 2, icu: 0 });
  r1 = await rank();
  check(!r1.a.eligible && r1.pos(B) < r1.pos(A) && /INELIGIBLE: ICU needs 1, 0 available/.test(r1.a.explanation),
    `Closer hospital with NO free ICU (${r1.a.distance_km} km) drops below the farther one that can take the patient (${r1.b.distance_km} km); explanation says why`);
  await lab(A, { north: 2 });
  check((await rank(req(), peak)).a.eta_min > (await rank(req(), night)).a.eta_min, 'Same trip gets a longer ETA (lower travel score) in peak traffic than at night');

  // ───────────────── 2. BED AVAILABILITY ─────────────────
  section('2. Bed availability (resource score)');
  await lab(A, { north: 3, icu: 1 }); await lab(B, { north: -3, icu: 4 });
  let r2 = await rank();
  check(r2.a.distance_km === r2.b.distance_km, `Both hospitals placed at the same distance (${r2.a.distance_km} km) so only beds differ`);
  check(near(r2.a.scores.resource, 0.7 + 0.3 * 1 / 5) && near(r2.b.scores.resource, 0.7 + 0.3 * 4 / 5),
    `Resource score = 0.7 + 0.3 × free/5 (1 free → ${r2.a.scores.resource}, 4 free → ${r2.b.scores.resource})`);
  check(r2.pos(B) < r2.pos(A), 'More free ICU beds ranks higher when everything else is equal');
  await lab(A, { north: 3, icu: 5 }); await lab(B, { north: -3, icu: 20 });
  r2 = await rank();
  check(r2.a.scores.resource === 1 && r2.b.scores.resource === 1, 'Headroom caps at 5 free beds: 5 free and 20 free both score 1.0 (spare beds beyond 5 do not outweigh distance)');
  await lab(A, { north: 3, icu: 0 });
  r2 = await rank();
  check(!r2.a.eligible && r2.a.missing.some(m => /ICU needs 1, 0 available/.test(m)), 'Zero free ICU beds → not eligible, reason shown ("ICU needs 1, 0 available")');
  await lab(A, { north: 3, icu: 1 });
  r2 = await rank(req({ beds_required: 2 }));
  check(!r2.a.eligible && r2.b.eligible, 'Needs 2 beds, only 1 free → not eligible (the one with 20 free still is)');
  await lab(A, { north: 3, icu: 3, general: 0 });
  check((await rank()).a.eligible && !(await rank(req({ requirements: {} }))).a.eligible, 'The right bed type is checked: ICU case ignores general beds, a general-bed case needs general beds');
  await lab(A, { north: 3, icu: 1 });
  const beforeLive = (await rank()).a.scores.resource;
  await updateHospitalResources(A, { icu: 4 }, { source: 'Hospital Staff' });
  const liveRows = await rankHospitals(req(), { at: AT });
  check(liveRows.find(x => x.hospital_id === A).scores.resource > beforeLive, `A bed update from hospital staff changes the very next ranking (resource ${beforeLive} → ${liveRows.find(x => x.hospital_id === A).scores.resource})`);

  // ───────────────── 3. DATA FRESHNESS ─────────────────
  section('3. Data freshness');
  const f = (m) => getFreshness(new Date(NOW - m * 60000).toISOString(), NOW);
  check(f(0).score === 1 && near(f(45).score, Math.exp(-1), 0.001) && near(f(90).score, Math.exp(-2), 0.001),
    `Score = e^(−age/45): 0 min → 1.000, 45 min → ${f(45).score}, 90 min → ${f(90).score}`);
  check(f(5).status === 'fresh' && f(5.1).status === 'aging' && f(30).status === 'aging' && f(30.1).status === 'stale',
    'Labels switch exactly at the limits: ≤5 min fresh, ≤30 min aging, >30 min stale');
  check(f(60).needs_reconfirmation && !f(20).needs_reconfirmation, 'Stale data is flagged "needs reconfirmation"');
  await lab(A, { north: 3, ageMin: 2 }); await lab(B, { north: -3, ageMin: 90 });
  let r3 = await rank();
  check(r3.pos(A) < r3.pos(B) && near(r3.a.scores.final - r3.b.scores.final, 0.2 * (r3.a.scores.freshness - r3.b.scores.freshness), 0.002),
    `Same distance and beds: data 2 min old (${r3.a.scores.freshness}) beats 90 min old (${r3.b.scores.freshness}); gap = 0.2 × freshness gap`);
  check(/STALE/.test(r3.b.explanation) && /confirm with hospital/.test(r3.b.explanation), 'Stale hospital\'s explanation tells the dispatcher to confirm first');
  await updateHospitalResources(B, {}, { source: 'Hospital Staff' });        // "Confirm all numbers"
  const bNow = (await rankHospitals(req(), { at: AT })).find(x => x.hospital_id === B);
  check(bNow.freshness.status === 'fresh' && bNow.freshness.age_minutes < 1, '"Confirm all numbers" resets the age to 0 (stale → fresh)');
  // Trade-off: how much closer must a stale (90 min) hospital be to beat a fresh one?
  const gapMin = 0.2 * (f(0).score - f(90).score) / 0.3 * 60;
  console.log(`   ℹ️  A 90-min-stale hospital only wins if it is ≥ ${gapMin.toFixed(1)} min closer than a fresh one (fresh data is worth ${(gapMin).toFixed(0)} min of driving).`);

  // ───────────────── 4. TWO REQUESTS, ONE BED ─────────────────
  section('4. Two emergencies competing for the same last bed');
  const H = 'HSP-003';
  const iso = (ms) => new Date(ms).toISOString();
  // Only H has an ICU bed in the whole city; the ambulance simulator is off
  async function reset({ icuAtH = 1, alt = null } = {}) {
    await db.prepare(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_status IN ('PENDING','CONFIRMED')`).run();
    await db.prepare(`UPDATE emergency_requests SET request_status = 'COMPLETED' WHERE request_status IN ('CREATED','MATCHING','ASSIGNED','IN_TRANSIT','NO_MATCH')`).run();
    await db.prepare('UPDATE hospital_resources SET available_icu_beds = 0, last_updated_timestamp = ?').run(iso(Date.now()));
    await lab(H, { north: 1, icu: icuAtH, ageMin: 0 });
    if (alt) await lab(alt, { north: -2, icu: 1, ageMin: 0 });
  }
  const newReq = async (condition, at, extra = {}) => {
    const r = (await createRequest({ emergency_type: 'Road Accident', patient_condition: condition, patient_age: 40, location: { lat: P.lat, lng: P.lng }, requirements: { icu: true }, ...extra })).request;
    await db.prepare('UPDATE emergency_requests SET request_timestamp = ? WHERE request_id = ?').run(iso(at), r.request_id);
    return r.request_id;
  };
  const inbox = async () => (await rs.listForHospital(H)).filter(i => i.status === 'PENDING');
  const resOf = async (rid) => (await inbox()).find(i => i.request.request_id === rid).reservation_id;
  const t0 = Date.now() - 60000;

  // 4a. Everything the same, 2 seconds apart
  await reset();
  const x1 = await newReq('Critical', t0), x2 = await newReq('Critical', t0 + 2000);
  await rs.broadcast(x2); await rs.broadcast(x1);                                      // broadcast order does not matter
  let q = await inbox();
  check(q.length === 2 && q[0].request.request_id === x1 && q[0].queue.gets_bed && !q[1].queue.gets_bed,
    `Same condition, same place, 2 s apart → #${x1} (called first) is next in line for the only bed`);
  check(/waited longer|called in first/i.test(q[0].queue.reason) && q[1].queue.behind === x1, `Reason shown: "${q[0].queue.reason}"; #${x2} is marked as waiting behind it`);
  let blocked = null;
  try { await rs.respond(await resOf(x2), { action: 'accept', byHospital: H }); } catch (e) { blocked = e; }
  check(blocked?.details?.code === 'PRIORITY_CONFLICT' && (await getHospital(H)).resources.icu.available === 1,
    'Accepting the second patient first is stopped (409 PRIORITY_CONFLICT) and the bed stays free');
  await rs.respond(await resOf(x1), { action: 'accept', byHospital: H });
  check((await getRequest(x1)).status === 'ASSIGNED' && (await getHospital(H)).resources.icu.available === 0, `#${x1} admitted; ICU at H 1 → 0`);
  check(!(await inbox()).some(i => i.request.request_id === x2) && ['NO_MATCH', 'MATCHING'].includes((await getRequest(x2)).status),
    `#${x2} is released at once (no bed left) instead of waiting 10 min for the hold to expire, and searches again (${(await getRequest(x2)).status})`);

  // 4b. The more serious patient goes first even if they called later
  await reset();
  const s1 = await newReq('Serious', t0), s2 = await newReq('Critical', t0 + 30000);
  await rs.broadcast(s1); await rs.broadcast(s2);
  q = await inbox();
  check(q[0].request.request_id === s2 && q[0].queue.gets_bed && /critical/i.test(q[0].queue.reason),
    `Critical patient (#${s2}, called 30 s later) goes ahead of a Serious one (#${s1})`);

  // 4c. Same condition: the patient with NO other hospital gets the bed
  await reset({ alt: 'HSP-004' });
  const o1 = await newReq('Critical', t0);
  await rs.broadcast(o1);                                                        // o1 → H and HSP-004 (both have a bed)
  await db.prepare('UPDATE hospital_resources SET available_icu_beds = 0 WHERE hospital_id = ?').run('HSP-004');
  const o2 = await newReq('Critical', t0 + 5000);
  await rs.broadcast(o2);                                                        // o2 → H only (HSP-004 is full right now)
  await db.prepare('UPDATE hospital_resources SET available_icu_beds = 1 WHERE hospital_id = ?').run('HSP-004');
  q = await inbox();
  check(q[0].request.request_id === o2 && /only option|no other/i.test(q[0].queue.reason),
    `Same condition: #${o2} (H is its only option) goes ahead of #${o1} (also waiting on another hospital with a free bed)`);

  // 4d. Enough beds for both → no conflict
  await reset({ icuAtH: 2 });
  const e1 = await newReq('Critical', t0), e2 = await newReq('Critical', t0 + 1000);
  await rs.broadcast(e1); await rs.broadcast(e2);
  q = await inbox();
  check(q.every(i => i.queue.gets_bed), '2 free beds, 2 patients → both can be accepted in any order');
  await rs.respond(await resOf(e2), { action: 'accept', byHospital: H });
  await rs.respond(await resOf(e1), { action: 'accept', byHospital: H });
  check((await getHospital(H)).resources.icu.available === 0 && (await getRequest(e1)).status === 'ASSIGNED' && (await getRequest(e2)).status === 'ASSIGNED', 'Both admitted, ICU 2 → 0, never below zero');

  // 4e. Doctor's override
  await reset();
  const v1 = await newReq('Critical', t0), v2 = await newReq('Critical', t0 + 1000);
  await rs.broadcast(v1); await rs.broadcast(v2);
  await rs.respond(await resOf(v2), { action: 'accept', byHospital: H, override: true });
  check((await getRequest(v2)).status === 'ASSIGNED' && !(await inbox()).some(i => i.request.request_id === v1),
    'Doctor can still override ("Accept anyway"); the other patient is released to search elsewhere');

  // 4f. Called at the same second: the closer patient goes first; a perfect tie falls back to the request number
  await reset();
  const far = await newReq('Critical', t0, { location: { lat: P.lat - 3 * KM_LAT, lng: P.lng } });
  const close = await newReq('Critical', t0, { location: { lat: P.lat + 0.5 * KM_LAT, lng: P.lng } });
  await rs.broadcast(far); await rs.broadcast(close);
  q = await inbox();
  check(q[0].request.request_id === close && /closer/.test(q[0].queue.reason), `Same second, same condition → the closer patient goes first ("${q[0].queue.reason}")`);
  await reset();
  const t1 = await newReq('Critical', t0), t2 = await newReq('Critical', t0);
  await rs.broadcast(t2); await rs.broadcast(t1);
  q = await inbox();
  check(q[0].request.request_id === t1 && /request number/.test(q[0].queue.reason), 'Identical on every count → decided by request number, never at random');
} catch (e) {
  console.error(e); failures++;
} finally {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: distance, bed availability, freshness and same-bed priority all verified');
process.exit(failures ? 1 : 0);
