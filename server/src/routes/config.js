// Public client configuration. The Mapbox token is a PUBLIC (pk.) token meant for browsers;
// restrict it to your URLs in the Mapbox dashboard. Never put a secret (sk.) token here.
import { Router } from 'express';

const router = Router();
router.get('/', (req, res) => {
  const token = process.env.MAPBOX_TOKEN || '';
  res.json({
    mapbox: token.startsWith('pk.') ? { token, style: process.env.MAPBOX_STYLE || 'mapbox/navigation-day-v1' } : null,
  });
});
export default router;
