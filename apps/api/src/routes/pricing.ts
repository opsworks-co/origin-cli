import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
}

type ModelPricing = Record<string, { input: number; output: number }>;

// Default pricing (per 1M tokens) — used as fallback and for seeding
const DEFAULT_MODEL_PRICING: ModelPricing = {
  'sonnet': { input: 3, output: 15 },
  'opus': { input: 5, output: 25 },
  'haiku': { input: 1, output: 5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-3-pro': { input: 1.25, output: 10 },
  'gemini-3-flash': { input: 0.15, output: 0.60 },
  'gemini-2.0': { input: 0.10, output: 0.40 },
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o1': { input: 15, output: 60 },
  'o3': { input: 10, output: 40 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o4-mini': { input: 1.10, output: 4.40 },
};

const PRICING_PROVIDER = 'model-pricing';
const GLOBAL_ORG_ID = '__global__';

async function getPricingFromDb(): Promise<ModelPricing | null> {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId: GLOBAL_ORG_ID, provider: PRICING_PROVIDER },
  });
  if (!config) return null;
  try {
    return JSON.parse(config.settings) as ModelPricing;
  } catch {
    return null;
  }
}

// GET /api/pricing — public endpoint, no auth required (CLI calls this)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const pricing = await getPricingFromDb();
    res.json({ pricing: pricing ?? DEFAULT_MODEL_PRICING });
  } catch (err) {
    console.error('Get pricing error:', err);
    res.json({ pricing: DEFAULT_MODEL_PRICING });
  }
});

// PUT /api/pricing — admin-only, update model pricing
router.put('/', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { pricing } = req.body as { pricing: ModelPricing };

    if (!pricing || typeof pricing !== 'object') {
      return res.status(400).json({ error: 'pricing object is required' });
    }

    // Validate structure
    for (const [key, value] of Object.entries(pricing)) {
      if (typeof value !== 'object' || typeof value.input !== 'number' || typeof value.output !== 'number') {
        return res.status(400).json({ error: `Invalid pricing for model "${key}": must have numeric input and output` });
      }
      if (value.input < 0 || value.output < 0) {
        return res.status(400).json({ error: `Invalid pricing for model "${key}": values must be non-negative` });
      }
    }

    const settingsJson = JSON.stringify(pricing);

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId: GLOBAL_ORG_ID, provider: PRICING_PROVIDER },
    });

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings: settingsJson },
      });
    } else {
      await prisma.integrationConfig.create({
        data: {
          orgId: GLOBAL_ORG_ID,
          provider: PRICING_PROVIDER,
          token: '',
          settings: settingsJson,
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'PRICING_UPDATED',
        resource: 'pricing',
        metadata: settingsJson,
      },
    });

    res.json({ pricing });
  } catch (err) {
    console.error('Update pricing error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Seed default pricing if none exists (called on server startup)
export async function seedDefaultPricing(): Promise<void> {
  try {
    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId: GLOBAL_ORG_ID, provider: PRICING_PROVIDER },
    });
    if (!existing) {
      await prisma.integrationConfig.create({
        data: {
          orgId: GLOBAL_ORG_ID,
          provider: PRICING_PROVIDER,
          token: '',
          settings: JSON.stringify(DEFAULT_MODEL_PRICING),
        },
      });
      console.log('✅ Default model pricing seeded');
    }
  } catch (err) {
    console.error('⚠️  Failed to seed pricing:', err);
  }
}

export default router;
