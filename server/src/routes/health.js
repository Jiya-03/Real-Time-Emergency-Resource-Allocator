// GET /api/health – quick check that the server and database are alive
import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

router.get('/', (req, res) => {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    db: {
      hospitals: count('hospitals'),
      requests: count('emergency_requests'),
      reservations: count('reservations'),
    },
  });
});

export default router;
