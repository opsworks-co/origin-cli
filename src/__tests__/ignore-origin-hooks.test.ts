// Regression: Origin's own hook-config files (written by `origin enable`)
// must never be attributed to an agent session. On the first native-Windows
// session they leaked into the "Full Session Diff" as a phantom "+72"
// (.devin/hooks.v1.json + .windsurf/hooks.json) — Origin's bookkeeping, not
// the agent's work. They belong in the ignore list alongside AGENTS.md.

import { describe, it, expect } from 'vitest';
import { shouldIgnoreFile, stripIgnoredSectionsFromDiff } from '../ignore-patterns.js';

const ORIGIN_HOOK_FILES = [
  '.devin/hooks.v1.json',
  '.windsurf/hooks.json',
  '.cursor/hooks.json',
  '.codex/hooks.json',
  '.github/hooks/origin.json',
  '.agents/hooks.json',
];

describe('Origin hook-config files are ignored', () => {
  for (const f of ORIGIN_HOOK_FILES) {
    it(`shouldIgnoreFile("${f}") === true`, () => {
      expect(shouldIgnoreFile(f)).toBe(true);
    });
    it(`shouldIgnoreFile handles Windows separators for "${f}"`, () => {
      expect(shouldIgnoreFile(f.replace(/\//g, '\\'))).toBe(true);
    });
  }

  it('does NOT ignore user-owned shared settings files', () => {
    // A user may hand-edit these; only the dedicated Origin hook files are stripped.
    expect(shouldIgnoreFile('.claude/settings.json')).toBe(false);
    expect(shouldIgnoreFile('.gemini/settings.json')).toBe(false);
  });

  it('strips the Origin hook-config sections from a unified diff', () => {
    const diff = [
      'diff --git a/.devin/hooks.v1.json b/.devin/hooks.v1.json',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.devin/hooks.v1.json',
      '@@ -0,0 +1,2 @@',
      '+{',
      '+  "SessionStart": []',
      'diff --git a/src/app.ts b/src/app.ts',
      'index 111..222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,2 @@',
      ' const x = 1;',
      '+const y = 2;',
    ].join('\n');
    const stripped = stripIgnoredSectionsFromDiff(diff);
    expect(stripped).not.toContain('.devin/hooks.v1.json');
    expect(stripped).toContain('src/app.ts');
    expect(stripped).toContain('const y = 2;');
  });
});
