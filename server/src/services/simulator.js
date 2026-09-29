// Live availability simulator.
// Every few seconds a few "live-feed" hospitals admit or discharge patients,
// so bed counts change on everyone's screen in real time.
//
// Only hospitals whose data was FRESH when the server started have a live feed.
// Aging/stale hospitals are left alone on purpose: they represent hospitals that
// stopped reporting, which is exactly the stale-data scenario we must demo.
import db from '../db/index.js';
import { RESOURCE_KEYS, RESOURCES } from './resources.js';
import { getFreshness } from './freshness.js';
import { updateHospitalResources } from './hospitalService.js';
import bus, { EVENTS } from '../events.js';

const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS) || 5000;

let timer = null;
let liveFeed = [];
let ticks = 0;

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function pickLiveFeedHospitals() {
  return (await db.prepare(`
    SELECT r.hospital_id, r.last_updated_timestamp
    FROM hospital_resources r JOIN hospitals h ON h.hospital_id = r.hospital_id
    WHERE h.active_status = 1`).all())
    .filter(r => getFreshness(r.last_updated_timestamp).status === 'fresh')
    .map(r => r.hospital_id);
}

let busy = false;
async function tick() {
  if (busy) return;                     // previous tick still running (slow remote database)
  busy = true;
  try { await tickOnce(); } finally { busy = false; }
}

async function tickOnce() {
  ticks++;
  const count = Math.min(rand(1, 3), liveFeed.length);
  const chosen = [...liveFeed].sort(() => Math.random() - 0.5).slice(0, count);

  for (const id of chosen) {
    const row = await db.prepare('SELECT * FROM hospital_resources WHERE hospital_id = ?').get(id);
    // Only resources the hospital actually has (e.g. some have 0 ventilators)
    const key = pick(RESOURCE_KEYS.filter(k => row[RESOURCES[k].total] > 0));
    if (!key) continue;
    const { total, available } = RESOURCES[key];
    // Slight bias toward admissions (beds filling up) like a real busy shift
    const delta = pick([-2, -1, -1, 1, 1]);
    const next = Math.max(0, Math.min(row[total], row[available] + delta));
    if (next === row[available]) continue;
    try {
      await updateHospitalResources(id, { [key]: next }, { source: 'Simulation' });
    } catch (err) {
      console.warn(`[simulator] skipped ${id}: ${err.message}`);
    }
  }
}

export async function startSimulator() {
  if (timer) return getSimulatorStatus();
  liveFeed = await pickLiveFeedHospitals();
  timer = setInterval(() => tick().catch(e => console.warn('[simulator]', e.message)), INTERVAL_MS);
  console.log(`🔄 Simulator started: ${liveFeed.length} live-feed hospitals, every ${INTERVAL_MS / 1000}s`);
  bus.emit(EVENTS.SIMULATOR_STATUS, getSimulatorStatus());
  return getSimulatorStatus();
}

export function stopSimulator() {
  if (timer) clearInterval(timer);
  timer = null;
  console.log('⏸️  Simulator stopped');
  bus.emit(EVENTS.SIMULATOR_STATUS, getSimulatorStatus());
  return getSimulatorStatus();
}

export function getSimulatorStatus() {
  return { running: !!timer, interval_ms: INTERVAL_MS, live_feed_hospitals: liveFeed, ticks };
}
