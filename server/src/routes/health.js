// GET /api/health – quick check that the server and database are alive
import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

const TABLES = [
  'hospitals', 'hospital_resources', 'hospital_services', 'ambulances',
  'emergency_requests', 'reservations', 'emergency_workflow_handover',
  'resource_update_history', 'match_ranking_results',
];

router.get('/', async (req, res) => {
  const counts = {};
  for (const t of TABLES) counts[t] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  res.json({ status: 'ok', time: new Date().toISOString(), db: counts });
});

export default router;
