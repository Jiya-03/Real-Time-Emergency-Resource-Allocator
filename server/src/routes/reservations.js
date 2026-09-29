// Bed reservations: dispatcher holds, hospital accepts/rejects, holds expire
import { Router } from 'express';
import { reserve, respond, cancel, listForHospital, historyForHospital, REJECT_REASONS, HOLD_MINUTES, CONFIRMED_HOLD_MINUTES,
  WAVE_SIZE, ETA_BAND_MIN, SCORE_BAND, RESPONSE_SECONDS, BETTER_WAIT_SECONDS } from '../services/reservationService.js';
import { requireRole } from '../services/authService.js';
import { ApiError } from '../utils/errors.js';

const router = Router();

// GET /api/reservations/meta → reject reasons + hold times (for the hospital UI)
router.get('/meta', async (req, res) => res.json({
  reject_reasons: REJECT_REASONS, hold_minutes: HOLD_MINUTES, confirmed_hold_minutes: CONFIRMED_HOLD_MINUTES,
  cascade: { wave_size: WAVE_SIZE, eta_band_min: ETA_BAND_MIN, score_band: SCORE_BAND, response_seconds: RESPONSE_SECONDS, better_wait_seconds: BETTER_WAIT_SECONDS },
}));

// GET /api/reservations?status=PENDING,CONFIRMED  → the signed-in hospital's inbox
router.get('/', requireRole('hospital', 'dispatcher'), async (req, res) => {
  const hospitalId = req.user.role === 'hospital' ? req.user.hospital_id : req.query.hospital_id;
  if (!hospitalId) throw new ApiError(400, 'hospital_id is required');
  res.json({ hospital_id: hospitalId, items: await listForHospital(hospitalId, { status: req.query.status }) });
});

// GET /api/reservations/history?hours=24 → every case this hospital was contacted for
router.get('/history', requireRole('hospital'), async (req, res) => {
  res.json({ hospital_id: req.user.hospital_id, items: await historyForHospital(req.user.hospital_id, { hours: Math.min(Number(req.query.hours) || 24, 168) }) });
});

// POST /api/reservations { request_id, hospital_id } → hold beds (dispatcher)
router.post('/', requireRole('dispatcher'), async (req, res) => {
  res.status(201).json(await reserve(req.body || {}));
});

// PATCH /api/reservations/:id { action: "accept" | "reject", reason, override } → hospital answers
// (override: true = accept even though another patient is ahead in line for the last bed)
router.patch('/:id', requireRole('hospital'), async (req, res) => {
  const { action, reason, override } = req.body || {};
  res.json(await respond(req.params.id, { action, reason, override: override === true, byHospital: req.user.hospital_id }));
});

// POST /api/reservations/:id/cancel → dispatcher releases the hold
router.post('/:id/cancel', requireRole('dispatcher'), async (req, res) => res.json(await cancel(req.params.id)));

export default router;
