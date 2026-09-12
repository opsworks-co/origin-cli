// Regression: Claude Code's dev-server launch config is the harness's file,
// not the agent's work.
//
// Opening the Browser pane creates `.claude/launch.json` when the project has
// none, so it lands in whatever turn happened to be open — including one that
// asked for nothing. Prod session 4968c7df (upplabs.com):
//
//   turn 1  "honestly, I think the design of our website is shit… What do you
//            think?"      → edits: [{file: ".claude/launch.json", op: "create"}]
//                           +11 authored lines
//   turn 7  "what is next?"                                   → the matching -11
//
// The session footer showed the gap in the open: `-161 authored · -172 across
// turns`, exactly those 11 lines. Both turns were pure questions.
import { describe, it, expect } from 'vitest';
import { shouldIgnoreFile, stripIgnoredSectionsFromDiff } from '../ignore-patterns.js';

describe('Claude Code launch config is ignored', () => {
  it('ignores .claude/launch.json', () => {
    expect(shouldIgnoreFile('.claude/launch.json')).toBe(true);
  });

  it('ignores it with Windows separators', () => {
    expect(shouldIgnoreFile('.claude\\launch.json')).toBe(true);
  });

  it('still does NOT ignore hand-edited .claude/settings.json', () => {
    // The distinction the ignore list is built on: a person writes settings,
    // tooling writes the launch config.
    expect(shouldIgnoreFile('.claude/settings.json')).toBe(false);
  });

  it('does not ignore a user file that merely ends in launch.json', () => {
    expect(shouldIgnoreFile('src/launch.json')).toBe(false);
    expect(shouldIgnoreFile('config/launch.json')).toBe(false);
  });

  it('strips the create hunk that turn 1 was credited with', () => {
    const diff = [
      'diff --git a/.claude/launch.json b/.claude/launch.json',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.claude/launch.json',
      '@@ -0,0 +1,3 @@',
      '+{',
      '+  "version": "0.0.1"',
      '+}',
      'diff --git a/src/app/globals.css b/src/app/globals.css',
      '--- a/src/app/globals.css',
      '+++ b/src/app/globals.css',
      '@@ -1,1 +1,1 @@',
      '-body { color: black; }',
      '+body { color: white; }',
    ].join('\n');
    const out = stripIgnoredSectionsFromDiff(diff);
    expect(out).not.toContain('.claude/launch.json');
    expect(out).toContain('src/app/globals.css');
  });

  it('strips the delete hunk that turn 7 was credited with', () => {
    const diff = [
      'diff --git a/.claude/launch.json b/.claude/launch.json',
      'deleted file mode 100644',
      'index c7aaf17..0000000',
      '--- a/.claude/launch.json',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-{',
      '-  "version": "0.0.1"',
      '-}',
    ].join('\n');
    expect(stripIgnoredSectionsFromDiff(diff).trim()).toBe('');
  });
});
