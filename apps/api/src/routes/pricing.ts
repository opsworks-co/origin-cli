import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { DEFAULT_MODEL_PRICING, ModelPricing } from '../utils/pricing.js';

const router = Router();

interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
}

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

// Merge admin-supplied overrides over the defaults. Always returning a
// table that contains every default key guarantees the CLI (which calls
// setActivePricing() to *replace* its in-memory table) never silently
// falls back to sonnet pricing because an admin forgot a key.
function mergeWithDefaults(overrides: ModelPricing | null): ModelPricing {
  return { ...DEFAULT_MODEL_PRICING, ...(overrides ?? {}) };
}

// GET /api/pricing — public endpoint, no auth required (CLI calls this)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const pricing = await getPricingFromDb();
    res.json({ pricing: mergeWithDefaults(pricing) });
  } catch (err) {
    console.error('Get pricing error:', err);
    res.json({ pricing: DEFAULT_MODEL_PRICING });
  }
});

// PUT /api/pricing — admin-only, update model pricing.
// Accepts a *partial* override map; merged onto the defaults at read time
// so missing keys can't silently mis-price GPT-5/Codex/etc.
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
      // Sanity bound: nothing public charges > $1000 / 1M tokens today.
      // Catches the "admin pasted a yearly figure" mistake.
      if (value.input > 1000 || value.output > 1000) {
        return res.status(400).json({ error: `Invalid pricing for model "${key}": values must be ≤ 1000 per 1M tokens` });
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

    // Return the effective (merged) table so the admin UI shows the full
    // active state, not just their overrides.
    res.json({ pricing: mergeWithDefaults(pricing) });
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
