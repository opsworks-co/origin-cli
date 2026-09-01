// `Commit.message` reached the server as the SUBJECT LINE only, so the
// `Origin-Session:` trailer our own prepare-commit-msg hook writes into the
// body never got there — and every server-side ownership guard reads that
// trailer off `commit.message`.
//
// Session b05c4b43: commit 35058c5d, body `Origin-Session: 59a0fa03-dc5`,
// rendered on b05c4b43's timeline and badged a turn that had written nothing.
// The guards (commitNamesOtherSession, on the FK path, the display list and
// the injected sweep) all take "no trailer" to mean "leave it alone" — correct
// when the message is whole, blind when it was truncated at capture. Commits
// arriving by webhook kept their bodies, so only local concurrent-agent
// commits — the exact case the trailer exists for — were affected.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { capCommitMessage, captureGitState } from '../git-capture.js';
import { pickSessionForCommit } from '../commands/hooks.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

describe('capCommitMessage', () => {
  it('keeps a whole message intact', () => {
    const msg = 'fix(x): subject\n\nbody line\n\nOrigin-Session: 59a0fa03-dc5 | Claude Code | 1 prompt';
    expect(capCommitMessage(msg)).toBe(msg);
  });

  it('truncates from the MIDDLE so the trailer survives', () => {
    // Trailers are the last lines of a message. Head-truncation would cut off
    // exactly the evidence this whole change exists to preserve.
    const trailer = 'Origin-Session: 59a0fa03-dc5 | Claude Code | 1 prompt';
    const huge = `subject\n\n${'x'.repeat(50_000)}\n\n${trailer}`;
    const out = capCommitMessage(huge, 2000);
    expect(out.length).toBeLessThanOrEqual(2100);
    expect(out).toContain(trailer);
    expect(out.startsWith('subject')).toBe(true);
  });

  it('handles empty input', () => {
    expect(capCommitMessage('')).toBe('');
    expect(capCommitMessage('  \n ')).toBe('');
  });
});

describe('captureGitState commitDetails', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-msgbody-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('carries the Origin-Session trailer through to the payload', () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add', '.');
    git(
      repo, 'commit', '-q', '-m',
      'fix(copilot): two prompts stop rendering as five\n\n'
      + 'Some body prose.\n\n'
      + 'Origin-Session: 59a0fa03-dc5 | Claude Code | 1 prompt',
    );

    const capture = captureGitState(repo, before, { fullContext: true });
    const detail = capture.commitDetails.find((c) => c.message.includes('two prompts'));
    expect(detail).toBeDefined();
    // The whole point — without this the server cannot tell whose commit it is.
    expect(detail!.message).toContain('Origin-Session: 59a0fa03-dc5');
    // Subject still leads, so anything reading the first line is unaffected.
    expect(detail!.message.split('\n', 1)[0]).toBe(
      'fix(copilot): two prompts stop rendering as five',
    );
  });

  it('leaves a trailerless commit as a plain subject', () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nthree\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'chore: no trailer here');

    const capture = captureGitState(repo, before, { fullContext: true });
    const detail = capture.commitDetails.find((c) => c.message.includes('no trailer'));
    expect(detail!.message).toBe('chore: no trailer here');
  });
});

// The other half: with the body preserved, the commit's own trailer must
// actually DECIDE who owns it. pickSessionForCommit guessed from pgrep, branch
// and file overlap and never asked.
describe('pickSessionForCommit — Origin-Session trailer rung', () => {
  const mine = { sessionId: 'b05c4b43-5ca9-4bc1-ad88-0eee4bfd1e91', branch: 'main', startedAt: '2026-08-25T09:00:00Z' };
  const sibling = { sessionId: '59a0fa03-dc5a-4a1b-9c2d-3e4f5a6b7c8d', branch: 'main', startedAt: '2026-08-25T09:30:00Z' };
  const body = (id: string) => `fix(copilot): two prompts stop rendering as five\n\nOrigin-Session: ${id} | Claude Code | 1 prompt`;

  it('gives the commit to the session its trailer names', () => {
    const picked = pickSessionForCommit([mine, sibling], { commitMessage: body('59a0fa03-dc5') });
    expect(picked.reason).toBe('trailer');
    expect(picked.session?.sessionId).toBe(sibling.sessionId);
  });

  it('outranks the rungs that got b05c4b43 wrong', () => {
    // Both on `main`, and the commit's files are the sibling's — but file
    // overlap is exactly the kind of guess the trailer replaces.
    const picked = pickSessionForCommit([mine, sibling], {
      commitMessage: body('59a0fa03-dc5'),
      currentBranch: 'main',
      commitFiles: ['packages/cli/src/commands/hooks.ts'],
    });
    expect(picked.session?.sessionId).toBe(sibling.sessionId);
  });

  it('does not claim a lone session just because it is the only one', () => {
    // The owner's state file need not be among those listed — one active
    // session is not evidence that the commit is that session's.
    const picked = pickSessionForCommit([mine], { commitMessage: body('59a0fa03-dc5') });
    expect(picked.reason).toBe('only'); // NOT 'trailer'
  });

  it('stays out of it when the trailer names nobody live here', () => {
    // Amend/rebase leaves a stale trailer; the rungs below must still decide.
    const picked = pickSessionForCommit([mine, sibling], {
      commitMessage: body('deadbeef-000'),
      currentBranch: 'main',
    });
    expect(picked.reason).not.toBe('trailer');
  });

  it('treats two sessions matching one truncated id as ambiguous, not a pick', () => {
    const twin = { ...mine, sessionId: 'b05c4b43-5ca9-0000-0000-000000000000' };
    const picked = pickSessionForCommit([mine, twin], { commitMessage: body('b05c4b43-5ca') });
    expect(picked.reason).not.toBe('trailer');
  });

  it('is unaffected by a message with no trailer', () => {
    const picked = pickSessionForCommit([mine, sibling], { commitMessage: 'chore: nothing here' });
    expect(picked.reason).not.toBe('trailer');
  });
});
