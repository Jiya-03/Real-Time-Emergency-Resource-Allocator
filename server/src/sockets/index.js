// Socket.io: pushes live changes to every connected dispatcher / hospital screen.
//
// Events sent to clients:
//   hospital:update      → { hospital, changed, source }      whenever beds change
//   hospitals:freshness  → [{ hospital_id, status, age_minutes, score }]  every 30 s
//   simulator:status     → { running, interval_ms, ... }
import { Server } from 'socket.io';
import db from '../db/index.js';
import bus, { EVENTS } from '../events.js';
import { getFreshness } from '../services/freshness.js';
import { getSimulatorStatus } from '../services/simulator.js';

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
    socket.on('disconnect', () => console.log('🔌 Client left'));
  });

  bus.on(EVENTS.HOSPITAL_UPDATE, (payload) => io.emit(EVENTS.HOSPITAL_UPDATE, payload));
  bus.on(EVENTS.SIMULATOR_STATUS, (payload) => io.emit(EVENTS.SIMULATOR_STATUS, payload));

  // Freshness decays with time even when nothing changes, so re-broadcast it regularly
  setInterval(() => io.emit(EVENTS.FRESHNESS_TICK, freshnessSnapshot()), FRESHNESS_EVERY_MS).unref();

  return io;
}
