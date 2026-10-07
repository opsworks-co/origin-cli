// The heartbeat / codex-watch figure (parseCodexRolloutLive) and the Stop
// figure (parseCodexRollout) are read from the SAME rollout and must agree —
// when Codex's Stop is killed, the live figure is the one that sticks.
//
// Both count reasoning as part of output_tokens, never on top of it: Codex's
// `reasoning_output_tokens` is a subset of `output_tokens`
// (total_tokens == input_tokens + output_tokens on every real rollout row).
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { parseCodexRollout } from '../commands/hooks.js';
import { parseCodexRolloutLive } from '../agents/codex.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURE = 'codex-uncommitted-2-prompts.jsonl';

describe('Codex token counts: live parser == Stop parser', () => {
  it('reads the same split from one rollout, reasoning not added twice', () => {
    const stop = parseCodexRollout(FIXTURE_DIR, FIXTURE, '')!;
    const live = parseCodexRolloutLive(path.join(FIXTURE_DIR, FIXTURE))!;
    expect(stop).not.toBeNull();
    expect(live).not.toBeNull();

    // Fixture max-total event: input 131039, cached 97792, output 1045,
    // reasoning 73, total 132084 (= input + output).
    const expected = { inputTokens: 33247, outputTokens: 1045, cacheReadTokens: 97792, tokensUsed: 34292 };
    const pick = (r: any) => ({
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens, tokensUsed: r.tokensUsed,
    });
    expect(pick(stop)).toEqual(expected);
    expect(pick(live)).toEqual(expected);
  });
});
