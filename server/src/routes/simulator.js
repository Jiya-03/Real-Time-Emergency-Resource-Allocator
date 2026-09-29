// Turn the live simulator on/off during demos
import { Router } from 'express';
import { startSimulator, stopSimulator, getSimulatorStatus } from '../services/simulator.js';

const router = Router();
router.get('/', async (req, res) => res.json(getSimulatorStatus()));
router.post('/start', async (req, res) => res.json(await startSimulator()));
router.post('/stop', async (req, res) => res.json(stopSimulator()));
export default router;
