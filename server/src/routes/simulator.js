// Turn the live simulator on/off during demos
import { Router } from 'express';
import { startSimulator, stopSimulator, getSimulatorStatus } from '../services/simulator.js';

const router = Router();
router.get('/', (req, res) => res.json(getSimulatorStatus()));
router.post('/start', (req, res) => res.json(startSimulator()));
router.post('/stop', (req, res) => res.json(stopSimulator()));
export default router;
