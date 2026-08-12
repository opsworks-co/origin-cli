// Identifying a commit when the turn never printed its sha.
//
// The prose reader only works when the agent chose to mention the sha; plenty
// of turns just say "done". The `git commit …` command IS recorded either way,
// and the message is inside it — so instead of parsing that message out (agents
// quote it at least three ways: double quotes, a PowerShell here-string, and
// `$(@'…'@)`), ask the question backwards and look for the repo's own commit
// subjects inside the command text. Quoting style stops mattering.
//
// Measured honestly on this machine's Cursor corpus: of 20 committing turns,
// every one had already reported its sha, so this recovered nothing there. It
// is a fallback for agents/models that stay quiet, and it is built to fail
// closed — the tests below pin that, because a fallback that guesses is worse
// than no fallback at all.

import { describe, it, expect } from 'vitest';
import { matchCommitByCommand } from '../transcript-watch.js';

const commits = [
  { sha: 'a'.repeat(40), subject: 'add stellar_warp.py hyperspace tunnel visualizer script' },
  { sha: 'b'.repeat(40), subject: 'add aurora_flux.py northern lights particle curtain visualizer' },
  { sha: 'c'.repeat(40), subject: 'wip' },
];

describe('matchCommitByCommand', () => {
  it('matches a plain double-quoted -m message', () => {
    const cmd = ['git add stellar_warp.py; git commit -m "add stellar_warp.py hyperspace tunnel visualizer script"; git status'];
    expect(matchCommitByCommand(cmd, commits)).toBe('a'.repeat(40));
  });

  it('matches a PowerShell here-string message', () => {
    // The real shape Cursor emits on Windows.
    const cmd = ["git add sosiska; git commit -m @'\nadd aurora_flux.py northern lights particle curtain visualizer\n'@; git status"];
    expect(matchCommitByCommand(cmd, commits)).toBe('b'.repeat(40));
  });

  it('matches a here-string wrapped in a subshell', () => {
    const cmd = ['git commit -m "$(@\'\nadd stellar_warp.py hyperspace tunnel visualizer script\n\nEOF\n\'@)"'];
    expect(matchCommitByCommand(cmd, commits)).toBe('a'.repeat(40));
  });

  it('ignores subjects too short to be evidence', () => {
    // "wip" appears in all sorts of command text. A short subject is not a
    // fingerprint, so it must never be treated as one.
    expect(matchCommitByCommand(['git commit -m "wip"'], commits)).toBeNull();
  });

  it('returns null when two commits both match', () => {
    // Two commits sharing a message means the command cannot distinguish them.
    // Picking either would be a coin flip presented as attribution.
    const dupes = [
      { sha: 'd'.repeat(40), subject: 'add the visualizer script for the demo' },
      { sha: 'e'.repeat(40), subject: 'add the visualizer script for the demo' },
    ];
    const cmd = ['git commit -m "add the visualizer script for the demo"'];
    expect(matchCommitByCommand(cmd, dupes)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchCommitByCommand(['git commit -m "something else entirely here"'], commits)).toBeNull();
  });

  it('returns null for empty input on either side', () => {
    expect(matchCommitByCommand([], commits)).toBeNull();
    expect(matchCommitByCommand(['git commit -m "add stellar_warp.py hyperspace tunnel visualizer script"'], [])).toBeNull();
  });

  it('searches across several commands in the same turn', () => {
    // A turn can run more than one shell call; the commit may be in any of them.
    const cmds = ['git status', 'git add -A', 'git commit -m "add aurora_flux.py northern lights particle curtain visualizer"'];
    expect(matchCommitByCommand(cmds, commits)).toBe('b'.repeat(40));
  });

  it('tolerates a missing subject on a candidate', () => {
    const withBlank = [...commits, { sha: 'f'.repeat(40), subject: '' }];
    expect(matchCommitByCommand(['git commit -m "add stellar_warp.py hyperspace tunnel visualizer script"'], withBlank))
      .toBe('a'.repeat(40));
  });
});
