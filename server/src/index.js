// Entry point for the Emergency Resource Allocator backend
import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import hospitalsRouter from './routes/hospitals.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('🚑 Emergency Resource Allocator API is running'));
app.use('/api/health', healthRouter);
app.use('/api/hospitals', hospitalsRouter);

// Unknown routes
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Errors: known API errors keep their status, anything else is a 500
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.status) return res.status(err.status).json({ error: err.message, ...err.details });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
