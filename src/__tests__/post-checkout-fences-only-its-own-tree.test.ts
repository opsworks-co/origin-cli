// A checkout fences the journals of the sessions in ITS tree, with both heads.
//
// Linked worktrees share one session list. Session ed0e33c8's journal took a
// fence at 13:39:25Z from a checkout its sibling (47b6f0e4) ran in ANOTHER
// worktree — for files that never moved on ed0e33c8's disk. While a fence
// ended a turn that cut the open turn short; now that it names what the
// checkout changed, it would measure this tree against a branch switch that
// happened somewhere else.
//
// Real repository, real linked worktree. The first version of this test mocked
// `getGitRoot`, and that hid the defect cli-v0.20260918.1434 shipped with:
// inside a linked worktree getGitRoot answers with the MAIN checkout, so every
// worktree session "worked in another tree" and no fence was written at all
// (session ad95e766, 15:32:52Z: four rewrites in the journal, no fence).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJournalEntries } from '../write-journal.js';

const PREV = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

describe('handleGitPostCheckout fences', () => {
  let tmp = '';
  const origCwd = process.cwd();
  afterEach(() => {
    process.chdir(origCwd);
    vi.resetModules(); vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const setup = () => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fence-tree-')));
    const main = path.join(tmp, 'main');
    fs.mkdirSync(main);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.name', 'T'); git(main, 'config', 'user.email', 't@example.com');
    fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
    git(main, 'add', '.'); git(main, 'commit', '-qm', 'base');
    const ours = path.join(main, '.claude', 'worktrees', 'ours');
    const sibling = path.join(main, '.claude', 'worktrees', 'sibling');
    git(main, 'worktree', 'add', '-q', '-b', 'ours', ours);
    git(main, 'worktree', 'add', '-q', '-b', 'sibling', sibling);
    return { main, ours, sibling };
  };

  const fencedFrom = async (cwd: string, trees: { main: string; ours: string; sibling: string }) => {
    const journalOf = (name: string) => path.join(tmp, `${name}.jsonl`);
    vi.resetModules();
    vi.doMock('../session-state.js', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('../session-state.js')),
      listActiveSessions: () => [
        { sessionId: 'main', repoPath: trees.main, writeJournalPath: journalOf('main') },
        { sessionId: 'ours', repoPath: trees.ours, writeJournalPath: journalOf('ours') },
        { sessionId: 'sibling', repoPath: trees.sibling, writeJournalPath: journalOf('sibling') },
        // No recorded tree: it may well be this one, so it keeps its fence.
        { sessionId: 'unknown', writeJournalPath: journalOf('unknown') },
      ],
    }));
    process.chdir(cwd);
    const { handleGitPostCheckout } = await import('../commands/hooks.js');
    await handleGitPostCheckout(PREV, NEXT, '1');
    const read = (name: string) => (fs.existsSync(journalOf(name)) ? parseJournalEntries(fs.readFileSync(journalOf(name), 'utf-8')) : []);
    return Object.fromEntries(['main', 'ours', 'sibling', 'unknown'].map((n) => [n, read(n)]));
  };

  it('a checkout in a LINKED WORKTREE fences that worktree\'s session, with the two heads', async () => {
    const trees = setup();
    const got = await fencedFrom(trees.ours, trees);
    expect(got.ours).toEqual([{ kind: 'fence', at: expect.any(Number), from: PREV, to: NEXT }]);
    expect(got.unknown).toHaveLength(1);
    expect(got.sibling).toEqual([]);
    expect(got.main).toEqual([]);
  });

  it('a checkout in the main checkout fences its session and neither worktree\'s', async () => {
    const trees = setup();
    const got = await fencedFrom(trees.main, trees);
    expect(got.main).toHaveLength(1);
    expect(got.ours).toEqual([]);
    expect(got.sibling).toEqual([]);
  });
});
