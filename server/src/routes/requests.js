// Emergency request endpoints (dispatcher side)
import { Router } from 'express';
import { createRequest, getRequestDetail, listRequests, getRequestSummary } from '../services/requestService.js';
import { ApiError } from '../utils/errors.js';
import { matchRequest, getSavedRankings } from '../services/rankingService.js';
import { handoff } from '../services/handoffService.js';
import { broadcast, withdrawAll } from '../services/reservationService.js';
import { lastPosition } from '../services/tracking.js';
import { admissionView, saveAdmission } from '../services/admissionService.js';
import { requireRole } from '../services/authService.js';
import {
  EMERGENCY_TYPES, SEVERITIES, PATIENT_CONDITIONS, SPECIALISTS, REQUEST_STATUSES, REQUIREMENT_KEYS,
  TYPE_DEFAULTS, SEVERITY_DEFAULTS,
} from '../services/requestConfig.js';

const router = Router();

// GET /api/requests/meta → everything the "New emergency" form needs (dropdowns + smart defaults)
router.get('/meta', async (req, res) => {
  res.json({
    emergency_types: EMERGENCY_TYPES,
    severities: SEVERITIES,
    conditions: PATIENT_CONDITIONS,
    specialists: SPECIALISTS,
    requirements: REQUIREMENT_KEYS,
    statuses: REQUEST_STATUSES,
    type_defaults: TYPE_DEFAULTS,
    severity_defaults: SEVERITY_DEFAULTS,
  });
});

// GET /api/requests/summary → counts for the dashboard
router.get('/summary', async (req, res) => res.json(await getRequestSummary()));

// GET /api/requests?active=true&since_minutes=60&severity=Critical&status=CREATED,MATCHING&sort=priority|recent&limit=50&offset=0
router.get('/', async (req, res) => {
  const { status, severity, emergency_type, active, since_minutes, sort, limit, offset } = req.query;
  res.json(await listRequests({ status, severity, emergency_type, active: active === 'true', since_minutes, sort, limit, offset }));
});

// GET /api/requests/:id → request + reservations + handover timeline
router.get('/:id', async (req, res) => {
  const detail = await getRequestDetail(req.params.id);
  if (!detail) throw new ApiError(404, `Request ${req.params.id} not found`);
  res.json(detail);
});

// POST /api/requests/:id/match → run the ranking engine now, save results, status → MATCHING / NO_MATCH
router.post('/:id/match', async (req, res) => res.json(await matchRequest(req.params.id)));

// GET /api/requests/:id/rankings → last saved ranking (dataset requests have one too)
router.get('/:id/rankings', async (req, res) => res.json(await getSavedRankings(req.params.id)));

// POST /api/requests/:id/broadcast { max?, hospital_id? } → alert the next wave (best hospitals first, close to the best);
// with hospital_id: alert just that hospital (dispatcher's pick, its accept is confirmed at once).
router.post('/:id/broadcast', requireRole('dispatcher'), async (req, res) => {
  res.status(201).json(await broadcast(req.params.id, { max: req.body?.max, hospital_id: req.body?.hospital_id || null }));
});

// POST /api/requests/:id/withdraw → dispatcher cancels the request at every hospital still deciding
router.post('/:id/withdraw', requireRole('dispatcher'), async (req, res) => res.json(await withdrawAll(req.params.id)));

// GET /api/requests/:id/position → last live ambulance position (GPS or simulated), or null
router.get('/:id/position', async (req, res) => res.json({ position: await lastPosition(req.params.id) }));

// GET /api/requests/:id/admission?ward=ICU → saved admission or a suggested ward / room / bed (receiving hospital only)
router.get('/:id/admission', requireRole('hospital'), async (req, res) => res.json(await admissionView(req.params.id, req.user, { ward: req.query.ward })));

// PUT /api/requests/:id/admission { ward, room, bed, attending, nurse, resources: { icu: 1 }, services: [...] }
// Resource changes update the hospital's live inventory immediately (409 NO_CAPACITY if none free).
router.put('/:id/admission', requireRole('hospital'), async (req, res) => res.json(await saveAdmission(req.params.id, req.body, req.user)));

// POST /api/requests/:id/handoff { step: "depart" | "arrive" | "complete" } → ambulance / hospital progress
router.post('/:id/handoff', requireRole('dispatcher', 'hospital'), async (req, res) => {
  res.json(await handoff(req.params.id, req.body?.step, req.user));
});

// POST /api/requests → dispatcher logs a new emergency
router.post('/', requireRole('dispatcher'), async (req, res) => {
  res.status(201).json(await createRequest(req.body, { owner: req.user.id }));
});

export default router;
