/**
 * Commits attributed to the wrong agent by the pgrep sweeps.
 *
 * Reported as "copilot wrote <files>" in the injected repo context for work a
 * Claude Code session had just done. The commits carried
 * `Co-Authored-By: Claude Opus 5` and their Origin git note said
 * `model: 'copilot', sessionId: 'detected-copilot-…'` — the `detected-` prefix
 * means the note came from the no-session pgrep sweep, not from capture.
 *
 * Root cause: GitHub ships a VENDORED GIT under
 * `~/Library/Caches/github-copilot-git-<version>/`, and its
 * `git fsmonitor--daemon` runs permanently (8 of them on the affected machine).
 * Copilot's pattern `copilot.*cli|github-copilot` matched that daemon's PATH —
 * the process is `git`, not Copilot. Copilot sorts FIRST in AGENTS and both
 * sweeps took the first match, so every commit made without a live Origin
 * session was credited to Copilot.
 *
 * Two fixes, pinned here:
 *   1. `copilot` must appear as a command-line TOKEN, not a path substring.
 *   2. The sweeps abstain when several agents match instead of taking the first.
 */
import { describe, it, expect } from 'vitest';
import { attributionPgrepChecks, standalonePgrepChecks } from '../agents/registry.js';
import { pgrepPattern, uniqueMatchingId } from '../utils/process-detect.js';

const copilotPattern = () => {
  const check = standalonePgrepChecks().find((c) => c.model === 'copilot');
  if (!check) throw new Error('copilot standalone check missing');
  return new RegExp(pgrepPattern(check.cmd));
};

// The exact command line observed on the affected machine.
const FSMONITOR_DAEMON =
  '/Users/someone/Library/Caches/github-copilot-git-2.53.0-3/libexec/git-core/git ' +
  'fsmonitor--daemon run --detach --ipc-threads=8';

describe('copilot process pattern', () => {
  it('does NOT match the vendored git daemon in the github-copilot-git cache', () => {
    expect(copilotPattern().test(FSMONITOR_DAEMON)).toBe(false);
  });

  it('does not match other always-on processes that merely contain "copilot"', () => {
    const re = copilotPattern();
    // IDE language server — runs whenever the editor is open, never commits.
    expect(re.test('/Applications/VSCode.app/ms-vscode.copilot-chat/dist/server.js')).toBe(false);
    // A user's own checkout that happens to be named copilot.
    expect(re.test('node /Users/someone/projects/copilot/build.js')).toBe(false);
  });

  it('still matches every real Copilot CLI invocation', () => {
    const re = copilotPattern();
    expect(re.test('/opt/homebrew/bin/copilot')).toBe(true);
    expect(re.test('node /usr/local/lib/node_modules/@github/copilot/index.js --banner')).toBe(true);
    expect(re.test('gh copilot suggest -t shell')).toBe(true);
    expect(re.test('/Users/someone/.local/share/gh/extensions/gh-copilot/gh-copilot suggest')).toBe(true);
    expect(re.test('node /usr/local/bin/github-copilot-cli what-the-shell')).toBe(true);
  });

  it('the attribution sweep uses the same tightened pattern', () => {
    const attr = attributionPgrepChecks().find((c) => c.slug === 'copilot')!;
    expect(new RegExp(pgrepPattern(attr.cmd)).test(FSMONITOR_DAEMON)).toBe(false);
  });
});

describe('uniqueMatchingId — abstain instead of taking the first match', () => {
  const CHECKS = [
    { cmd: 'pgrep -f "copilot"', id: 'copilot' },
    { cmd: 'pgrep -f "codex"', id: 'codex' },
    { cmd: 'pgrep -f "claude"', id: 'claude' },
  ];

  it('returns the single matching agent', () => {
    const { id, matched } = uniqueMatchingId(CHECKS, (cmd) => cmd.includes('claude'));
    expect(id).toBe('claude');
    expect(matched).toEqual(['claude']);
  });

  it('returns null — NOT the first — when several agents match', () => {
    const { id, matched } = uniqueMatchingId(CHECKS, () => true);
    expect(id).toBeNull();
    // The old first-match-wins behaviour would have answered 'copilot' here,
    // which is exactly how a stray daemon out-voted the real agent.
    expect(matched).toEqual(['copilot', 'codex', 'claude']);
  });

  it('returns null when nothing matches', () => {
    expect(uniqueMatchingId(CHECKS, () => false).id).toBeNull();
  });

  it('a probe that throws counts as no match, not a crash', () => {
    const { id } = uniqueMatchingId(CHECKS, (cmd) => {
      if (cmd.includes('copilot')) throw new Error('pgrep blew up');
      return cmd.includes('codex');
    });
    expect(id).toBe('codex');
  });

  it('does not double-count an agent whose pattern appears twice', () => {
    const dupes = [...CHECKS, { cmd: 'pgrep -f "gh-copilot"', id: 'copilot' }];
    const { id } = uniqueMatchingId(dupes, (cmd) => cmd.includes('copilot'));
    expect(id).toBe('copilot');
  });
});
