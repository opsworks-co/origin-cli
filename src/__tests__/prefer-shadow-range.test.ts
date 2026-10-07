/**
 * A turn's capture is the tree between its shadows, not leftover dirt vs HEAD
 * and not a journal fragment rendered as `@@ -1,6`.
 *
 * Session 4b51bd70: a question turn stored +154 of earlier uncommitted files
 * while `shadow[i] → shadow[i+1]` was the same tree; the authoring turn stored
 * `sessions.ts` as `@@ -1,6 +1,86` for an insert around line 20.
 *
 * Driven against REAL git: the rule turns on tree identity and hunk headers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { preferShadowRangeForTurns } from '../prefer-shadow-range.js';
import type { ShadowRangeMapping } from '../prefer-shadow-range.js';

const LEDGER_NOTES = [
  'diff --git a/notes.md b/notes.md',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -0,0 +1 @@',
  '+remember this',
].join('\n');

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

const BODY = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const INSERTED = BODY.replace('line 12\n', 'line 12\ninserted a\ninserted b\n');

const FAKE_HUNK = [
  'diff --git a/sessions.ts b/sessions.ts',
  '--- a/sessions.ts',
  '+++ b/sessions.ts',
  '@@ -1,6 +1,8 @@',
  ' line 10',
  ' line 11',
  ' line 12',
  '+inserted a',
  '+inserted b',
  ' line 13',
  ' line 14',
  ' line 15',
  '',
].join('\n');

const HEAD_DUMP = [
  'diff --git a/leftover.ts b/leftover.ts',
  '--- a/leftover.ts',
  '+++ b/leftover.ts',
  '@@ -1,1 +1,2 @@',
  ' seed',
  '+still dirty from an earlier turn',
  '',
].join('\n');

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shadow-range-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('sessions.ts', BODY);
  write('leftover.ts', 'seed\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

describe('preferShadowRangeForTurns', () => {
  it('reports each window to the resolver before weighing it against the row', () => {
    write('leftover.ts', 'seed\nstill dirty from an earlier turn\n');
    const shadow0 = createShadowCommit(repo, 'observe0')!;
    write('sessions.ts', INSERTED);
    const shadow1 = createShadowCommit(repo, 'observe1')!;
    expect(shadow0 && shadow1).toBeTruthy();
    const rows: ShadowRangeMapping[] = [
      { promptIndex: 0, filesChanged: ['sessions.ts'], diff: FAKE_HUNK, linesAdded: 2, linesRemoved: 0 },
      { promptIndex: 1, filesChanged: ['leftover.ts'], diff: HEAD_DUMP, linesAdded: 1, linesRemoved: 0 },
    ];
    const seen: Array<[number, unknown]> = [];
    preferShadowRangeForTurns(
      { promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: shadow1 }], prompts: ['a', 'b'] },
      rows, repo, { observe: (i, o) => seen.push([i, o]) },
    );
    expect(seen).toEqual([
      [0, { source: 'turn-window', outcome: 'applied', files: ['sessions.ts'], diff: rows[0].diff, added: 2, removed: 0, contentUnavailable: [] }],
      [1, { source: 'turn-window', outcome: 'empty', completeBaseline: false }],
    ]);
  });

  it('reports a contended tree as a decline for every row', () => {
    const seen: Array<[number, unknown]> = [];
    preferShadowRangeForTurns(
      { contendingSessionIds: ['peer'], promptShadows: [{ promptIndex: 0, shadowSha: 'abc1234' }] },
      [{ promptIndex: 0 }], repo, { observe: (i, o) => seen.push([i, o]) },
    );
    expect(seen).toEqual([[0, { source: 'turn-window', outcome: 'declined', reason: 'another live session shares this working tree' }]]);
  });

  it('blanks a question turn whose shadow window is empty, even when HEAD..worktree is dirty', () => {
    write('leftover.ts', 'seed\nstill dirty from an earlier turn\n');
    const shadow0 = createShadowCommit(repo, 'turn0');
    expect(shadow0).toBeTruthy();
    // Next prompt starts: tree has not moved, but we still cut a new shadow
    // (different object, same tree) — the question turn's window.
    const shadow1 = createShadowCommit(repo, 'turn1');
    expect(shadow1).toBeTruthy();
    expect(shadow1).not.toBe(shadow0);

    const mapping = {
      promptIndex: 0,
      filesChanged: ['leftover.ts'],
      diff: HEAD_DUMP,
      uncommittedDiff: HEAD_DUMP,
      linesAdded: 1,
      linesRemoved: 0,
    };
    const n = preferShadowRangeForTurns(
      {
        promptShadows: [
          { promptIndex: 0, shadowSha: shadow0! },
          { promptIndex: 1, shadowSha: shadow1! },
        ],
        prompts: ['edit leftover', 'how many edits'],
      },
      [mapping],
      repo,
    );
    expect(n).toBe(1);
    expect(mapping.diff).toBe('');
    expect(mapping.filesChanged).toEqual([]);
    expect(mapping.linesAdded).toBe(0);
    expect(mapping.linesRemoved).toBe(0);
    expect((mapping as ShadowRangeMapping).chatOnly).toBe(true);
  });

  it("keeps a turn that wrote in a linked worktree the window cannot see", () => {
    // Session 9f3d6bd2 turn 1: a sub-agent wrote a test in its own worktree.
    // repoPath's window was empty (another checkout), and the row went out chat-only.
    write('leftover.ts', 'seed\nstill dirty from an earlier turn\n');
    const shadow0 = createShadowCommit(repo, 'turn0')!;
    const shadow1 = createShadowCommit(repo, 'turn1')!;
    const AGENT = ['diff --git a/src/agent.test.ts b/src/agent.test.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/agent.test.ts', '@@ -0,0 +1 @@', "+it('works', () => {});", ''].join('\n');
    const row = (): ShadowRangeMapping => ({ promptIndex: 0, filesChanged: ['src/agent.test.ts'], diff: AGENT, linesAdded: 1, linesRemoved: 0 });
    const state = (tree?: string) => ({
      promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: shadow1 }],
      prompts: ['fix it, and add a test', 'merge it'],
      liveEdits: [{ promptIndex: 0, ...(tree ? { tree } : {}) }],
    });
    const seen: Array<[number, unknown]> = [];
    const kept = row();
    expect(preferShadowRangeForTurns(state('/repo/.claude/worktrees/agent-1'), [kept], repo, { observe: (i, o) => seen.push([i, o]) })).toBe(0);
    expect(kept).toEqual(row());
    expect(seen).toEqual([[0, { source: 'turn-window', outcome: 'declined', reason: 'the turn wrote in a linked worktree this window does not cover' }]]);
    // The same edit in repoPath itself is still judged by the window.
    const judged = row();
    expect(preferShadowRangeForTurns(state(), [judged], repo)).toBe(1);
    expect(judged.filesChanged).toEqual([]);
  });

  it('replaces an unanchored @@ -1,N journal hunk with git\'s real line number', () => {
    // A clean tree cannot mint a shadow (createShadowCommit no-ops when the
    // tree matches HEAD). Leave leftover dirt sitting so the baseline is a
    // real shadow, then edit sessions.ts only.
    write('leftover.ts', 'seed\nstill dirty from an earlier turn\n');
    const shadow0 = createShadowCommit(repo, 'turn0');
    expect(shadow0).toBeTruthy();
    write('sessions.ts', INSERTED);
    const shadow1 = createShadowCommit(repo, 'turn1');
    expect(shadow1).toBeTruthy();

    const mapping = {
      promptIndex: 0,
      filesChanged: ['sessions.ts'],
      diff: FAKE_HUNK,
      linesAdded: 2,
      linesRemoved: 0,
      diffSource: 'ledger' as const,
    };
    const n = preferShadowRangeForTurns(
      {
        promptShadows: [
          { promptIndex: 0, shadowSha: shadow0! },
          { promptIndex: 1, shadowSha: shadow1! },
        ],
        prompts: ['insert', 'next'],
      },
      [mapping],
      repo,
    );
    expect(n).toBe(1);
    expect(mapping.diff).not.toContain('@@ -1,6 +1,8 @@');
    expect(mapping.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(mapping.diff).toContain('+inserted a');
    expect(mapping.filesChanged).toEqual(['sessions.ts']);
    expect(mapping.linesAdded).toBe(2);
    expect(mapping.linesRemoved).toBe(0);
    // Provenance names the complete tree window used for the replacement.
    expect((mapping as { diffSource?: string }).diffSource).toBe('turn-window');
  });

  it('does not paint the live worktree onto an earlier turn that has no next shadow', () => {
    write('leftover.ts', 'seed\nstill dirty from an earlier turn\n');
    const shadow0 = createShadowCommit(repo, 'turn0');
    write('sessions.ts', INSERTED); // later turn's work, sitting in the live tree
    const mapping = {
      promptIndex: 0,
      filesChanged: ['leftover.ts'],
      diff: HEAD_DUMP,
      linesAdded: 1,
      linesRemoved: 0,
    };
    const n = preferShadowRangeForTurns(
      {
        promptShadows: [{ promptIndex: 0, shadowSha: shadow0! }],
        // Two prompts: turn 0 is complete, turn 1 is current. Turn 0 has no
        // next shadow, so the live tree (which includes turn 1) must not win.
        prompts: ['earlier', 'current'],
      },
      [mapping],
      repo,
    );
    expect(n).toBe(0);
    expect(mapping.diff).toBe(HEAD_DUMP);
  });

  it('scopes the in-flight turn to shadow → worktree, not HEAD', () => {
    write('leftover.ts', 'seed\nstill dirty from an earlier turn\n');
    const shadow0 = createShadowCommit(repo, 'turn0');
    // The in-flight turn writes nothing. Worktree matches its start shadow.
    const mapping = {
      promptIndex: 0,
      filesChanged: ['leftover.ts'],
      diff: HEAD_DUMP,
      linesAdded: 1,
      linesRemoved: 0,
    };
    const n = preferShadowRangeForTurns(
      {
        promptShadows: [{ promptIndex: 0, shadowSha: shadow0! }],
        prompts: ['how many edits'],
      },
      [mapping],
      repo,
    );
    expect(n).toBe(1);
    expect(mapping.diff).toBe('');
    expect((mapping as ShadowRangeMapping).chatOnly).toBe(true);
  });

  it('keeps a ledger-captured turn whose shadow was cut AFTER it wrote', () => {
    // A turn nobody announced is discovered by after-file-edit, which anchors
    // its shadow at DISCOVERY — already after the write that revealed it. The
    // window against that shadow is empty even though the turn plainly worked,
    // so an empty window must not outrank the ledger, which has the journal
    // marks bounding the turn. Blanking here deleted the only edit turn 2 ever
    // made: `capture-e2e-cursor-binary` "never announced — discovered by
    // afterFileEdit".
    write('notes.md', 'remember this\n');
    const lateShadow = createShadowCommit(repo, 'discovered');
    expect(lateShadow).toBeTruthy();

    const mapping = {
      promptIndex: 0,
      filesChanged: ['notes.md'],
      diff: LEDGER_NOTES,
      linesAdded: 1,
      linesRemoved: 0,
      diffSource: 'ledger' as const,
    };
    const n = preferShadowRangeForTurns(
      {
        promptShadows: [{ promptIndex: 0, shadowSha: lateShadow! }],
        prompts: ['now leave a note'],
      },
      [mapping],
      repo,
    );
    expect(n).toBe(0);
    expect(mapping.filesChanged).toEqual(['notes.md']);
    expect(mapping.diff).toBe(LEDGER_NOTES);
    expect((mapping as ShadowRangeMapping).chatOnly).toBeUndefined();
  });

  // TODO f7406e7e: a shadow cut when the turn was NOTICED (Cursor adoption,
  // the Codex heartbeat) already holds the turn's first edit.
  it('does not blank a turn whose start shadow was cut after it began writing', () => {
    const shadow0 = createShadowCommit(repo, 'late0')!;
    write('sessions.ts', INSERTED);                    // turn 1's edit…
    const lateShadow1 = createShadowCommit(repo, 'late1')!; // …then the cut
    const row: ShadowRangeMapping = { promptIndex: 1, filesChanged: ['sessions.ts'], diff: FAKE_HUNK, linesAdded: 2, linesRemoved: 0 };
    const seen: Array<[number, unknown]> = [];
    preferShadowRangeForTurns(
      { promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: lateShadow1, cutAfterTurnStart: true }], prompts: ['a', 'b'] },
      [row], repo, { observe: (i, o) => seen.push([i, o]) },
    );
    expect(row.filesChanged).toEqual(['sessions.ts']);
    expect(row.diff).toBe(FAKE_HUNK);
    expect(seen).toEqual([[1, { source: 'turn-window', outcome: 'declined', reason: 'the start shadow was cut after the turn began' }]]);
  });

  it("does not end a turn's window at the next turn's late-cut shadow", () => {
    const shadow0 = createShadowCommit(repo, 'end0')!;
    write('leftover.ts', 'seed\nturn 1 wrote this before anyone noticed it\n');
    const lateShadow1 = createShadowCommit(repo, 'end1')!;
    const row: ShadowRangeMapping = { promptIndex: 0, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 };
    const seen: Array<[number, unknown]> = [];
    preferShadowRangeForTurns(
      { promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: lateShadow1, cutAfterTurnStart: true }], prompts: ['a', 'b'] },
      [row], repo, { observe: (i, o) => seen.push([i, o]) },
    );
    expect(row.filesChanged).toEqual([]);
    expect(seen).toEqual([[0, { source: 'turn-window', outcome: 'declined', reason: 'the next shadow was cut after its turn began' }]]);
  });
});

