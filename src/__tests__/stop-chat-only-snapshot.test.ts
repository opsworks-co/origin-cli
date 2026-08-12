import { describe, it, expect } from 'vitest';
import { shouldAutoSnapshot } from '../commands/hooks.js';

// The Stop hook used to auto-snapshot every turn, trusting createSnapshot's
// dedup to suppress the empty ones. That dedup only refuses when the whole tree
// is clean or byte-identical to the last snapshot — neither of which means "this
// prompt changed nothing" on a repo carrying pre-existing dirt. A chat-only turn
// got a snapshot stamped on it and showed a green dot next to an empty diff.
describe('shouldAutoSnapshot', () => {
  it('skips a chat-only turn', () => {
    const mappings = [
      { promptIndex: 0, filesChanged: ['a.ts'] },
      { promptIndex: 1, chatOnly: true as const },
    ];
    expect(shouldAutoSnapshot(mappings, 2)).toBe(false);
  });

  it('snapshots a turn that changed code', () => {
    const mappings = [
      { promptIndex: 0, chatOnly: true as const },
      { promptIndex: 1, filesChanged: ['a.ts'] },
    ];
    expect(shouldAutoSnapshot(mappings, 2)).toBe(true);
  });

  // The regression that forced the original line-count gate to be removed:
  // Cursor edits files in the IDE without committing, so gitCapture's
  // baseline-vs-HEAD line counts read 0. Stop's chatOnly verdict also requires
  // "no working-tree changes", so such a turn is never marked chat-only and must
  // keep its tree ref — otherwise Restore goes dead in the UI.
  it('snapshots a Cursor mid-turn prompt (dirty tree, no commit, zero line counts)', () => {
    const mappings = [{ promptIndex: 0, filesChanged: [], diff: '' }];
    expect(shouldAutoSnapshot(mappings, 1)).toBe(true);
  });

  it('snapshots when the current prompt has no mapping at all', () => {
    expect(shouldAutoSnapshot([{ promptIndex: 0, chatOnly: true as const }], 2)).toBe(true);
  });

  it('reads the CURRENT prompt, not an earlier chat-only one', () => {
    const mappings = [
      { promptIndex: 0, chatOnly: true as const },
      { promptIndex: 1, chatOnly: true as const },
      { promptIndex: 2, filesChanged: ['b.ts'] },
    ];
    expect(shouldAutoSnapshot(mappings, 3)).toBe(true);
  });

  it('handles an empty mapping list', () => {
    expect(shouldAutoSnapshot([], 1)).toBe(true);
  });
});
