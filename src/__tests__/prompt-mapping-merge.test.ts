// At Stop the transcript's per-prompt mappings are merged over the git-derived
// ones the hooks accumulated. The transcript is sharper WHEN IT SAW THE WRITE —
// but it only sees Edit/Write tool calls, and it emits a mapping for EVERY
// prompt whether or not it found any files.
//
// So in a session where the agent edits through the shell (`python - <<PY`,
// `cat > f <<EOF`, `sed -i`) the transcript yields a full set of EMPTY
// mappings, and the old rule — "any index the transcript names belongs to the
// transcript" — deleted every correct git-derived attribution.
//
// Measured on session 0f3b1e69 (every edit a Bash heredoc): saved held
// idx1=5 files and idx2=10 files, the transcript held six 0-file mappings, and
// the merge returned six empty mappings.
import { describe, it, expect } from 'vitest';
import { mergePromptMappings, promptMappingHasContent } from '../commands/hooks.js';

const m = (promptIndex: number, files: string[] = [], diff = '') => ({
  promptIndex, filesChanged: files, diff, uncommittedDiff: '',
});

describe('promptMappingHasContent', () => {
  it('counts files, diff, or uncommitted diff as content', () => {
    expect(promptMappingHasContent(m(0, ['a.ts']))).toBe(true);
    expect(promptMappingHasContent(m(0, [], '--- a\n+++ b\n'))).toBe(true);
    expect(promptMappingHasContent({ promptIndex: 0, filesChanged: [], diff: '', uncommittedDiff: 'x' })).toBe(true);
  });
  it('treats an empty mapping — and whitespace-only diffs — as no content', () => {
    expect(promptMappingHasContent(m(0))).toBe(false);
    expect(promptMappingHasContent(m(0, [], '   \n  '))).toBe(false);
    expect(promptMappingHasContent(null)).toBe(false);
    expect(promptMappingHasContent(undefined)).toBe(false);
  });
});

describe('mergePromptMappings', () => {
  it('THE REGRESSION: empty transcript mappings no longer evict real git ones', () => {
    const saved = [m(0), m(1, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']), m(2, Array.from({ length: 10 }, (_, i) => `f${i}.ts`)), m(3), m(4)];
    const transcript = [m(0), m(1), m(2), m(3), m(4), m(5)];
    const out = mergePromptMappings(saved, transcript);
    expect(out.find(x => x.promptIndex === 1)!.filesChanged).toHaveLength(5);
    expect(out.find(x => x.promptIndex === 2)!.filesChanged).toHaveLength(10);
    // The transcript-only index still comes through.
    expect(out.find(x => x.promptIndex === 5)).toBeTruthy();
  });

  it('still lets the transcript win when it actually saw the write', () => {
    // The transcript is the sharper source for tool-call edits — a saved
    // window capture can carry a concurrent agent's file, so it must not win
    // just by being non-empty.
    const saved = [m(1, ['stale.ts', 'other-agents-file.ts'])];
    const transcript = [m(1, ['real.ts'])];
    expect(mergePromptMappings(saved, transcript)[0].filesChanged).toEqual(['real.ts']);
  });

  it('lets the transcript blank a turn that has no saved content either', () => {
    expect(mergePromptMappings([m(2)], [m(2)])[0].filesChanged).toEqual([]);
  });

  it('keeps saved indices the transcript never mentions', () => {
    const out = mergePromptMappings([m(7, ['x.ts'])], [m(0)]);
    expect(out.map(x => x.promptIndex)).toEqual([0, 7]);
  });

  it('returns entries sorted by promptIndex', () => {
    const out = mergePromptMappings([m(5, ['e.ts']), m(1, ['a.ts'])], [m(3, ['c.ts'])]);
    expect(out.map(x => x.promptIndex)).toEqual([1, 3, 5]);
  });

  it('handles either side being empty', () => {
    expect(mergePromptMappings([], [m(0, ['a.ts'])])).toHaveLength(1);
    expect(mergePromptMappings([m(0, ['a.ts'])], [])).toHaveLength(1);
    expect(mergePromptMappings([], [])).toEqual([]);
  });
});
