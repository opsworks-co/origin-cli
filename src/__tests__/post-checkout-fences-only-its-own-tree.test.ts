// A checkout fences the journals of the sessions in ITS tree, with both heads.
//
// Linked worktrees share one session list. Session ed0e33c8's journal took a
// fence at 13:39:25Z from a checkout its sibling (47b6f0e4) ran in ANOTHER
// worktree — for files that never moved on ed0e33c8's disk. While a fence
// ended a turn that cut the open turn short; now that it names what the
// checkout changed, it would measure this tree against a branch switch that
// happened somewhere else.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJournalEntries } from '../write-journal.js';

const PREV = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

describe('handleGitPostCheckout fences', () => {
  let tmp = '';
  afterEach(() => {
    vi.resetModules(); vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('this tree\'s session, not the sibling worktree\'s — and records the two heads', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fence-tree-')));
    const here = path.join(tmp, 'here');
    const sibling = path.join(tmp, 'sibling');
    const unknown = path.join(tmp, 'unknown.jsonl');
    fs.mkdirSync(here); fs.mkdirSync(sibling);
    const journalOf = (name: string) => path.join(tmp, `${name}.jsonl`);

    vi.resetModules();
    vi.doMock('../session-state.js', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('../session-state.js')),
      getGitRoot: () => here,
      listActiveSessions: () => [
        { sessionId: 'ours', repoPath: here, writeJournalPath: journalOf('ours') },
        { sessionId: 'theirs', repoPath: sibling, writeJournalPath: journalOf('theirs') },
        // No recorded tree: it may well be ours, so it keeps its fence.
        { sessionId: 'unknown', writeJournalPath: unknown },
      ],
    }));
    const { handleGitPostCheckout } = await import('../commands/hooks.js');
    await handleGitPostCheckout(PREV, NEXT, '1');

    const read = (file: string) => (fs.existsSync(file) ? parseJournalEntries(fs.readFileSync(file, 'utf-8')) : []);
    expect(read(journalOf('ours'))).toEqual([{ kind: 'fence', at: expect.any(Number), from: PREV, to: NEXT }]);
    expect(read(unknown)).toHaveLength(1);
    expect(read(journalOf('theirs'))).toEqual([]);
  });
});
