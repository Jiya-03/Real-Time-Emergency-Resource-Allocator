// Scenarios page API: the problem statement's test cases, run live on a sandbox copy.
//   GET /api/scenarios              → list of scenarios
//   GET /api/scenarios/run?id=all   → Server-Sent Events stream: status / start / step / done / end
import { Router } from 'express';
import { SCENARIOS, runScenario } from '../scenarios/scenarios.js';
import { SANDBOX_TIMERS } from '../scenarios/sandbox.js';

const router = Router();
let running = false;

router.get('/', (req, res) => res.json({ scenarios: SCENARIOS, sandbox_timers: SANDBOX_TIMERS }));

router.get('/run', async (req, res) => {
  if (running) return res.status(409).json({ error: 'A scenario is already running. Wait for it to finish.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let open = true;
  req.on('close', () => { open = false; });
  const emit = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  running = true;
  try {
    await runScenario(String(req.query.id || 'all'), emit);
  } catch (e) {
    emit('failure', { text: e.message });
  } finally {
    running = false;
    res.end();
  }
});

export default router;
