// Entry point for the Emergency Resource Allocator backend
import './env.js';                                // must be first: loads server/.env
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import healthRouter from './routes/health.js';
import hospitalsRouter from './routes/hospitals.js';
import simulatorRouter from './routes/simulator.js';
import requestsRouter from './routes/requests.js';
import authRouter from './routes/auth.js';
import reservationsRouter from './routes/reservations.js';
import configRouter from './routes/config.js';
import { startExpirySweeper } from './services/reservationService.js';
import { initSockets } from './sockets/index.js';
import { startSimulator } from './services/simulator.js';
import { startSync } from './services/supabaseSync.js';
import db from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'client')));  // JeevanRoute UI (login = index.html)
app.use(express.static(path.join(__dirname, '..', 'public')));             // /live.html test page

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/hospitals', hospitalsRouter);
app.use('/api/simulator', simulatorRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/reservations', reservationsRouter);
app.use('/api/config', configRouter);

// Unknown routes
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Errors: known API errors keep their status, anything else is a 500
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.status) return res.status(err.status).json({ error: err.message, ...err.details });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = createServer(app);
await initSockets(server);

// Background jobs run on ONE server only (Postgres mode: whoever holds the leader lock; others check again every 15 s)
async function startBackgroundJobs() {
  if (!await db.isLeader()) { setTimeout(() => startBackgroundJobs().catch(e => console.error('[jobs]', e.message)), 15000).unref(); return; }
  if (db.driver === 'postgres') console.log('👑 This server runs the background jobs (hold expiry, simulator)');
  if (process.env.SIMULATOR !== 'off') await startSimulator().catch(e => console.warn('[simulator]', e.message));
  startExpirySweeper();
}

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}   (JeevanRoute UI · database: ${db.driver === 'postgres' ? 'Postgres' : 'SQLite'})`);
  console.log(`📡 Live test page: http://localhost:${PORT}/live.html`);
  startBackgroundJobs().catch(e => console.error('[jobs]', e.message));
  startSync().catch(e => console.error('[supabase]', e.message));   // SQLite: live copy to Supabase · Postgres: dashboard edits refresh screens
});
