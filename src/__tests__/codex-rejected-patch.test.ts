// Codex retries a patch it gets wrong — a stale context block, or two
// operations on one file in a single `*** Begin Patch` — and the rollout
// records each REJECTED attempt exactly like a successful one. The per-prompt
// diff attributed all of them, so a turn was credited with work that never
// reached the working tree: prod session 4402db8c turn 4 was captured as
// +79/-154 where Codex itself reported +48/-118, because a failed
// Delete-then-Add of src/main.py counted the whole file twice.
//
// Only an AFFIRMATIVE failure withdraws a patch — a call still in flight when
// the live parser ran has no result yet and must keep counting, or a turn in
// progress would show none of its work.

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { codexPatchCallFailed, parseCodexRolloutLive } from '../agents/codex.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-rejected-patch.jsonl');

describe('codexPatchCallFailed', () => {
  it('recognizes the ways Codex rejects a patch', () => {
    expect(codexPatchCallFailed('Script failed\nScript error:\napply_patch verification failed: invalid patch')).toBe(true);
    expect(codexPatchCallFailed('apply_patch verification failed: Failed to find expected lines in /repo/a.py')).toBe(true);
    expect(codexPatchCallFailed('Script failed\nWall time 0.0 seconds')).toBe(true);
  });

  it('treats a completed call — and a call with no result yet — as applied', () => {
    expect(codexPatchCallFailed('Script completed\nWall time 0.1 seconds\nOutput:\n{}')).toBe(false);
    expect(codexPatchCallFailed('Success. Updated the following files:\nM /repo/README.md')).toBe(false);
    expect(codexPatchCallFailed('')).toBe(false);
    expect(codexPatchCallFailed(null)).toBe(false);
    expect(codexPatchCallFailed(undefined)).toBe(false);
  });
});

describe('parseCodexRolloutLive — rejected patches', () => {
  it('attributes only the patches that actually applied', () => {
    const r = parseCodexRolloutLive(FIXTURE);
    expect(r).not.toBeNull();
    const patches = r!.promptPatches[0];
    // Four apply_patch calls: two rejected, one applied, one still in flight.
    expect(patches.length).toBe(2);
    expect(patches.some((p) => p.includes('-old line'))).toBe(true);
    expect(patches.some((p) => p.includes('*** Update File: README.md'))).toBe(true);
    // The rejected bodies are gone — including the Delete+Add that would have
    // counted src/main.py's whole contents as removed and re-added.
    expect(patches.some((p) => p.includes('*** Delete File:'))).toBe(false);
    expect(patches.some((p) => p.includes('-gone'))).toBe(false);
  });

  it('still shows the rejected attempts in the transcript', () => {
    // Withdrawing a patch from the DIFF must not hide it from the reviewer —
    // the retries are exactly how you see the agent struggling with a file.
    const r = parseCodexRolloutLive(FIXTURE);
    const turns: Array<{ role: string; content: string }> = JSON.parse(r!.transcript);
    const patchTurns = turns.filter((t) => t.content.startsWith('[Tool: apply_patch]'));
    expect(patchTurns.length).toBe(4);
    expect(patchTurns.some((t) => t.content.includes('apply_patch verification failed'))).toBe(true);
    // And the call count is unchanged — a rejected call was still a call.
    expect(r!.toolCalls).toBe(4);
  });
});
