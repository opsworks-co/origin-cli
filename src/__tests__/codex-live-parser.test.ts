// Regression tests for parseCodexRolloutLive — the CLI heartbeat's live Codex
// rollout parser (agents/codex.ts). It runs every ~30s on the in-flight rollout
// and its transcript OVERWRITES the stop-hook transcript on the server (the mcp
// PATCH is last-writer-wins on the `transcript` field). So when this parser
// lagged the Codex ≥0.145 `custom_tool_call` schema — #803 updated
// parseCodexRollout but not this twin — every heartbeat shipped a tool-less
// transcript that clobbered the richer stop-hook one. User-reported as "the
// tool output was there in the prompt, then disappeared" (gpt-5.6-sol, Windows).
//
// These lock the ≥0.145 tool-call/output handling so the twin can't drift
// silently again. The fixture is a real 0.145 rollout (custom_tool_call).

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { parseCodexRolloutLive } from '../agents/codex.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

describe('parseCodexRolloutLive — Codex ≥0.145 schema parity', () => {
  it('captures custom_tool_call tool activity in the live transcript', () => {
    const r = parseCodexRolloutLive(
      path.join(FIXTURE_DIR, 'codex-uncommitted-3-prompts.jsonl'),
    );
    expect(r).not.toBeNull();
    const turns: Array<{ role: string; content: string }> = JSON.parse(r!.transcript);

    // The 3 apply_patch calls in this rollout arrive as `custom_tool_call`
    // (≥0.145). Before the fix the live parser skipped that payload type, so
    // these turns — and their patch bodies — never made it into the transcript.
    const applyPatchTurns = turns.filter((t) => t.content.startsWith('[Tool: apply_patch]'));
    expect(applyPatchTurns.length).toBe(3);
    expect(turns.some((t) => t.content.includes('*** Begin Patch'))).toBe(true);
  });

  it('counts custom_tool_call toward the live tool count (not just function_call)', () => {
    const r = parseCodexRolloutLive(
      path.join(FIXTURE_DIR, 'codex-uncommitted-3-prompts.jsonl'),
    );
    expect(r).not.toBeNull();
    // 16 function_call + 3 custom_tool_call. The pre-fix parser only saw the
    // former (16), which surfaced as "0 tools"→undersell on the live header.
    expect(r!.toolCalls).toBe(19);
  });

  it('still recovers every user prompt and token usage', () => {
    const r = parseCodexRolloutLive(
      path.join(FIXTURE_DIR, 'codex-uncommitted-3-prompts.jsonl'),
    );
    expect(r).not.toBeNull();
    expect(r!.userPrompts.length).toBe(3);
    expect(r!.tokensUsed).toBeGreaterThan(0);
  });
});
