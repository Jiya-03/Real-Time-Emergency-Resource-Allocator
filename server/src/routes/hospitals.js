// Hospital endpoints: live availability, freshness, staff updates
import { Router } from 'express';
import {
  listHospitals, getHospital, getSummary, getHistory, updateHospitalResources, ApiError,
} from '../services/hospitalService.js';
import { RESOURCE_KEYS, SERVICES } from '../services/resources.js';

const router = Router();

// GET /api/hospitals?freshness=stale&has=icu&service=cardiology&accepting=true
router.get('/', (req, res) => {
  const { freshness, has, service, accepting } = req.query;
  if (freshness && !['fresh', 'aging', 'stale'].includes(freshness))
    throw new ApiError(400, 'freshness must be fresh, aging or stale');
  if (has && !RESOURCE_KEYS.includes(has))
    throw new ApiError(400, `has must be one of: ${RESOURCE_KEYS.join(', ')}`);
  if (service && !SERVICES.includes(service))
    throw new ApiError(400, `service must be one of: ${SERVICES.join(', ')}`);

  const hospitals = listHospitals({
    freshness, has, service,
    accepting: accepting === undefined ? undefined : accepting === 'true',
  });
  res.json({ count: hospitals.length, hospitals });
});

// GET /api/hospitals/summary  → network totals for the dashboard header
router.get('/summary', (req, res) => res.json(getSummary()));

// GET /api/hospitals/:id
router.get('/:id', (req, res) => {
  const hospital = getHospital(req.params.id);
  if (!hospital) throw new ApiError(404, `Hospital ${req.params.id} not found`);
  res.json(hospital);
});

// GET /api/hospitals/:id/history?type=icu&limit=20
router.get('/:id/history', (req, res) => {
  if (!getHospital(req.params.id)) throw new ApiError(404, `Hospital ${req.params.id} not found`);
  const { type, limit } = req.query;
  if (type && !RESOURCE_KEYS.includes(type))
    throw new ApiError(400, `type must be one of: ${RESOURCE_KEYS.join(', ')}`);
  res.json({ hospital_id: req.params.id, updates: getHistory(req.params.id, { type, limit }) });
});

// PATCH /api/hospitals/:id/resources   body: { "icu": 4, "ventilator": 2, "version": 3, "source": "Hospital Staff" }
router.patch('/:id/resources', (req, res) => {
  const { version, source, ...changes } = req.body || {};
  if (Object.keys(changes).length === 0)
    throw new ApiError(400, `Send at least one of: ${RESOURCE_KEYS.join(', ')}`);
  res.json(updateHospitalResources(req.params.id, changes, { expectedVersion: version, source }));
});

// POST /api/hospitals/:id/confirm  → "our numbers are still correct" (clears stale warning)
router.post('/:id/confirm', (req, res) => {
  const { version, source } = req.body || {};
  res.json(updateHospitalResources(req.params.id, {}, { expectedVersion: version, source }));
});

export default router;
