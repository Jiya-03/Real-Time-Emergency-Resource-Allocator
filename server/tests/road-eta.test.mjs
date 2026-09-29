// Real road travel times (Mapbox, live traffic) for the top 5 hospitals. Run: npm run test:road
// Mapbox is replaced by a fake so the test runs offline and we control the traffic.
//
//   A is 2 km away as the crow flies but the road crosses the river (25 min in traffic);
//   B is 4 km away with a clear road (8 min). The estimate ranks A first, real roads rank B first.
import './_env.mjs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `erra-road-${process.pid}.db`);
Object.assign(process.env, { DB_PATH, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MAPBOX_TOKEN: 'pk.test-token', ROAD_ETA_TIMEOUT_MS: '400' });
execSync('node src/db/seed.js', { cwd: serverDir, env: { ...process.env }, stdio: 'ignore' });

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };

try {
  const { default: db } = await import('../src/db/index.js');
  const { matchRequest } = await import('../src/services/rankingService.js');
  const { createRequest } = await import('../src/services/requestService.js');
  const road = await import('../src/services/roadEta.js');

  const P = { lat: 18.5204, lng: 73.8567 };
  const KM = 1 / 111.195;
  const A = 'HSP-001', B = 'HSP-002';
  await db.prepare('UPDATE hospital_resources SET available_icu_beds = 0').run();
  for (const [h, north] of [[A, 2], [B, -4]]) {
    await db.prepare('UPDATE hospitals SET latitude = ?, longitude = ?, active_status = 1, emergency_department = 1 WHERE hospital_id = ?').run(P.lat + north * KM, P.lng, h);
    await db.prepare('UPDATE hospital_resources SET total_icu_beds = 20, available_icu_beds = 5, last_updated_timestamp = ? WHERE hospital_id = ?').run(new Date().toISOString(), h);
  }
  const newReq = async () => (await createRequest({ emergency_type: 'Other', patient_condition: 'Critical', patient_age: 50, location: P, requirements: { icu: true } })).request.request_id;

  // fake Mapbox Matrix API
  const calls = [];
  let mode = 'ok';
  const TRAFFIC = { [A]: { min: 25, km: 9.4 }, [B]: { min: 8, km: 5.6 } };
  road.setRoadEtaFetcher(async (url, { signal } = {}) => {
    calls.push(url);
    if (mode === 'down') return { ok: false, status: 503, json: async () => ({ message: 'Service unavailable' }) };
    if (mode === 'slow') await new Promise((res, rej) => { const t = setTimeout(res, 2000); signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }); });
    const coords = decodeURIComponent(url.split('/driving-traffic/')[1].split('?')[0]).split(';').slice(1);
    const ids = coords.map(c => { const [lng, lat] = c.split(',').map(Number); return (Math.abs(lat - (P.lat + 2 * KM)) < 1e-4) ? A : (Math.abs(lat - (P.lat - 4 * KM)) < 1e-4) ? B : null; });
    return { ok: true, status: 200, json: async () => ({ code: 'Ok',
      durations: [ids.map(id => (TRAFFIC[id]?.min ?? 20) * 60)], distances: [ids.map(id => (TRAFFIC[id]?.km ?? 10) * 1000)] }) };
  });
  const pos = (m, id) => m.rankings.findIndex(r => r.hospital_id === id);
  const row = (m, id) => m.rankings.find(r => r.hospital_id === id);

  // 1. live traffic changes the order
  let m = await matchRequest(await newReq());
  check(calls.length === 1 && /driving-traffic/.test(calls[0]) && /sources=0/.test(calls[0]) && /annotations=duration,distance/.test(calls[0]),
    'One Mapbox Matrix call (driving-traffic profile) for the whole top 5');
  check(decodeURIComponent(calls[0].split('/driving-traffic/')[1].split('?')[0]).split(';').length === 6, 'It asks for exactly 5 hospitals (+ the pickup point)');
  check(row(m, B).eta_source === 'mapbox' && row(m, B).eta_min === 10 && row(m, A).eta_min === 27,
    `Real road times used: A ${row(m, A).eta_min} min (river crossing), B ${row(m, B).eta_min} min (8 + 2 min loading)`);
  check(pos(m, B) < pos(m, A), 'B (farther in a straight line, faster by road) now ranks above A');
  check(row(m, A).distance_km === 9.4 && /with live traffic/.test(row(m, A).explanation), 'Road distance and "with live traffic" shown in the explanation');
  check(/live traffic \(Mapbox\)/.test(m.summary.travel_times), `Summary says: "${m.summary.travel_times}"`);

  // 2. cache
  m = await matchRequest(await newReq());
  check(calls.length === 1 && row(m, B).eta_source === 'mapbox', 'Same pickup point within 3 min → answered from cache, no new Mapbox call');

  // 3. Mapbox down / slow → estimate, never blocked
  road.setRoadEtaFetcher((...a) => { mode = 'down'; return fakeOf(...a); });
  const fakeOf = async (url) => { calls.push(url); return { ok: false, status: 503, json: async () => ({ message: 'Service unavailable' }) }; };
  m = await matchRequest(await newReq());
  check(row(m, A).eta_source === 'estimate' && pos(m, A) < pos(m, B) && road.roadEtaStatus().last_error === 'Service unavailable',
    'Mapbox down → falls back to the distance estimate (A first again), error recorded');
  road.setRoadEtaFetcher(async (url, { signal } = {}) => new Promise((res, rej) => {
    const t = setTimeout(() => res({ ok: true, json: async () => ({ code: 'Ok', durations: [[]] }) }), 2000);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); });
  }));
  const t0 = Date.now();
  m = await matchRequest(await newReq());
  check(Date.now() - t0 < 1500 && row(m, A).eta_source === 'estimate' && road.roadEtaStatus().last_error === 'Mapbox timed out',
    `Mapbox slow → gives up after the time limit (${Date.now() - t0} ms) and uses the estimate`);

  // 4. no token → no call at all
  const n = calls.length;
  process.env.MAPBOX_TOKEN = '';
  m = await matchRequest(await newReq());
  check(calls.length === n && row(m, A).eta_source === 'estimate', 'No MAPBOX_TOKEN → estimate only, Mapbox never called');
} catch (e) {
  console.error(e); failures++;
} finally {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ PASS: top 5 ranked with real road times (live traffic), safe fallback to the estimate');
process.exit(failures ? 1 : 0);
