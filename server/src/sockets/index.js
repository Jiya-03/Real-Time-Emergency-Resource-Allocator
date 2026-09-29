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
//   admission:update     → { request_id, hospital_id, admission }  ward / room / bed + resources used at handover
//
// Events received from clients:
//   ambulance:position   ← the ambulance crew's screen sends its position every few seconds (relayed to everyone).
//                          Only accepted from the signed-in dispatcher who logged that emergency
//                          (token in the socket handshake); anything else gets ambulance:position:rejected.
//
// Several servers (Postgres mode): the Socket.io Postgres adapter shares every emit between servers,
// so a hospital connected to server B still hears about an emergency logged on server A.
import { Server } from 'socket.io';
import db from '../db/index.js';
import bus, { EVENTS } from '../events.js';
import { getFreshness } from '../services/freshness.js';
import { getSimulatorStatus } from '../services/simulator.js';
import { recordPosition } from '../services/tracking.js';
import { verifyToken } from '../services/authService.js';

const FRESHNESS_EVERY_MS = 30_000;

async function freshnessSnapshot() {
  return (await db.prepare('SELECT hospital_id, last_updated_timestamp FROM hospital_resources ORDER BY hospital_id').all())
    .map(r => {
      const f = getFreshness(r.last_updated_timestamp);
      return { hospital_id: r.hospital_id, status: f.status, age_minutes: f.age_minutes, score: f.score };
    });
}

export async function initSockets(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });
  if (db.driver === 'postgres') {
    const { createAdapter } = await import('@socket.io/postgres-adapter');
    await db.pool.query(`CREATE TABLE IF NOT EXISTS socket_io_attachments (
      id bigserial UNIQUE, created_at timestamptz DEFAULT NOW(), payload bytea)`).catch(() => {});
    io.adapter(createAdapter(db.pool, { errorHandler: (e) => console.warn('🟠 [socket.io adapter]', e.message) }));
    console.log('🔗 Socket.io shares live events with every other server on this database');
  }

  // Who is on the other end? (optional: screens can listen without signing in, but cannot send positions)
  io.use((socket, next) => { socket.data.user = verifyToken(socket.handshake.auth?.token); next(); });

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected (${io.engine.clientsCount} online)`);
    // Give the new screen the current picture straight away
    freshnessSnapshot().then(f => socket.emit(EVENTS.FRESHNESS_TICK, f)).catch(() => {});
    socket.emit(EVENTS.SIMULATOR_STATUS, getSimulatorStatus());
    socket.on('ambulance:position', async (p) => {
      try {
        const { fix, error } = await recordPosition(p, socket.data.user);
        if (fix) io.emit('ambulance:position', fix);
        else if (error !== 'too frequent') socket.emit('ambulance:position:rejected', { request_id: p?.request_id, reason: error });
      } catch (e) { console.warn('[position]', e.message); }
    });
    socket.on('disconnect', () => console.log('🔌 Client left'));
  });

  // payload._local: only this server's screens (every server received the same trigger itself)
  bus.on(EVENTS.HOSPITAL_UPDATE, ({ _local, ...payload }) => (_local ? io.local : io).emit(EVENTS.HOSPITAL_UPDATE, payload));
  bus.on(EVENTS.SIMULATOR_STATUS, (payload) => io.local.emit(EVENTS.SIMULATOR_STATUS, payload));
  bus.on(EVENTS.REQUEST_NEW, (payload) => io.emit(EVENTS.REQUEST_NEW, payload));
  bus.on(EVENTS.REQUEST_UPDATE, (payload) => io.emit(EVENTS.REQUEST_UPDATE, payload));
  bus.on(EVENTS.RESERVATION_UPDATE, (payload) => io.emit(EVENTS.RESERVATION_UPDATE, payload));
  bus.on(EVENTS.HANDOFF_UPDATE, (payload) => io.emit(EVENTS.HANDOFF_UPDATE, payload));
  bus.on(EVENTS.ADMISSION_UPDATE, (payload) => io.emit(EVENTS.ADMISSION_UPDATE, payload));

  // Freshness decays with time even when nothing changes, so re-broadcast it regularly
  setInterval(() => freshnessSnapshot().then(f => io.local.emit(EVENTS.FRESHNESS_TICK, f)).catch(() => {}), FRESHNESS_EVERY_MS).unref();

  return io;
}
