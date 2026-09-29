// The Scenarios page: the problem statement's test cases, run live on a sandbox copy of the system.
// Every scenario drives the REAL API of the sandbox server (same code as the app) and reports each
// step as it happens, ending in PASS / FAIL.
import { getSandbox, SANDBOX_TIMERS } from './sandbox.js';
import { io as connectSocket } from 'socket.io-client';

const P = { lat: 18.5204, lng: 73.8567 };          // pickup point used by every scenario (central Pune)
const KM = 1 / 111.195;                             // degrees of latitude per km
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isoAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

export const SCENARIOS = [
  { id: 'stale', n: 1, title: 'Stale data', proves: 'Old availability data is ranked lower and flagged; confirming it restores the rank' },
  { id: 'double', n: 2, title: 'Double-booking', proves: '20 emergencies grab the LAST ICU bed at the same instant: exactly one gets it' },
  { id: 'accepts', n: 3, title: 'Two hospitals accept at once', proves: 'Conflicting simultaneous accepts: one winner, the other is stood down, no bed lost' },
  { id: 'onebed', n: 4, title: 'Two patients, one bed', proves: 'Conflicting requests for one bed: the more serious patient goes first' },
  { id: 'nobody', n: 5, title: 'Decline and no answer', proves: 'A decline or silence never leaves the patient stuck: the next hospitals are alerted' },
  { id: 'e2e', n: 6, title: 'Full workflow', proves: 'Assignment to handoff, end to end: log → rank → accept → route → arrive → bed → handover' },
];

// ───────────── scenario toolkit ─────────────
function toolkit(sb, emit) {
  const tokens = {};
  const sockets = [];
  let failed = 0;
  const ctx = {
    async api(method, url, body, token) {
      const res = await fetch(sb.base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async login(role, id) {
      tokens[id] ||= (await ctx.api('POST', '/api/auth/login', { role, identifier: id, password: 'demo' })).body.token;
      return tokens[id];
    },
    sql: (sql, ...params) => sb.raw.prepare(sql).run(...params),
    one: (sql, ...params) => sb.raw.prepare(sql).get(...params),
    async step(text, status = 'ok', detail) { emit('step', { text, status, detail }); await sleep(status === 'info' ? 350 : 250); },
    async check(ok, pass, fail, detail) { if (!ok) failed++; await ctx.step(ok ? pass : (fail || pass), ok ? 'ok' : 'fail', detail); return ok; },
    get failed() { return failed; },
    // Clean slate: no active emergencies, every hospital's ICU empty (scenarios then give beds to the ones they use)
    reset() {
      ctx.sql(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE reservation_status IN ('PENDING','CONFIRMED')`);
      ctx.sql(`UPDATE emergency_requests SET request_status = 'COMPLETED' WHERE request_status IN ('CREATED','MATCHING','ASSIGNED','IN_TRANSIT','NO_MATCH')`);
      ctx.sql(`UPDATE hospital_resources SET available_icu_beds = 0, last_updated_timestamp = ?`, new Date().toISOString());
      ctx.sql('DELETE FROM dispatch_marks');
    },
    // Put a hospital at a known distance north (+) / south (−) of the pickup point with fresh data
    place(hid, km, { icu = 3, ageMin = 0 } = {}) {
      ctx.sql('UPDATE hospitals SET latitude = ?, longitude = ?, active_status = 1, emergency_department = 1 WHERE hospital_id = ?', P.lat + km * KM, P.lng, hid);
      ctx.sql(`UPDATE hospital_resources SET total_icu_beds = MAX(total_icu_beds, ?), available_icu_beds = ?, last_updated_timestamp = ? WHERE hospital_id = ?`,
        icu, icu, isoAgo(ageMin), hid);
      return ctx.one('SELECT hospital_name AS n FROM hospitals WHERE hospital_id = ?', hid).n;
    },
    async newEmergency(condition = 'Critical', extra = {}) {
      const d = await ctx.login('dispatcher', 'DSP-7704');
      const r = await ctx.api('POST', '/api/requests', { emergency_type: 'Cardiac', patient_condition: condition, patient_age: 58, location: P, requirements: { icu: true }, ...extra }, d);
      return r.body.request.request_id;
    },
    icu: (hid) => ctx.one('SELECT available_icu_beds AS n FROM hospital_resources WHERE hospital_id = ?', hid).n,
    async pendingAt(hid, rid) {
      const t = await ctx.login('hospital', hid);
      return (await ctx.api('GET', '/api/reservations', null, t)).body.items?.find(i => i.request.request_id === rid && i.status === 'PENDING');
    },
    async socket(token) {
      const s = connectSocket(sb.base, { auth: token ? { token } : {}, transports: ['websocket'] });
      sockets.push(s);
      await new Promise((res) => s.on('connect', res));
      return s;
    },
    async until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; },
    close() { for (const s of sockets) s.close(); },
  };
  return ctx;
}

// ───────────── the scenarios ─────────────
const RUN = {
  // 1. Stale data
  async stale(t) {
    t.reset();
    const A = 'HSP-001', B = 'HSP-002';
    const nA = t.place(A, 2, { icu: 5 }), nB = t.place(B, -2.6, { icu: 5 });
    await t.step(`Setup: A = ${nA} (2 km), B = ${nB} (2.6 km). Same free ICU beds, both reporting live.`, 'info');
    const rid = await t.newEmergency();
    const rank = async () => (await t.api('POST', `/api/requests/${rid}/match`)).body.rankings;
    const at = (rows, id) => rows.find(r => r.hospital_id === id);
    let rows = await rank();
    await t.check(rows[0].hospital_id === A, `Emergency #${rid} ranked: A is #1 (score ${at(rows, A).scores.final.toFixed(3)} vs B ${at(rows, B).scores.final.toFixed(3)})`, `Expected A to rank first, got ${rows[0].hospital_name}`);

    t.sql('UPDATE hospital_resources SET last_updated_timestamp = ? WHERE hospital_id = ?', isoAgo(90), A);
    await t.step('A stops updating its beds: its data is now 90 minutes old', 'info');
    rows = await rank();
    const a = at(rows, A);
    await t.check(a.freshness.status === 'stale' && rows[0].hospital_id === B,
      `Re-ranked: A drops to #${a.rank} (freshness ${a.scores.freshness.toFixed(2)}, status STALE); B is now #1`,
      `Expected stale A to drop below B (A is #${a.rank}, ${a.freshness.status})`);
    await t.check(/confirm with hospital/i.test(a.explanation), 'The dispatcher is warned: "Availability data is stale, confirm with hospital before dispatch"');

    const hA = await t.login('hospital', A);
    const version = (await t.api('GET', `/api/hospitals/${A}`)).body.version;
    await t.api('POST', `/api/hospitals/${A}/confirm`, { version, source: 'Hospital Staff' }, hA);
    await t.step('A\'s staff press "Confirm all numbers"', 'info');
    rows = await rank();
    await t.check(rows[0].hospital_id === A && at(rows, A).freshness.status === 'fresh', 'Re-ranked: A is FRESH again and back at #1', 'Expected A back at #1 after confirming');
  },

  // 2. Double-booking
  async double(t) {
    t.reset();
    const H = 'HSP-003';
    const name = t.place(H, 1, { icu: 1 });
    await t.step(`Setup: ${name} has exactly 1 free ICU bed (no other hospital has any)`, 'info');
    const d = await t.login('dispatcher', 'DSP-7704');
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(await t.newEmergency());
    await t.step(`20 Critical emergencies logged (#${ids[0]} … #${ids[19]}), all needing that ICU bed`, 'info');
    const results = await Promise.all(ids.map(rid => t.api('POST', '/api/reservations', { request_id: rid, hospital_id: H }, d)));
    const won = results.filter(r => r.status === 201).length;
    const taken = results.filter(r => r.status === 409 && r.body.code === 'BED_TAKEN').length;
    await t.step('All 20 reserve the bed at the same instant', 'info');
    await t.check(won === 1 && taken === 19, `Result: ${won} reserved, ${taken} refused with "bed was just taken"`, `Expected 1 reserved / 19 refused, got ${won} / ${taken}`);
    await t.check(t.icu(H) === 0, `ICU beds at ${name}: 1 → 0 (never below zero)`, `ICU is ${t.icu(H)}, expected 0`);
    const holds = t.one(`SELECT COUNT(*) AS n FROM reservations WHERE hospital_id = ? AND resource_type = 'ICU' AND reservation_status IN ('PENDING','CONFIRMED')`, H).n;
    await t.check(holds === 1, 'Exactly one active hold exists for that bed in the database', `Found ${holds} active holds`,
      'Why: taking a bed is one conditional UPDATE … WHERE available_icu_beds >= 1 inside a transaction, so only one can succeed.');
  },

  // 3. Two hospitals accept at the same instant
  async accepts(t) {
    t.reset();
    const A = 'HSP-001', B = 'HSP-002';
    const nA = t.place(A, 1, { icu: 3 }), nB = t.place(B, -2.5, { icu: 3 });
    await t.step(`Setup: A = ${nA} (1 km), B = ${nB} (2.5 km), 3 ICU beds each`, 'info');
    const d = await t.login('dispatcher', 'DSP-7704');
    const rid = await t.newEmergency();
    const bc = (await t.api('POST', `/api/requests/${rid}/broadcast`, {}, d)).body;
    await t.check(bc.sent_to?.length === 2, `Emergency #${rid} alerted to both hospitals (wave ${bc.wave})`, 'Expected both hospitals to be alerted');
    const [ra, rb] = [await t.pendingAt(A, rid), await t.pendingAt(B, rid)];
    const [hA, hB] = [await t.login('hospital', A), await t.login('hospital', B)];
    const before = { A: t.icu(A), B: t.icu(B) };
    await t.step('Both hospitals press "Accept" at the same instant', 'info');
    await Promise.all([
      t.api('PATCH', `/api/reservations/${ra.reservation_id}`, { action: 'accept' }, hA),
      t.api('PATCH', `/api/reservations/${rb.reservation_id}`, { action: 'accept' }, hB),
    ]);
    await t.until(async () => (await t.api('GET', `/api/requests/${rid}`)).body.status === 'ASSIGNED');
    const det = (await t.api('GET', `/api/requests/${rid}`)).body;
    const accepted = det.workflow.filter(w => w.hospital_response === 'ACCEPTED');
    await t.check(accepted.length === 1, `Exactly ONE hospital got the patient: ${accepted[0]?.hospital_name}`, `Expected one winner, got ${accepted.length}`);
    await t.check(accepted[0]?.hospital_id === A, 'It is the better-ranked one (A): the best "yes" wins', 'Expected the better-ranked hospital to win');
    await t.check(det.workflow.find(w => w.hospital_id === B)?.hospital_response === 'WITHDRAWN', 'B was stood down automatically ("filled by another hospital")');
    await t.check(t.icu(A) === before.A - 1 && t.icu(B) === before.B, `Beds: A ${before.A} → ${t.icu(A)} (one used), B ${before.B} → ${t.icu(B)} (untouched)`, 'Bed counts are wrong');
  },

  // 4. Two patients, one bed
  async onebed(t) {
    t.reset();
    const H = 'HSP-003';
    const name = t.place(H, 1, { icu: 1 });
    await t.step(`Setup: ${name} has exactly 1 free ICU bed`, 'info');
    const d = await t.login('dispatcher', 'DSP-7704');
    const serious = await t.newEmergency('Serious');
    await sleep(1100);
    const critical = await t.newEmergency('Critical');
    await t.api('POST', `/api/requests/${serious}/broadcast`, { hospital_id: H }, d);
    await t.api('POST', `/api/requests/${critical}/broadcast`, { hospital_id: H }, d);
    await t.step(`Two patients wait on it: #${serious} (Serious, called first) and #${critical} (Critical, called 1 s later)`, 'info');
    const h = await t.login('hospital', H);
    const inbox = (await t.api('GET', '/api/reservations', null, h)).body.items.filter(i => i.status === 'PENDING');
    await t.check(inbox[0]?.request.request_id === critical && inbox[0].queue?.gets_bed,
      `Hospital inbox puts #${critical} (Critical) first: "${inbox[0]?.queue?.reason || ''}"`, 'Expected the Critical patient first in line');
    const s = inbox.find(i => i.request.request_id === serious);
    const tryS = await t.api('PATCH', `/api/reservations/${s.reservation_id}`, { action: 'accept' }, h);
    await t.check(tryS.status === 409 && tryS.body.code === 'PRIORITY_CONFLICT', 'Accepting the Serious patient first is blocked (the doctor can still override)', `Expected a block, got ${tryS.status}`);
    const c = inbox.find(i => i.request.request_id === critical);
    const okC = await t.api('PATCH', `/api/reservations/${c.reservation_id}`, { action: 'accept' }, h);
    await t.check(okC.status === 200 && t.icu(H) === 0, `#${critical} (Critical) admitted, ICU 1 → 0`, 'Accepting the Critical patient failed');
    const st = (await t.api('GET', `/api/requests/${serious}`)).body.status;
    await t.check(['MATCHING', 'NO_MATCH'].includes(st) && !(await t.pendingAt(H, serious)),
      `#${serious} is released at once to search elsewhere (status ${st}), not left waiting`, 'The Serious patient is still stuck at this hospital');
  },

  // 5. Decline and no answer
  async nobody(t) {
    t.reset();
    const hs = [['HSP-001', 1], ['HSP-002', -2], ['HSP-003', 3], ['HSP-005', -4.5]];
    const names = Object.fromEntries(hs.map(([h, km]) => [h, t.place(h, km, { icu: 3 })]));
    await t.step('Setup: 4 hospitals with free ICU beds, 1 to 4.5 km away', 'info');
    const d = await t.login('dispatcher', 'DSP-7704');
    const rid = await t.newEmergency();
    const bc = (await t.api('POST', `/api/requests/${rid}/broadcast`, {}, d)).body;
    const wave1 = bc.sent_to.map(x => x.hospital_id);
    await t.check(wave1.length === 3, `Wave 1: the best 3 are alerted (${wave1.map(h => names[h]).join(', ')})`, `Expected 3 hospitals in wave 1, got ${wave1.length}`);
    const [first, ...silent] = wave1;
    const r1 = await t.pendingAt(first, rid);
    await t.api('PATCH', `/api/reservations/${r1.reservation_id}`, { action: 'reject', reason: 'No Bed' }, await t.login('hospital', first));
    await t.step(`${names[first]} declines ("No Bed")`, 'info');
    await t.step(`${silent.map(h => names[h]).join(' and ')} don't answer… (sandbox timer ${SANDBOX_TIMERS.RESPONSE_SECONDS} s; 60 s in the real app)`, 'wait');
    const next = hs.map(([h]) => h).find(h => !wave1.includes(h));
    const moved = await t.until(async () => !!(await t.pendingAt(next, rid)), 15000);
    await t.check(moved, `No answer → wave 2 alerted automatically: ${names[next]}`, 'The next hospital was not alerted');
    const r4 = await t.pendingAt(next, rid);
    if (r4) await t.api('PATCH', `/api/reservations/${r4.reservation_id}`, { action: 'accept' }, await t.login('hospital', next));
    const det = (await t.api('GET', `/api/requests/${rid}`)).body;
    await t.check(det.status === 'ASSIGNED', `${names[next]} accepts → patient ASSIGNED. Nobody was left waiting.`, `Expected ASSIGNED, got ${det.status}`);
  },

  // 6. Full workflow, with live screens listening
  async e2e(t) {
    t.reset();
    const H = 'HSP-001';
    const name = t.place(H, 1.5, { icu: 4 });
    const d = await t.login('dispatcher', 'DSP-7704');
    const h = await t.login('hospital', H);
    const hospScreen = await t.socket(h), crewScreen = await t.socket(d);
    const heardH = [], heardD = [], pos = [];
    hospScreen.on('reservation:update', p => heardH.push(p));
    hospScreen.on('ambulance:position', p => pos.push(p));
    crewScreen.on('reservation:update', p => heardD.push(p));

    const rid = await t.newEmergency();
    await t.step(`1. Dispatcher logs emergency #${rid} (Cardiac · Critical · needs ICU)`);
    const m = (await t.api('POST', `/api/requests/${rid}/match`)).body;
    await t.check(m.rankings[0].hospital_id === H, `2. Ranked: #1 ${name} (${m.rankings[0].distance_km} km, ~${Math.round(m.rankings[0].eta_min)} min)`, 'Unexpected #1');
    await t.api('POST', `/api/requests/${rid}/broadcast`, {}, d);
    await t.check(await t.until(() => heardH.some(p => p.action === 'held' && p.request?.request_id === rid)), '3. Alert sent: the hospital screen rings (live)', 'Hospital screen did not get the alert');
    const icu0 = t.icu(H);
    const res = await t.pendingAt(H, rid);
    await t.api('PATCH', `/api/reservations/${res.reservation_id}`, { action: 'accept' }, h);
    await t.check(await t.until(() => heardD.some(p => p.action === 'accepted' && p.request?.request_id === rid)) && t.icu(H) === icu0 - 1,
      `4. Hospital accepts: bed locked (ICU ${icu0} → ${t.icu(H)}), the crew screen hears "accepted"`, 'Accept was not confirmed');
    await t.api('POST', `/api/requests/${rid}/handoff`, { step: 'depart' }, d);
    crewScreen.emit('ambulance:position', { request_id: rid, hospital_id: H, lat: P.lat + 0.004, lng: P.lng, source: 'gps', eta_min: 4 });
    await t.check(await t.until(() => pos.some(p => p.request_id === rid)), '5. Ambulance departs: its GPS position appears on the hospital\'s map', 'Position did not reach the hospital');
    await t.api('POST', `/api/requests/${rid}/handoff`, { step: 'arrive' }, h);
    await t.step('6. Ambulance arrives at the bay');
    const view = (await t.api('GET', `/api/requests/${rid}/admission`, null, h)).body.admission;
    await t.api('PUT', `/api/requests/${rid}/admission`, { ward: view.ward, room: view.room, bed: view.bed, attending: 'Dr. Mehta', resources: view.resources }, h);
    await t.step(`7. Bed allocated: ${view.ward} · Room ${view.room} · Bed ${view.bed}`);
    const done = await t.api('POST', `/api/requests/${rid}/handoff`, { step: 'complete' }, h);
    const fin = (await t.api('GET', `/api/requests/${rid}`)).body;
    await t.check(done.status === 200 && fin.status === 'COMPLETED' && fin.admission?.admitted_at,
      `8. Handover complete: #${rid} is COMPLETED and admitted`, `Handover failed (${done.body.error || fin.status})`);
  },
};

/** Run one scenario (or 'all'); `emit(event, data)` streams progress to the page. */
export async function runScenario(id, emit) {
  const list = id === 'all' ? SCENARIOS : SCENARIOS.filter(s => s.id === id);
  if (!list.length) throw new Error(`Unknown scenario "${id}"`);
  const t0 = Date.now();
  emit('status', { text: 'Preparing a sandbox copy of the system (fresh dataset; your real data is not touched)…' });
  const sb = await getSandbox();
  emit('status', { text: `Sandbox ready (${((Date.now() - t0) / 1000).toFixed(1)} s)` });
  const summary = [];
  for (const s of list) {
    const started = Date.now();
    emit('start', { id: s.id });
    const t = toolkit(sb, (ev, data) => emit(ev, { ...data, id: s.id }));
    let error = null;
    try { await RUN[s.id](t); } catch (e) { error = e.message; await t.step(`Error: ${e.message}`, 'fail'); }
    finally { t.close(); }
    const pass = !error && t.failed === 0;
    summary.push({ id: s.id, pass });
    emit('done', { id: s.id, pass, ms: Date.now() - started });
  }
  emit('end', { pass: summary.every(x => x.pass), results: summary, ms: Date.now() - t0 });
}
