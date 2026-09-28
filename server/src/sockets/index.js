// Socket.io: pushes live changes to every connected dispatcher / hospital screen.
//
// Events sent to clients:
//   hospital:update      → { hospital, changed, source }      whenever beds change
//   hospitals:freshness  → [{ hospital_id, status, age_minutes, score }]  every 30 s
//   simulator:status     → { running, interval_ms, ... }
//   request:new          → request object                      when a dispatcher logs an emergency
//   request:update       → request object                      when its status changes
//   reservation:update   → { action, request, hospital_id, reservations }  held / accepted / rejected / cancelled / expired / failed
//   handoff:update       → { step, request, hospital_id, workflow }  depart / arrive / complete
//   ambulance:position   → { request_id, lat, lng, source, left_km, eta_min, at }  live GPS / simulated drive
//
// Events received from clients:
//   ambulance:position   ← the ambulance crew's screen sends its position every few seconds (relayed to everyone)
import { Server } from 'socket.io';
import db from '../db/index.js';
import bus, { EVENTS } from '../events.js';
import { getFreshness } from '../services/freshness.js';
import { getSimulatorStatus } from '../services/simulator.js';
import { recordPosition } from '../services/tracking.js';

const FRESHNESS_EVERY_MS = 30_000;

function freshnessSnapshot() {
  return db.prepare('SELECT hospital_id, last_updated_timestamp FROM hospital_resources ORDER BY hospital_id')
    .all()
    .map(r => {
      const f = getFreshness(r.last_updated_timestamp);
      return { hospital_id: r.hospital_id, status: f.status, age_minutes: f.age_minutes, score: f.score };
    });
}

export function initSockets(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected (${io.engine.clientsCount} online)`);
    // Give the new screen the current picture straight away
    socket.emit(EVENTS.FRESHNESS_TICK, freshnessSnapshot());
    socket.emit(EVENTS.SIMULATOR_STATUS, getSimulatorStatus());
    socket.on('ambulance:position', (p) => {
      const fix = recordPosition(p);
      if (fix) io.emit('ambulance:position', fix);
    });
    socket.on('disconnect', () => console.log('🔌 Client left'));
  });

  bus.on(EVENTS.HOSPITAL_UPDATE, (payload) => io.emit(EVENTS.HOSPITAL_UPDATE, payload));
  bus.on(EVENTS.SIMULATOR_STATUS, (payload) => io.emit(EVENTS.SIMULATOR_STATUS, payload));
  bus.on(EVENTS.REQUEST_NEW, (payload) => io.emit(EVENTS.REQUEST_NEW, payload));
  bus.on(EVENTS.REQUEST_UPDATE, (payload) => io.emit(EVENTS.REQUEST_UPDATE, payload));
  bus.on(EVENTS.RESERVATION_UPDATE, (payload) => io.emit(EVENTS.RESERVATION_UPDATE, payload));
  bus.on(EVENTS.HANDOFF_UPDATE, (payload) => io.emit(EVENTS.HANDOFF_UPDATE, payload));

  // Freshness decays with time even when nothing changes, so re-broadcast it regularly
  setInterval(() => io.emit(EVENTS.FRESHNESS_TICK, freshnessSnapshot()), FRESHNESS_EVERY_MS).unref();

  return io;
}
