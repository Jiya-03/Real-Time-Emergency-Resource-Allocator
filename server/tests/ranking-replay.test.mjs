// Replays all 1,920 reference rankings from the ERRA dataset through OUR ranking engine.
// Run: npm run test:ranking
//
// Pass criteria:
//  1. Per-hospital scores (eligibility, resource, freshness, final) match the reference ≥ 99.5%
//  2. Whenever our #1 differs from the reference #1, ours must be an eligible hospital with a
//     strictly higher score (we search every eligible hospital within 55 min, not just the 5 nearest).
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DB_PATH = path.join(os.tmpdir(), `erra-replay-${process.pid}.db`);
execSync('node src/db/seed.js --no-shift', { cwd: serverDir, env: process.env, stdio: 'ignore' });

const { default: db } = await import('../src/db/index.js');
const { rankHospitals } = await import('../src/services/rankingService.js');
const { getRequest } = await import('../src/services/requestService.js');

const SNAPSHOT = new Date('2026-09-28T12:00:00+05:30').getTime();
const ref = db.prepare('SELECT * FROM match_ranking_results ORDER BY request_id, rank').all();
const byReq = {};
for (const r of ref) (byReq[r.request_id] ||= []).push(r);

let rows = 0, match = 0, reqs = 0, sameTop = 0, betterTop = 0, worseTop = 0;
for (const [rid, list] of Object.entries(byReq)) {
  const req = getRequest(rid);
  const ours = rankHospitals(req, { now: SNAPSHOT, at: new Date(req.created_at) });
  const byHosp = Object.fromEntries(ours.map(o => [o.hospital_id, o]));
  for (const r of list) {
    rows++;
    const o = byHosp[r.hospital_id];
    if (o && o.eligible === !!r.eligibility
        && Math.abs(o.scores.resource - r.resource_match_score) <= 0.002
        && Math.abs(o.scores.freshness - r.freshness_score) <= 0.002
        && Math.abs(o.scores.final - r.final_suitability_score) <= 0.003) match++;
  }
  reqs++;
  const refTop = list[0];
  if (ours[0].hospital_id === refTop.hospital_id) sameTop++;
  else if (ours[0].eligible && (!refTop.eligibility || ours[0].scores.final > refTop.final_suitability_score)) betterTop++;
  else worseTop++;
}

const scoreRate = match / rows;
console.log(`Requests replayed:        ${reqs}`);
console.log(`Per-hospital score match: ${match}/${rows} (${(scoreRate * 100).toFixed(2)}%)`);
console.log(`Same #1 hospital:         ${sameTop}`);
console.log(`Better #1 found by us:    ${betterTop}`);
console.log(`Worse #1:                 ${worseTop}`);

const ok = scoreRate >= 0.995 && worseTop === 0;
console.log(ok ? '\n✅ PASS: ranking engine matches the reference model' : '\n❌ FAIL');
db.close();
for (const ext of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + ext, { force: true });
process.exit(ok ? 0 : 1);
