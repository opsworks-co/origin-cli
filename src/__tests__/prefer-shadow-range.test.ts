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
    // Provenance stays: still this turn's observed work, now in git's rendering.
    expect((mapping as { diffSource?: string }).diffSource).toBe('ledger');
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
});
