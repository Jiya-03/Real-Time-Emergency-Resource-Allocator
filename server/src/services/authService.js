// Demo login for the prototype.
// - Dispatchers sign in with an ID starting with "DSP-"   (e.g. DSP-7704)
// - Hospital staff sign in with their hospital ID           (e.g. HSP-011)
// Any non-empty password is accepted (demo mode). Tokens are HMAC-signed, so they
// survive server restarts and need no session storage.
import crypto from 'node:crypto';
import db from '../db/index.js';
import { ApiError } from '../utils/errors.js';

const SECRET = process.env.AUTH_SECRET || 'jeevanroute-hackmatrix-demo-secret';
const TOKEN_HOURS = 12;

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + TOKEN_HOURS * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return user.exp > Date.now() ? user : null;
  } catch {
    return null;
  }
}

export function login({ role, identifier, password } = {}) {
  const id = String(identifier || '').trim().toUpperCase();
  if (!['dispatcher', 'hospital'].includes(role)) throw new ApiError(400, 'role must be dispatcher or hospital');
  if (!id) throw new ApiError(400, 'Enter your ID');
  if (!password) throw new ApiError(400, 'Enter your password');

  let user;
  if (role === 'dispatcher') {
    if (!/^DSP-[A-Z0-9-]{2,}$/.test(id)) throw new ApiError(401, 'Dispatcher IDs start with DSP- (e.g. DSP-7704)');
    user = { role, id, name: 'Ctrl Dispatcher' };
  } else {
    const h = db.prepare('SELECT hospital_id, hospital_name FROM hospitals WHERE hospital_id = ?').get(id);
    if (!h) throw new ApiError(401, 'Unknown hospital ID. Use your hospital code, e.g. HSP-011');
    user = { role, id, name: h.hospital_name, hospital_id: h.hospital_id };
  }
  return { token: issueToken(user), user };
}

// Reads the user from an "Authorization: Bearer <token>" header (null if missing/invalid)
export function readUser(req) {
  const header = req.headers.authorization || '';
  return verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null);
}

// Express middleware: only let these roles through (sets req.user)
export function requireRole(...roles) {
  return (req, res, next) => {
    const user = readUser(req);
    if (!user) return next(new ApiError(401, 'Sign in required'));
    if (!roles.includes(user.role)) return next(new ApiError(403, `Only ${roles.join(' / ')} users can do this`));
    req.user = user;
    next();
  };
}
