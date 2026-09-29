// Real driving times with live traffic, from Mapbox (Matrix API, profile driving-traffic).
// The ranking first estimates every hospital with straight-line distance × 1.35 and fixed traffic
// speeds (fast, free). Then the TOP 5 get their real road time from Mapbox in ONE request, and the
// ranking is recomputed with those. Rivers, bridges, one-ways and jams are now part of the ranking.
//
// No MAPBOX_TOKEN, no network or Mapbox slow (> 2.5 s)? The estimate is used, the dispatcher is
// never blocked. Results are cached for 3 minutes per pickup point + hospital.
const TTL_MS = 3 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.ROAD_ETA_TIMEOUT_MS) || 2500;
export const ROAD_TOP_N = 5;

const cache = new Map();              // "lat,lng|hospital" → { duration_min, distance_km, at }
let fetcher = (...a) => fetch(...a);
const status = { enabled: false, calls: 0, ok: 0, failed: 0, cached: 0, last_error: null, last_ok_at: null };

export const setRoadEtaFetcher = (f) => { fetcher = f; cache.clear(); };   // tests: fake Mapbox
export const roadEtaStatus = () => ({ ...status, enabled: !!token() });
const token = () => process.env.MAPBOX_TOKEN || '';
const key = (o, h) => `${o.lat.toFixed(4)},${o.lng.toFixed(4)}|${h.hospital_id}`;

/**
 * Live-traffic driving time from `origin` to each hospital (up to 9 per Mapbox call; we use 5).
 * hospitals: [{ hospital_id, location: { lat, lng } }]
 * Returns Map hospital_id → { duration_min, distance_km, source: 'mapbox' } (missing = no data).
 */
export async function getRoadEtas(origin, hospitals) {
  const out = new Map();
  if (!token() || !hospitals.length) return out;
  const now = Date.now();
  const todo = [];
  for (const h of hospitals.slice(0, 9)) {
    const c = cache.get(key(origin, h));
    if (c && now - c.at < TTL_MS) { out.set(h.hospital_id, c); status.cached++; } else todo.push(h);
  }
  if (!todo.length) return out;

  const coords = [origin, ...todo.map(h => h.location)].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic/${coords}` +
    `?sources=0&destinations=${todo.map((_, i) => i + 1).join(';')}&annotations=duration,distance&access_token=${encodeURIComponent(token())}`;
  status.calls++;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json();
    if (!res.ok || body.code !== 'Ok') throw new Error(body.message || body.code || `HTTP ${res.status}`);
    todo.forEach((h, i) => {
      const sec = body.durations?.[0]?.[i], m = body.distances?.[0]?.[i];
      if (typeof sec !== 'number') return;                           // no road route found
      const v = { duration_min: Math.round(sec / 6) / 10, distance_km: typeof m === 'number' ? Math.round(m / 10) / 100 : null, source: 'mapbox', at: now };
      cache.set(key(origin, h), v);
      out.set(h.hospital_id, v);
    });
    status.ok++; status.last_ok_at = new Date().toISOString(); status.last_error = null;
  } catch (e) {
    status.failed++; status.last_error = e.name === 'TimeoutError' ? 'Mapbox timed out' : e.message;
  }
  return out;
}
