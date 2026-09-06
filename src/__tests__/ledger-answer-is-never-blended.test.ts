// The ledger's answer for a turn is adopted whole or left alone — never voted
// against a reconstruction. Three places used to be able to blend it:
//
//   • keepRicherTurnCapture settles a re-Stop by string length, so a prior
//     ledger diff was one opinion against a fresh guess;
//   • mergePromptMappings let a non-empty transcript reconstruction displace a
//     saved ledger row;
//   • attachOrphanCommitFiles bolted `git show` sections for files the ledger
//     never saw onto the committing turn's observed diff.
//
// And the state round-trip picked `diffSource` but dropped `ledgerOwned`, so
// the "never rebuild from a commit" guard was lost on the way to the next Stop.
import { describe, it, expect } from 'vitest';
import { keepRicherTurnCapture, mergePromptMappings } from '../commands/hooks.js';
import { attachOrphanCommitFiles } from '../prompt-completeness.js';
import { dedupeSessions } from '../commands/verify-capture.js';

const ledgerDiff = 'diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n';
const guessDiff = 'diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,3 +1,3 @@\n-old\n+new\n context\n context\n' + 'diff --git a/other.py b/other.py\n--- a/other.py\n+++ b/other.py\n@@ -1 +1 @@\n-a\n+b\n';

describe('keepRicherTurnCapture', () => {
  it('adopts a prior ledger answer whole instead of voting it against a longer guess', () => {
    const current = [{ promptIndex: 0, filesChanged: ['app.py', 'other.py'], diff: guessDiff }];
    const prior = [{ promptIndex: 0, filesChanged: ['app.py'], diff: ledgerDiff, diffSource: 'ledger' as const, linesAdded: 1, linesRemoved: 1 }];
    const out = keepRicherTurnCapture(current, prior);
    expect(out[0].diff).toBe(ledgerDiff);
    expect(out[0].filesChanged).toEqual(['app.py']);
    expect((out[0] as { diffSource?: string }).diffSource).toBe('ledger');
  });

  it('still blends two reconstructions exactly as before', () => {
    const current = [{ promptIndex: 0, filesChanged: ['app.py'], diff: ledgerDiff }];
    const prior = [{ promptIndex: 0, filesChanged: ['app.py', 'other.py'], diff: guessDiff }];
    const out = keepRicherTurnCapture(current, prior);
    expect(out[0].filesChanged.sort()).toEqual(['app.py', 'other.py']);
    expect(out[0].diff).toBe(guessDiff);
  });
});

describe('mergePromptMappings', () => {
  it('keeps a saved ledger row over a non-empty transcript reconstruction', () => {
    const saved = [{ promptIndex: 0, filesChanged: ['app.py'], diff: ledgerDiff, diffSource: 'ledger' as const }];
    const fromTranscript = [{ promptIndex: 0, filesChanged: ['app.py', 'other.py'], diff: guessDiff }];
    const out = mergePromptMappings(saved as any, fromTranscript as any);
    expect(out[0].diff).toBe(ledgerDiff);
    expect((out[0] as { diffSource?: string }).diffSource).toBe('ledger');
  });

  it('lets a fresh ledger row replace an older ledger row', () => {
    const saved = [{ promptIndex: 0, filesChanged: ['app.py'], diff: ledgerDiff, diffSource: 'ledger' as const }];
    const fresh = [{ promptIndex: 0, filesChanged: ['app.py', 'other.py'], diff: guessDiff, diffSource: 'ledger' as const }];
    const out = mergePromptMappings(saved as any, fresh as any);
    expect(out[0].diff).toBe(guessDiff);
  });
});

describe('attachOrphanCommitFiles', () => {
  it('does not bolt a commit-only file onto a ledger-owned turn', () => {
    const changes = [{ diff: ledgerDiff, filesChanged: ['app.py'], commitSha: 'a'.repeat(40), diffSource: 'ledger' as const }];
    const mutated = attachOrphanCommitFiles(
      changes,
      [{ sha: 'a'.repeat(40), filesChanged: ['app.py', 'swept.py'] }],
      () => 'diff --git a/swept.py b/swept.py\n--- a/swept.py\n+++ b/swept.py\n@@ -1 +1 @@\n-x\n+y\n',
    );
    expect(mutated).toBe(false);
    expect(changes[0].filesChanged).toEqual(['app.py']);
    expect(changes[0].diff).toBe(ledgerDiff);
  });

  it('still attaches to a reconstructed turn', () => {
    const changes = [{ diff: ledgerDiff, filesChanged: ['app.py'], commitSha: 'a'.repeat(40) }];
    const mutated = attachOrphanCommitFiles(
      changes,
      [{ sha: 'a'.repeat(40), filesChanged: ['app.py', 'swept.py'] }],
      () => 'diff --git a/swept.py b/swept.py\n--- a/swept.py\n+++ b/swept.py\n@@ -1 +1 @@\n-x\n+y\n',
    );
    expect(mutated).toBe(true);
    expect(changes[0].filesChanged).toEqual(['app.py', 'swept.py']);
  });
});

describe('verify-capture dedupeSessions', () => {
  it('counts a session once when its state file exists in the repo and the home mirror', () => {
    const repoCopy = { sessionId: 's1', turns: [1, 2, 3], source: '/repo/.git/origin-session-abc.json' };
    const mirror = { sessionId: 's1', turns: [1, 2, 3], source: '/home/u/.origin/sessions/s1.json' };
    const out = dedupeSessions([mirror, repoCopy]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe(repoCopy.source);
  });

  it('recognises the mirror whichever way its path is spelled', () => {
    const repoCopy = { sessionId: 's1', turns: [1], source: 'C:\\repo\\.git\\origin-session-abc.json' };
    const mirror = { sessionId: 's1', turns: [1], source: 'C:\\Users\\u\\.origin\\sessions\\s1.json' };
    expect(dedupeSessions([mirror, repoCopy])[0].source).toBe(repoCopy.source);
  });

  it('prefers the copy that carries more turns', () => {
    const stale = { sessionId: 's1', turns: [1], source: '/repo/.git/origin-session-abc.json' };
    const fuller = { sessionId: 's1', turns: [1, 2], source: '/home/u/.origin/sessions/s1.json' };
    expect(dedupeSessions([stale, fuller])[0].source).toBe(fuller.source);
  });
});
