import { describe, it, expect } from 'vitest';
import { filterUncommittedDiff, shouldAutoSnapshot } from '../commands/hooks.js';

// Stop decides a turn is chat-only from "no commits AND no transcript edits AND
// no working-tree changes". That last clause used to read the RAW uncommitted
// diff, which in a repo carrying pre-existing dirt is never empty — so a turn
// that did nothing was ruled not-chat-only, and then handed a mapping whose diff
// filtered down to nothing. An empty payload that isn't marked chatOnly is what
// mints an auto-snapshot with no diff behind it: the green dot on a dead turn.
//
// These cover the filter behaviour the verdict now depends on. origin-demo-1 is
// the live example — 32 dirty files, and every chat-only turn got a snapshot.

const dirtyFileDiff = [
  'diff --git a/cocain b/cocain',
  'index 111..222 100644',
  '--- a/cocain',
  '+++ b/cocain',
  '@@ -1 +1,2 @@',
  ' row one',
  '+row two',
  '',
].join('\n');

const newWorkDiff = [
  'diff --git a/aurora_flux.py b/aurora_flux.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/aurora_flux.py',
  '@@ -0,0 +1 @@',
  '+print("aurora")',
  '',
].join('\n');

describe('chat-only verdict in a dirty repo', () => {
  it('filters pre-existing dirt down to nothing — the chat-only case', () => {
    const filtered = filterUncommittedDiff(dirtyFileDiff, ['cocain']);
    expect(filtered).toBe('');
  });

  it('keeps a Cursor mid-turn edit — dirt elsewhere must not mask real work', () => {
    const both = dirtyFileDiff + newWorkDiff;
    const filtered = filterUncommittedDiff(both, ['cocain']);
    expect(filtered).toContain('aurora_flux.py');
    expect(filtered).not.toContain('a/cocain');
  });

  it('is a no-op when the exclude list is empty (shadow captured the dirt)', () => {
    // After a successful shadow commit Stop clears prePromptDirtyFiles, so an
    // edit to a previously-dirty file is NOT dropped on the following turn.
    expect(filterUncommittedDiff(dirtyFileDiff, [])).toBe(dirtyFileDiff);
  });

  // The end-to-end shape: dirt-only turn → empty filtered diff → chatOnly →
  // no snapshot. This is the chain that produced the reported green dot.
  it('a dirt-only turn ends up chat-only and un-snapshotted', () => {
    const filtered = filterUncommittedDiff(dirtyFileDiff, ['cocain']);
    const noUncommittedChanges = !filtered;
    expect(noUncommittedChanges).toBe(true);

    const mappings = [{ promptIndex: 0, chatOnly: noUncommittedChanges }];
    expect(shouldAutoSnapshot(mappings, 1)).toBe(false);
  });

  it('a real-work turn stays snapshottable', () => {
    const filtered = filterUncommittedDiff(dirtyFileDiff + newWorkDiff, ['cocain']);
    const mappings = [{ promptIndex: 0, chatOnly: !filtered }];
    expect(shouldAutoSnapshot(mappings, 1)).toBe(true);
  });
});
