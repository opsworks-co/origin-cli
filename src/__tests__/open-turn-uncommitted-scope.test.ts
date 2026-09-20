// The heartbeat's in-flight row starts from `git diff HEAD` + untracked. In a
// shared checkout nothing downstream scopes that to the open turn, so the
// scoping has to happen on the diff itself. See open-turn-uncommitted-scope.ts.
import { describe, it, expect } from 'vitest';
import { scopeUncommittedToOpenTurn } from '../open-turn-uncommitted-scope.js';

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
