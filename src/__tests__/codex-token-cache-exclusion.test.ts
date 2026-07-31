// T1 regression: Codex `tokensUsed` must EXCLUDE cache reads, matching the
// platform contract every other agent follows (Claude/Cursor/agy report
// input+output only; cache is tracked separately in cacheReadTokens). Codex's
// `input_tokens` INCLUDES cached, so a naive total made a Codex session look
// ~14× less token-efficient than an identical Claude session in the benchmark
// scorecard — an artifact of the definition, not real work.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCodexRolloutLive } from '../agents/codex.js';

describe('parseCodexRolloutLive — tokensUsed excludes cache reads', () => {
  let file = '';
  afterEach(() => { try { if (file) fs.rmSync(file, { force: true }); } catch { /* ignore */ } });

  it('subtracts cached_input_tokens from tokensUsed and inputTokens', () => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-')), 'rollout.jsonl');
    // input 1000 (incl 400 cached), output 500, total 1500.
    fs.writeFileSync(file, JSON.stringify({
      total_token_usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 400, total_tokens: 1500 },
    }) + '\n');

    const r = parseCodexRolloutLive(file);
    expect(r).not.toBeNull();
    expect(r!.inputTokens).toBe(600);        // 1000 − 400 cached
    expect(r!.outputTokens).toBe(500);
    expect(r!.cacheReadTokens).toBe(400);
    expect(r!.tokensUsed).toBe(1100);        // 600 + 500, NOT 1500 (which folds in cache)
  });
});
