// Bed reservations: dispatcher holds, hospital accepts/rejects, holds expire
import { Router } from 'express';
import { reserve, respond, cancel, listForHospital, historyForHospital, REJECT_REASONS, HOLD_MINUTES, CONFIRMED_HOLD_MINUTES } from '../services/reservationService.js';
import { requireRole } from '../services/authService.js';
import { ApiError } from '../utils/errors.js';

const router = Router();

// GET /api/reservations/meta → reject reasons + hold times (for the hospital UI)
router.get('/meta', (req, res) => res.json({
  reject_reasons: REJECT_REASONS, hold_minutes: HOLD_MINUTES, confirmed_hold_minutes: CONFIRMED_HOLD_MINUTES,
}));

// GET /api/reservations?status=PENDING,CONFIRMED  → the signed-in hospital's inbox
router.get('/', requireRole('hospital', 'dispatcher'), (req, res) => {
  const hospitalId = req.user.role === 'hospital' ? req.user.hospital_id : req.query.hospital_id;
  if (!hospitalId) throw new ApiError(400, 'hospital_id is required');
  res.json({ hospital_id: hospitalId, items: listForHospital(hospitalId, { status: req.query.status }) });
});

// GET /api/reservations/history?hours=24 → every case this hospital was contacted for
router.get('/history', requireRole('hospital'), (req, res) => {
  res.json({ hospital_id: req.user.hospital_id, items: historyForHospital(req.user.hospital_id, { hours: Math.min(Number(req.query.hours) || 24, 168) }) });
});

// POST /api/reservations { request_id, hospital_id } → hold beds (dispatcher)
router.post('/', requireRole('dispatcher'), (req, res) => {
  res.status(201).json(reserve(req.body || {}));
});

// PATCH /api/reservations/:id { action: "accept" | "reject", reason } → hospital answers
router.patch('/:id', requireRole('hospital'), (req, res) => {
  const { action, reason } = req.body || {};
  res.json(respond(req.params.id, { action, reason, byHospital: req.user.hospital_id }));
});

// POST /api/reservations/:id/cancel → dispatcher releases the hold
router.post('/:id/cancel', requireRole('dispatcher'), (req, res) => res.json(cancel(req.params.id)));

export default router;
