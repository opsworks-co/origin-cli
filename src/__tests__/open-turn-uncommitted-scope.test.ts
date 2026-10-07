// The heartbeat's in-flight row starts from `git diff HEAD` + untracked. In a
// shared checkout nothing downstream scopes that to the open turn, so the
// scoping has to happen on the diff itself. See open-turn-uncommitted-scope.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openTurnNarrowingBase, scopeUncommittedToOpenTurn } from '../open-turn-uncommitted-scope.js';
import { createShadowCommit, filesChangedSinceShadowOrNull } from '../git-capture.js';

const section = (file: string, line: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n ctx\n+${line}\n`;
const DIRTY = section('src/mine.py', 'mine_new = 1') + '\n' + section('src/sib.py', 'sib_0 = 0') + '\n' + section('src/now.py', 'now = 1');

describe('scopeUncommittedToOpenTurn', () => {
  it('drops a file that has not moved since the turn began', () => {
    const out = scopeUncommittedToOpenTurn(DIRTY, { changedSinceTurnStart: ['src/now.py'], claimedByOthers: [] });
    expect(out).toContain('src/now.py');
    expect(out).not.toMatch(/mine_new|sib_0/);
  });

  it('drops a file another live session claims even though it moved inside the turn', () => {
    const out = scopeUncommittedToOpenTurn(DIRTY, {
      changedSinceTurnStart: ['src/now.py', 'src/sib.py'], claimedByOthers: ['src/sib.py'],
    });
    expect(out).toContain('+now = 1');
    expect(out).not.toContain('sib_0');
  });

  it('is empty when nothing moved: the turn that only said thanks', () => {
    expect(scopeUncommittedToOpenTurn(DIRTY, { changedSinceTurnStart: [], claimedByOthers: [] })).toBe('');
  });

  it('narrows nothing when the turn-start read failed', () => {
    expect(scopeUncommittedToOpenTurn(DIRTY, { changedSinceTurnStart: null, claimedByOthers: [] })).toBe(DIRTY);
    const out = scopeUncommittedToOpenTurn(DIRTY, { changedSinceTurnStart: null, claimedByOthers: ['src/sib.py'] });
    expect(out).toContain('mine_new');
    expect(out).not.toContain('sib_0');
  });

  it('keeps a section whose file name it cannot read', () => {
    const quoted = 'diff --git "a/sp\\303\\244ce.py" "b/sp\\303\\244ce.py"\n+++ "b/sp\\303\\244ce.py"\n+x = 1\n';
    expect(scopeUncommittedToOpenTurn(quoted, { changedSinceTurnStart: [], claimedByOthers: [] })).toBe(quoted);
  });

  it('returns the text untouched when every section stays', () => {
    expect(scopeUncommittedToOpenTurn(DIRTY, {
      changedSinceTurnStart: ['src/mine.py', 'src/sib.py', 'src/now.py'], claimedByOthers: [],
    })).toBe(DIRTY);
  });
});

// TODO f7406e7e: a shadow cut AFTER the turn began writing is not its start.
describe('openTurnNarrowingBase', () => {
  const shadows = (cut: boolean) => [
    { promptIndex: 0, shadowSha: 's0' },
    { promptIndex: 1, shadowSha: 's1', ...(cut ? { cutAfterTurnStart: true } : {}) },
  ];

  it("is the turn's own shadow when it was cut at the turn's start", () => {
    expect(openTurnNarrowingBase({ promptShadows: shadows(false) }, 1)).toBe('s1');
  });
  it('is the tree the previous turn closed on when the own shadow was cut late', () => {
    expect(openTurnNarrowingBase({ promptShadows: shadows(true), turnEndShadows: [{ promptIndex: 0, shadowSha: 'e0' }] }, 1)).toBe('e0');
  });
  it('is the session-start shadow for a late-cut FIRST turn', () => {
    const st = { promptShadows: [{ promptIndex: 0, shadowSha: 's0', cutAfterTurnStart: true }], sessionStartShadowSha: 'start' };
    expect(openTurnNarrowingBase(st, 0)).toBe('start');
  });
  it('is unknown — narrow nothing — when a late cut has no earlier tree to fall back on', () => {
    expect(openTurnNarrowingBase({ promptShadows: shadows(true) }, 1)).toBeNull();
    expect(openTurnNarrowingBase({ promptShadows: [] }, 1)).toBeNull();
  });
});

describe('a late-cut shadow keeps the file the turn wrote before the cut (real git)', () => {
  let repo = '';
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  it("Cursor adoption: the edit that revealed the turn is in the adoption's shadow", () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-late-shadow-')));
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'earlier.ts'), 'turn 0 left this\n');
    const endOfTurn0 = createShadowCommit(repo, 'end0')!;       // Stop closed turn 0 here
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a\nturn 1\n');  // turn 1's first (and only) edit
    const adoption = createShadowCommit(repo, 'adopt1')!;       // cut AFTER it
    expect(endOfTurn0).toBeTruthy(); expect(adoption).toBeTruthy();

    const state = {
      promptShadows: [{ promptIndex: 0, shadowSha: 'x' }, { promptIndex: 1, shadowSha: adoption, cutAfterTurnStart: true }],
      turnEndShadows: [{ promptIndex: 0, shadowSha: endOfTurn0 }],
    };
    // The late shadow says turn 1 changed nothing — the bug.
    expect(filesChangedSinceShadowOrNull(repo, adoption)).not.toContain('a.ts');
    // Narrowing from where turn 1 really began keeps its file, and still
    // leaves turn 0's uncommitted file out.
    const moved = filesChangedSinceShadowOrNull(repo, openTurnNarrowingBase(state, 1)!);
    expect(moved).toContain('a.ts');
    expect(moved).not.toContain('earlier.ts');
  });
});

