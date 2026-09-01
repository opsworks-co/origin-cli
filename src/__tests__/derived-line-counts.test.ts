// The stop path sent files + diff but NEVER line counts — completedPromptMappings
// entries carry no linesAdded/linesRemoved, so every entry in the payload log read
// `+None/-None`. Counts could therefore only arrive from post-commit while files
// and diff arrived from stop: two senders, one row.
//
// That is the split behind rows 1 and 6 of prod session 0f3b1e69 holding +191/-5
// and +92/-1 against a ZERO-byte diff. #1274 made the server refuse counts from a
// payload that supplied no content — necessary, but vacuous while no payload
// supplied both.
import { describe, it, expect } from 'vitest';
import { withDerivedLineCounts } from '../commands/hooks.js';

// One typed seam: without it TypeScript infers each object literal's exact
// shape, so `out.linesRemoved` is "not on type { diff: string }".
type Mapping = { diff?: string; uncommittedDiff?: string; linesAdded?: number; linesRemoved?: number };
const derive = (m: Mapping): Mapping => withDerivedLineCounts<Mapping>(m);

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  ' context',
  '+added one',
  '+added two',
  '-removed one',
].join('\n');

describe('withDerivedLineCounts', () => {
  it('derives counts from the diff the payload already carries', () => {
    const out = derive({ diff: DIFF });
    expect(out.linesAdded).toBe(2);
    expect(out.linesRemoved).toBe(1);
  });

  it('does not count the +++ / --- file headers', () => {
    const out = derive({ diff: '--- a/x\n+++ b/x\n+one\n' });
    expect(out.linesAdded).toBe(1);
    expect(out.linesRemoved).toBe(0);
  });

  it('falls back to uncommittedDiff when there is no committed diff', () => {
    const out = derive({ diff: '', uncommittedDiff: DIFF });
    expect(out.linesAdded).toBe(2);
    expect(out.linesRemoved).toBe(1);
  });

  it('an explicit count always wins — post-commit sends true commit stats', () => {
    const out = derive({ diff: DIFF, linesAdded: 369, linesRemoved: 4 });
    expect(out.linesAdded).toBe(369);
    expect(out.linesRemoved).toBe(4);
  });

  it('leaves a mapping with NO diff alone rather than fabricating a zero', () => {
    // A chat-only turn must stay countless, not acquire a manufactured 0/0
    // that then looks like a real capture.
    const out = derive({ diff: '', uncommittedDiff: '' });
    expect(out.linesAdded).toBeUndefined();
    expect(out.linesRemoved).toBeUndefined();
  });

  it('is safe on a whitespace-only diff and on a bare object', () => {
    expect(derive({ diff: '   \n  ' }).linesAdded).toBeUndefined();
    expect(derive({}).linesAdded).toBeUndefined();
  });

  it('fills only the missing half when one count is present', () => {
    const out = derive({ diff: DIFF, linesAdded: 99 });
    expect(out.linesAdded).toBe(99);
    expect(out.linesRemoved).toBe(1);
  });
});
