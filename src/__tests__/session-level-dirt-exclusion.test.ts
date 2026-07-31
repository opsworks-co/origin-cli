// FIX 3 — the SESSION-LEVEL diff must exclude pre-existing uncommitted dirt.
//
// Reported live: a READ-ONLY Codex prompt ("check whats in this repo") captured
// 13 files / +126 lines the user never touched. The repo had pre-existing
// uncommitted files (leftover test fixtures eight-rows.txt / thirty-two-rows.txt
// from prior sessions) and the SESSION-LEVEL snapshot swept them all in — even
// though the PER-PROMPT mapping correctly reported `uncommittedAfterFilter:0`.
//
// excludeUntouchedSessionStartDirt() is the guard the session-level snapshot now
// applies: drop every file that was dirty at SESSION START and that no prompt in
// the session recorded touching, while keeping files the session actually
// changed (they appear in a prompt mapping's filesChanged).
import { describe, it, expect } from 'vitest';
import { excludeUntouchedSessionStartDirt } from '../commands/hooks.js';

// A session-level working-tree diff shaped like the reported bug: two inherited
// leftover fixtures plus one file the session genuinely edited.
const SESSION_DIFF = `diff --git a/eight-rows.txt b/eight-rows.txt
new file mode 100644
index 0000000..1015fea
--- /dev/null
+++ b/eight-rows.txt
@@ -0,0 +1,3 @@
+row1
+row2
+row3
diff --git a/thirty-two-rows.txt b/thirty-two-rows.txt
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/thirty-two-rows.txt
@@ -0,0 +1,2 @@
+a
+b
diff --git a/app.ts b/app.ts
index 5555555..6666666 100644
--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,3 @@
 export const a = 1;
+export const b = 2;
 export const c = 3;
`;

const filesIn = (diff: string): string[] =>
  [...diff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]);

// The pre-existing dirt recorded at session start (untracked leftovers).
const sessionStartDirty = ['eight-rows.txt', 'thirty-two-rows.txt'];

describe('FIX 3 — session-level pre-existing-dirt exclusion', () => {
  it('a READ-ONLY / chat-only turn (no touched files) drops ALL pre-existing dirt → 0 files', () => {
    // Read-only session: every prompt is chat-only, so filesChanged is empty.
    const promptMappings = [{ filesChanged: [] as string[] }, { filesChanged: [] as string[] }];
    const out = excludeUntouchedSessionStartDirt(SESSION_DIFF, sessionStartDirty, promptMappings);
    // Only the genuinely-edited file survives; the leftover fixtures are gone.
    expect(filesIn(out)).toEqual(['app.ts']);
    expect(out).not.toContain('row1');
    expect(out).not.toContain('eight-rows.txt');
  });

  it('KEEPS a pre-existing-dirty file the session actually touched', () => {
    // The session edited eight-rows.txt this run — it's in a mapping's
    // filesChanged, so it must NOT be dropped even though it was dirty at start.
    const promptMappings = [{ filesChanged: ['eight-rows.txt'] }];
    const out = excludeUntouchedSessionStartDirt(SESSION_DIFF, sessionStartDirty, promptMappings);
    expect(filesIn(out)).toEqual(['eight-rows.txt', 'app.ts']);
    // thirty-two-rows.txt was dirty at start and untouched → dropped.
    expect(out).not.toContain('thirty-two-rows.txt');
  });

  it('keeps turn-authored files that were never dirty at start', () => {
    const promptMappings = [{ filesChanged: ['app.ts'] }];
    const out = excludeUntouchedSessionStartDirt(SESSION_DIFF, sessionStartDirty, promptMappings);
    expect(filesIn(out)).toEqual(['app.ts']);
    expect(out).toContain('+export const b = 2;');
  });

  it('is a no-op when nothing was dirty at session start', () => {
    const out = excludeUntouchedSessionStartDirt(SESSION_DIFF, [], [{ filesChanged: [] }]);
    expect(filesIn(out)).toEqual(['eight-rows.txt', 'thirty-two-rows.txt', 'app.ts']);
  });

  it('handles an empty diff and undefined dirty list without throwing', () => {
    expect(excludeUntouchedSessionStartDirt('', sessionStartDirty, [])).toBe('');
    expect(excludeUntouchedSessionStartDirt(SESSION_DIFF, undefined, [])).toBe(SESSION_DIFF);
  });
});
