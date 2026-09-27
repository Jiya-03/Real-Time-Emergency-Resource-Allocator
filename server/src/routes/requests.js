// Emergency request endpoints (dispatcher side)
import { Router } from 'express';
import { createRequest, getRequestDetail, listRequests, getRequestSummary } from '../services/requestService.js';
import { ApiError } from '../utils/errors.js';
import { matchRequest, getSavedRankings } from '../services/rankingService.js';
import {
  EMERGENCY_TYPES, SEVERITIES, SPECIALISTS, REQUEST_STATUSES, REQUIREMENT_KEYS,
  TYPE_DEFAULTS, SEVERITY_DEFAULTS,
} from '../services/requestConfig.js';

const router = Router();

// GET /api/requests/meta → everything the "New emergency" form needs (dropdowns + smart defaults)
router.get('/meta', (req, res) => {
  res.json({
    emergency_types: EMERGENCY_TYPES,
    severities: SEVERITIES,
    specialists: SPECIALISTS,
    requirements: REQUIREMENT_KEYS,
    statuses: REQUEST_STATUSES,
    type_defaults: TYPE_DEFAULTS,
    severity_defaults: SEVERITY_DEFAULTS,
  });
});

// GET /api/requests/summary → counts for the dashboard
router.get('/summary', (req, res) => res.json(getRequestSummary()));

// GET /api/requests?active=true&since_minutes=60&severity=Critical&status=CREATED,MATCHING&sort=priority|recent&limit=50&offset=0
router.get('/', (req, res) => {
  const { status, severity, emergency_type, active, since_minutes, sort, limit, offset } = req.query;
  res.json(listRequests({ status, severity, emergency_type, active: active === 'true', since_minutes, sort, limit, offset }));
});

// GET /api/requests/:id → request + reservations + handover timeline
router.get('/:id', (req, res) => {
  const detail = getRequestDetail(req.params.id);
  if (!detail) throw new ApiError(404, `Request ${req.params.id} not found`);
  res.json(detail);
});

// POST /api/requests/:id/match → run the ranking engine now, save results, status → MATCHING / NO_MATCH
router.post('/:id/match', (req, res) => res.json(matchRequest(req.params.id)));

// GET /api/requests/:id/rankings → last saved ranking (dataset requests have one too)
router.get('/:id/rankings', (req, res) => res.json(getSavedRankings(req.params.id)));

// POST /api/requests → dispatcher logs a new emergency
router.post('/', (req, res) => {
  res.status(201).json(createRequest(req.body));
});

export default router;
