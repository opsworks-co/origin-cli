// Dynamic pricing must survive process boundaries: session-start fetches the
// API table, but estimateCost runs in the SEPARATE stop-hook process. The
// disk cache (~/.origin/pricing.json) is the bridge — these tests simulate
// the two processes with vi.resetModules().
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-pricing-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const CACHE = path.join(TEST_HOME, '.origin', 'pricing.json');

async function freshModule() {
  vi.resetModules();
  return import('../transcript.js');
}

beforeEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('pricing disk cache (one source across hook processes)', () => {
  it('setActivePricing persists; a FRESH process resolves the cached rate', async () => {
    const p1 = await freshModule();
    p1.setActivePricing({ 'opus': { input: 99, output: 199 } } as any);
    expect(fs.existsSync(CACHE)).toBe(true);

    // "stop hook" = new process
    const p2 = await freshModule();
    const resolved = p2.resolveModelPricing('claude-opus-4-8');
    expect(resolved.input).toBe(99);
    expect(resolved.output).toBe(199);
  });

  it('cache merges OVER defaults — models missing from the cache keep baked-in rates', async () => {
    const p1 = await freshModule();
    p1.setActivePricing({ 'opus': { input: 99, output: 199 } } as any);
    const p2 = await freshModule();
    // gemini isn't in the cached table → baked-in default must still resolve
    const gem = p2.resolveModelPricing('gemini-2.5-pro');
    expect(gem.input).toBeGreaterThan(0);
    expect(gem.input).not.toBe(99);
  });

  it('a stale cache (>7d) is ignored', async () => {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({
      fetchedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
      pricing: { 'opus': { input: 99, output: 199 } },
    }));
    const p = await freshModule();
    expect(p.resolveModelPricing('claude-opus-4-8').input).not.toBe(99);
  });

  it('a corrupt cache is ignored (defaults apply, no throw)', async () => {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, '{not json');
    const p = await freshModule();
    expect(p.resolveModelPricing('claude-opus-4-8').input).toBeGreaterThan(0);
  });
});
