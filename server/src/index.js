// Entry point for the Emergency Resource Allocator backend
import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('🚑 Emergency Resource Allocator API is running'));
app.use('/api/health', healthRouter);

// Unknown routes
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Any unexpected error
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
