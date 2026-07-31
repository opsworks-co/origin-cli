// Regression: Origin billed its OWN injected context files as the agent's work.
//
// Reported live (Devin session 5c7cf505, repo `suchara`): the turn was a pure
// question — "what the hell is going on here?" — that changed no code. The
// per-prompt mapping correctly recorded `files: [], diff: ''`, yet the session
// header read "+52 / −0 lines" next to "0 files changed".
//
// +52 was exactly Origin's own bookkeeping:
//     CLAUDE.md                18 lines
//     .devin/rules/origin.md   32 lines
//                              ── 50  (+2 `diff --git` headers)
//
// Cause: the heartbeat's own `stripFiles` only drops PRE-EXISTING dirt the
// session hasn't touched. Origin WRITES CLAUDE.md / .devin/rules/origin.md at
// session start, so they count as "touched by this session", survive that
// filter, and the heartbeat never applied the auto-managed/ignored strip.
// publishPromptChange now runs stripIgnoredSectionsFromDiff on both diffs.

import { describe, it, expect } from 'vitest';
import { stripIgnoredSectionsFromDiff } from '../ignore-patterns.js';

const section = (file: string, adds: string[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${adds.length} @@\n` +
  adds.map((l) => `+${l}`).join('\n') + '\n';

const addedLines = (diff: string): number =>
  diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;

const filesIn = (diff: string): string[] =>
  [...diff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]);

describe("heartbeat strips Origin's own injected files", () => {
  it('a chat-only turn that touched ONLY Origin bookkeeping counts zero lines', () => {
    const diff =
      section('CLAUDE.md', ['origin ctx 1', 'origin ctx 2']) +
      section('.devin/rules/origin.md', ['devin rule 1', 'devin rule 2']);
    const stripped = stripIgnoredSectionsFromDiff(diff);
    expect(filesIn(stripped)).toEqual([]);
    expect(addedLines(stripped)).toBe(0);
  });

  it("keeps the agent's real work while dropping Origin's files", () => {
    const diff =
      section('CLAUDE.md', ['origin ctx']) +
      section('src/app.ts', ['const real = 1;', 'const work = 2;']) +
      section('.devin/rules/origin.md', ['devin rule']);
    const stripped = stripIgnoredSectionsFromDiff(diff);
    expect(filesIn(stripped)).toEqual(['src/app.ts']);
    expect(addedLines(stripped)).toBe(2);
  });

  it('covers every per-agent context file Origin writes', () => {
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.windsurfrules', '.devin/rules/origin.md']) {
      const stripped = stripIgnoredSectionsFromDiff(section(f, ['x']));
      expect(filesIn(stripped)).toEqual([]);
    }
  });

  it('does NOT strip .gitignore — a real user-requested change stays attributed', () => {
    const stripped = stripIgnoredSectionsFromDiff(section('.gitignore', ['node_modules']));
    expect(filesIn(stripped)).toEqual(['.gitignore']);
  });
});
