/**
 * A rebase made the repo remember its own work twice.
 *
 * `git rebase` replaces sha A with a new sha B carrying the same change, and
 * the post-commit hook records B as a brand-new commit. Nothing ever noticed
 * that A was the same work, so the memory note grew one redundant record per
 * rebase — and on a repo where every PR rebases onto a busy main, that is most
 * of them.
 *
 * Measured on this repo's own note before the fix: 209 commit records, 20 of
 * them rebase copies. The pointer injected into every new session opened with
 * "209 commit records" and `origin context memory` listed the same fix two or
 * three times over, each under a different sha:
 *
 *   21bd0037 (+99/-11)  fix(cli): the turn-scoped exemption read one index …
 *   f9f7557d (+99/-11)  fix(cli): the turn-scoped exemption read one index …
 *
 * Both of those are orphaned by the time anyone reads them — the PR squash-
 * merges, so neither branch commit reaches main. That is why reachability
 * cannot pick the survivor and the stored record data has to.
 *
 * The two cases the discriminator has to get right, both taken from real
 * records in that note:
 *   - the rewrite is NOT byte-identical (a rebase here re-bumps the CLI
 *     version resolving the conflict), so line counts cannot be part of the key
 *   - merge commits record NO files and repeat their subject, so seven
 *     genuinely distinct `Merge main` commits must NOT collapse
 */

import { describe, it, expect } from 'vitest';
import { dedupeRebasedCommits, rebasedCommitKey, mergeMemoryPayloads } from '../memory.js';
import type { CommitMemoryEntry, SessionMemoryEntry } from '../memory.js';

const commit = (
  sha: string,
  opts: Partial<CommitMemoryEntry> = {},
): CommitMemoryEntry => ({
  commitSha: sha,
  sessionId: 'b0c86852',
  agentSlug: 'claude-code',
  message: 'fix(cli): the turn-scoped exemption read one index against two index spaces',
  filesChanged: ['packages/cli/src/commands/hooks.ts', 'packages/cli/package.json'],
  linesAdded: 99,
  linesRemoved: 11,
  branch: 'claude/fix',
  committedAt: '2026-09-01T00:30:00.000Z',
  ...opts,
});

const shas = (list: CommitMemoryEntry[]) => list.map((c) => c.commitSha);

describe('dedupeRebasedCommits', () => {
  it('collapses the pre-rebase copy, keeping the commit made LAST', () => {
    const out = dedupeRebasedCommits([
      commit('21bd0037', { committedAt: '2026-09-01T00:30:00.000Z' }),
      commit('f9f7557d', { committedAt: '2026-09-01T00:52:00.000Z' }),
    ]);
    expect(shas(out)).toEqual(['f9f7557d']);
  });

  it('collapses a rewrite whose line counts MOVED — the version re-bump', () => {
    // 6ca2ef79 (+408/-26) → 474d5310 (+411/-29): resolving the version-file
    // conflict re-bumps packages/cli/package.json, so the rewritten commit is
    // the same work carrying three extra lines. Keying on line counts would
    // have left this pair uncollapsed, which is how it survived in the note.
    const out = dedupeRebasedCommits([
      commit('6ca2ef79', { linesAdded: 408, linesRemoved: 26, committedAt: '2026-08-31T20:00:00.000Z' }),
      commit('474d5310', { linesAdded: 411, linesRemoved: 29, committedAt: '2026-08-31T21:00:00.000Z' }),
    ]);
    expect(shas(out)).toEqual(['474d5310']);
  });

  it('collapses a three-way chain — a branch rebased twice', () => {
    const out = dedupeRebasedCommits([
      commit('6446d978', { committedAt: '2026-08-20T10:00:00.000Z' }),
      commit('53c30391', { committedAt: '2026-08-20T11:00:00.000Z' }),
      commit('525e0777', { committedAt: '2026-08-20T12:00:00.000Z' }),
    ]);
    expect(shas(out)).toEqual(['525e0777']);
  });

  it('keeps distinct merge commits that share a subject and record no files', () => {
    // Seven `Merge main` records in the real note, +215/-35, +601/-21,
    // +574/-8 … — all in one session, all with an empty filesChanged. On
    // subject alone they collapse to one, and six real merges vanish.
    const merges = ['b048602c', '50e3b6de', 'd7682443', 'dc9d1a26', 'f9e6b8ef', '6e0edddb', 'edfb8ef0']
      .map((sha, i) => commit(sha, {
        message: 'Merge main',
        filesChanged: [],
        linesAdded: 100 * (i + 1),
        committedAt: `2026-08-1${i}T00:00:00.000Z`,
      }));
    expect(shas(dedupeRebasedCommits(merges))).toEqual(shas(merges));
  });

  it('keeps two commits that share a subject but touch different files', () => {
    const out = dedupeRebasedCommits([
      commit('aaaaaaa1', { filesChanged: ['a.ts'] }),
      commit('bbbbbbb2', { filesChanged: ['b.ts'] }),
    ]);
    expect(shas(out)).toEqual(['aaaaaaa1', 'bbbbbbb2']);
  });

  it('keeps identical-looking commits made by DIFFERENT sessions', () => {
    // Two sessions landing the same generated change is not a rebase, and one
    // session's record must never be swallowed by another's.
    const out = dedupeRebasedCommits([
      commit('aaaaaaa1', { sessionId: 's1' }),
      commit('bbbbbbb2', { sessionId: 's2' }),
    ]);
    expect(shas(out)).toEqual(['aaaaaaa1', 'bbbbbbb2']);
  });

  it('carries decisions and file notes forward off the record it drops', () => {
    // The pre-rebase sha is often the one the decision was captured against —
    // dropping the record must not drop the reasoning with it.
    const out = dedupeRebasedCommits([
      commit('21bd0037', {
        committedAt: '2026-09-01T00:30:00.000Z',
        decisions: ['made serverIndex and localIndex both required'],
        fileNotes: { 'packages/cli/src/commands/hooks.ts': 'index spaces' },
      }),
      commit('f9f7557d', { committedAt: '2026-09-01T00:52:00.000Z' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].commitSha).toBe('f9f7557d');
    expect(out[0].decisions).toEqual(['made serverIndex and localIndex both required']);
    expect(out[0].fileNotes).toEqual({ 'packages/cli/src/commands/hooks.ts': 'index spaces' });
  });

  it('never overwrites decisions the surviving record already has', () => {
    const out = dedupeRebasedCommits([
      commit('21bd0037', { committedAt: '2026-09-01T00:30:00.000Z', decisions: ['older'] }),
      commit('f9f7557d', { committedAt: '2026-09-01T00:52:00.000Z', decisions: ['kept'] }),
    ]);
    expect(out[0].decisions).toEqual(['kept']);
  });

  it('leaves the surviving records in their original positions', () => {
    // Insertion order is not time order here, and callers that care sort for
    // themselves — reordering as a side effect of deduping would be a second,
    // unasked-for change.
    const other = commit('cccccccc', { message: 'chore: unrelated', filesChanged: ['z.ts'] });
    const out = dedupeRebasedCommits([
      commit('21bd0037', { committedAt: '2026-09-01T00:30:00.000Z' }),
      other,
      commit('f9f7557d', { committedAt: '2026-09-01T00:52:00.000Z' }),
    ]);
    expect(shas(out)).toEqual(['cccccccc', 'f9f7557d']);
  });

  it('is idempotent', () => {
    const once = dedupeRebasedCommits([commit('21bd0037'), commit('f9f7557d', { committedAt: '2026-09-01T00:52:00.000Z' })]);
    expect(dedupeRebasedCommits(once)).toEqual(once);
  });

  it('handles an empty list and records missing the fields the key rests on', () => {
    expect(dedupeRebasedCommits([])).toEqual([]);
    const unkeyable = [
      commit('aaaaaaa1', { message: '' }),
      commit('bbbbbbb2', { message: '' }),
    ];
    expect(shas(dedupeRebasedCommits(unkeyable))).toEqual(['aaaaaaa1', 'bbbbbbb2']);
  });
});

describe('rebasedCommitKey', () => {
  it('is insensitive to changed-file ORDER — the key is a set', () => {
    const a = commit('aaaaaaa1', { filesChanged: ['a.ts', 'b.ts'] });
    const b = commit('bbbbbbb2', { filesChanged: ['b.ts', 'a.ts'] });
    expect(rebasedCommitKey(a)).toBe(rebasedCommitKey(b));
  });

  it('reads the SUBJECT only — a rebase can rewrite the body', () => {
    const a = commit('aaaaaaa1', { message: 'fix: thing\n\nbody as first written' });
    const b = commit('bbbbbbb2', { message: 'fix: thing\n\nbody after the rebase' });
    expect(rebasedCommitKey(a)).toBe(rebasedCommitKey(b));
  });

  it('refuses to key a record with no files — merge commits record none', () => {
    expect(rebasedCommitKey(commit('aaaaaaa1', { filesChanged: [] }))).toBeNull();
  });
});

const session = (id: string): SessionMemoryEntry => ({
  sessionId: id,
  agentSlug: 'claude-code',
  model: 'claude',
  startedAt: '2026-09-01T00:00:00.000Z',
  endedAt: '2026-09-01T01:00:00.000Z',
  branch: 'main',
  summary: `work ${id}`,
  filesChanged: ['hooks.ts'],
  promptCount: 1,
  linesAdded: 99,
  linesRemoved: 11,
  openTodos: [],
});

describe('mergeMemoryPayloads folds rebase copies too', () => {
  it('a machine that still has the pre-rebase record cannot hand it back', () => {
    // The union is what makes this necessary: without the fold on the merged
    // result, the machine that dropped 21bd0037 gets it back on the next sync
    // and the fix never sticks.
    const folded = {
      version: 2,
      sessions: [session('b0c86852')],
      commits: [commit('f9f7557d', { committedAt: '2026-09-01T00:52:00.000Z' })],
    };
    const stale = {
      version: 2,
      sessions: [session('b0c86852')],
      commits: [commit('21bd0037', { committedAt: '2026-09-01T00:30:00.000Z' })],
    };
    expect(shas(mergeMemoryPayloads(folded, stale).commits)).toEqual(['f9f7557d']);
    expect(shas(mergeMemoryPayloads(stale, folded).commits)).toEqual(['f9f7557d']);
  });
});
