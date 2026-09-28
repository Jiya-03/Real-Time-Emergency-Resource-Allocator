// Handoff workflow after a hospital accepts:
//   depart   (ambulance leaves the scene)      → request IN_TRANSIT, workflow departure_time, handover IN_PROGRESS
//   arrive   (ambulance docks at the hospital)  → workflow arrival_time
//   complete (patient handed to ED staff)       → workflow handover_time, handover COMPLETED, request COMPLETED
// Times always satisfy assignment ≤ departure ≤ arrival ≤ handover (same rule as the dataset).
import db from '../db/index.js';
import { getRequest } from './requestService.js';
import { getHospital } from './hospitalService.js';
import { ApiError } from '../utils/errors.js';
import bus, { EVENTS } from '../events.js';

const STEPS = ['depart', 'arrive', 'complete'];

export function acceptedWorkflow(requestId) {
  return db.prepare(`SELECT * FROM emergency_workflow_handover WHERE request_id = ? AND hospital_response = 'ACCEPTED'
                     ORDER BY assignment_time DESC LIMIT 1`).get(requestId);
}

export function handoff(requestId, step, user) {
  if (!STEPS.includes(step)) throw new ApiError(400, `step must be one of: ${STEPS.join(', ')}`);
  const req = getRequest(requestId);
  if (!req) throw new ApiError(404, `Request ${requestId} not found`);
  const wf = acceptedWorkflow(requestId);
  if (!wf) throw new ApiError(409, 'No hospital has accepted this emergency yet', { code: 'NOT_ASSIGNED' });

  // Who may do what: the crew (dispatcher) moves the ambulance; the receiving hospital can log arrival and must complete handover
  const isHospital = user.role === 'hospital';
  if (isHospital && user.hospital_id !== wf.hospital_id) throw new ApiError(403, 'This patient is assigned to another hospital');
  if (step === 'complete' && !isHospital) throw new ApiError(403, 'Only the receiving hospital can complete the handover');
  if (step === 'depart' && isHospital) throw new ApiError(403, 'Only the ambulance crew can mark departure');

  const now = new Date().toISOString();
  db.transaction(() => {
    if (step === 'depart') {
      if (req.status !== 'ASSIGNED') throw new ApiError(409, `Cannot depart: emergency is ${req.status}`, { code: 'BAD_STATE' });
      db.prepare(`UPDATE emergency_workflow_handover SET departure_time = ?, handover_status = 'IN_PROGRESS' WHERE workflow_id = ?`).run(now, wf.workflow_id);
      db.prepare(`UPDATE emergency_requests SET request_status = 'IN_TRANSIT' WHERE request_id = ?`).run(requestId);
    }
    if (step === 'arrive') {
      if (!['ASSIGNED', 'IN_TRANSIT'].includes(req.status) || wf.arrival_time) {
        throw new ApiError(409, wf.arrival_time ? 'Arrival already recorded' : `Cannot arrive: emergency is ${req.status}`, { code: 'BAD_STATE' });
      }
      db.prepare(`UPDATE emergency_workflow_handover SET departure_time = COALESCE(departure_time, ?), arrival_time = ?,
                  handover_status = 'IN_PROGRESS' WHERE workflow_id = ?`).run(now, now, wf.workflow_id);
      db.prepare(`UPDATE emergency_requests SET request_status = 'IN_TRANSIT' WHERE request_id = ?`).run(requestId);
    }
    if (step === 'complete') {
      if (!wf.arrival_time) throw new ApiError(409, 'Record the ambulance arrival before completing handover', { code: 'NOT_ARRIVED' });
      if (wf.handover_status === 'COMPLETED') throw new ApiError(409, 'Handover already completed', { code: 'BAD_STATE' });
      db.prepare(`UPDATE emergency_workflow_handover SET handover_time = ?, handover_status = 'COMPLETED' WHERE workflow_id = ?`).run(now, wf.workflow_id);
      db.prepare(`UPDATE emergency_requests SET request_status = 'COMPLETED' WHERE request_id = ?`).run(requestId);
    }
  })();

  const payload = {
    step,
    request: getRequest(requestId),
    hospital_id: wf.hospital_id,
    hospital_name: getHospital(wf.hospital_id)?.name,
    workflow: acceptedWorkflow(requestId),
  };
  bus.emit(EVENTS.REQUEST_UPDATE, payload.request);
  bus.emit(EVENTS.HANDOFF_UPDATE, payload);
  return payload;
}
