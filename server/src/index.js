// Entry point for the Emergency Resource Allocator backend
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import healthRouter from './routes/health.js';
import hospitalsRouter from './routes/hospitals.js';
import simulatorRouter from './routes/simulator.js';
import { initSockets } from './sockets/index.js';
import { startSimulator } from './services/simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));   // /live.html test page

app.get('/', (req, res) => res.send('🚑 Emergency Resource Allocator API is running'));
app.use('/api/health', healthRouter);
app.use('/api/hospitals', hospitalsRouter);
app.use('/api/simulator', simulatorRouter);

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
initSockets(server);

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📡 Live test page: http://localhost:${PORT}/live.html`);
  if (process.env.SIMULATOR !== 'off') startSimulator();
});
