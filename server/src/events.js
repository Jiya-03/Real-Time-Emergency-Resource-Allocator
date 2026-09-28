// Tiny in-process event bus: services announce changes, sockets broadcast them.
// Keeps business logic independent of Socket.io.
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(50);

export const EVENTS = {
  HOSPITAL_UPDATE: 'hospital:update',
  FRESHNESS_TICK: 'hospitals:freshness',
  SIMULATOR_STATUS: 'simulator:status',
  REQUEST_NEW: 'request:new',
  REQUEST_UPDATE: 'request:update',
  RESERVATION_UPDATE: 'reservation:update',
  HANDOFF_UPDATE: 'handoff:update',
  ADMISSION_UPDATE: 'admission:update',
};

export default bus;
