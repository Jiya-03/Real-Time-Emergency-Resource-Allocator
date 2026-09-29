// Demo authentication for the prototype UI
import { Router } from 'express';
import { login, readUser } from '../services/authService.js';
import { ApiError } from '../utils/errors.js';

const router = Router();

// POST /api/auth/login  { role: "dispatcher" | "hospital", identifier, password }
router.post('/login', async (req, res) => res.json(await login(req.body)));

// GET /api/auth/me  (Authorization: Bearer <token>)
router.get('/me', async (req, res) => {
  const user = readUser(req);
  if (!user) throw new ApiError(401, 'Session expired. Please sign in again.');
  res.json({ user });
});

export default router;
