import { Router, Response } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { forecastMonthlyCost } from '../services/forecast.js';

const router = Router();
router.use(requireAuth);

// GET / — cost forecast for the org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const forecast = await forecastMonthlyCost(orgId);
    res.json(forecast);
  } catch (err) {
    console.error('Forecast error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
