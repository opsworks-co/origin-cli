import { Router, Response } from 'express';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';
import { forecastMonthlyCost } from '../services/forecast.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// GET / — cost forecast for the org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const forecast = await forecastMonthlyCost(orgId);
    res.json(forecast);
  } catch (err) {
    console.error('Forecast error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
