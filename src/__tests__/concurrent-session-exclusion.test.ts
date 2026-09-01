/**
 * Two agents in ONE working tree must not be credited with each other's files.
 *
 * Prod session 0a8e2164 shared the `origin` checkout with a second Claude
 * session. Its turns were credited with `PublicLayout.tsx` and `Landing.tsx`
 * — entirely the other session's work — and its state file even recorded the
 * other session's branch.
 *
 * The exclusion for this already existed: uncommittedExcludeUnion gathers
 * files claimed by OTHER active sessions on the repo and hands them to
 * filterUncommittedDiff. It just never matched anything. Mappings hold a MIX
 * of path shapes — a tool call records the absolute path it was handed, a git
 * capture records the repo-relative one — while filterUncommittedDiff keys on
 * `diff --git a/<repo-relative>`. Measured across the live state files in the
 * origin repo at the time: 15 absolute vs 12 relative. So the exclusion
 * covered git-derived names only, and silently missed the tool-derived ones
 * that make up most agent edits.
 *
 * Normalizing to repo-relative makes it match. The recency window is the
 * safety rail that has to come with it: listActiveSessions returns every
 * session not explicitly ENDED, and letting a long-dead one subtract files
 * would blank shell-edit turns, which have no tool mapping to protect them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uncommittedExcludeUnion, filterUncommittedDiff } from '../commands/hooks.js';

const FILE_A = 'apps/web/src/components/PublicLayout.tsx';   // the other session's
const FILE_B = 'apps/api/src/routes/sessions.ts';            // ours

const diffFor = (files: string[]) =>
  files
    .map((f) => [
      `diff --git a/${f} b/${f}`,
      'index 1111111..2222222 100644',
      `--- a/${f}`,
      `+++ b/${f}`,
      '@@ -1,1 +1,2 @@',
      ' context',
      '+added line',
    ].join('\n'))
    .join('\n');

describe('uncommittedExcludeUnion — concurrent sessions in one checkout', () => {
  let repo: string;
  let gitDir: string;

  const writeState = (tag: string, state: Record<string, unknown>, ageMs = 0) => {
    const p = path.join(gitDir, `origin-session-${tag}.json`);
    fs.writeFileSync(p, JSON.stringify(state));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(p, when, when);
    }
    return p;
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-cc-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    gitDir = path.join(repo, '.git');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const ourState = () => ({
    sessionId: 'ours',
    sessionTag: 'ours',
    repoPath: repo,
    prePromptDirtyFiles: [],
    sessionStartDirtyFiles: [],
    // Recorded from a tool call, so ABSOLUTE — the shape that used to slip past.
    completedPromptMappings: [{ promptIndex: 0, filesChanged: [path.join(repo, FILE_B)] }],
  });

  it('excludes another live session\'s file recorded as an absolute path', () => {
    writeState('ours', ourState());
    writeState('theirs', {
      sessionId: 'theirs',
      sessionTag: 'theirs',
      repoPath: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [path.join(repo, FILE_A)] }],
    });

    const exclude = uncommittedExcludeUnion(ourState() as any);
    expect(exclude).toContain(FILE_A);

    // And it actually bites on a real diff, which is the whole point.
    const filtered = filterUncommittedDiff(diffFor([FILE_A, FILE_B]), exclude);
    expect(filtered).not.toContain(FILE_A);
    expect(filtered).toContain(FILE_B);
  });

  it('never excludes a file we ourselves touched', () => {
    writeState('ours', ourState());
    // Both sessions edited the same file; ours must survive.
    writeState('theirs', {
      sessionId: 'theirs',
      sessionTag: 'theirs',
      repoPath: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [FILE_B] }],
    });

    expect(uncommittedExcludeUnion(ourState() as any)).not.toContain(FILE_B);
  });

  it('ignores a session that has not been seen for half an hour', () => {
    writeState('ours', ourState());
    // Not ENDED, so listActiveSessions still returns it — but its agent is
    // long gone, and a shell-edit turn of ours has no mapping to defend
    // itself with.
    writeState('stale', {
      sessionId: 'stale',
      sessionTag: 'stale',
      repoPath: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [path.join(repo, FILE_A)] }],
    }, 45 * 60 * 1000);

    expect(uncommittedExcludeUnion(ourState() as any)).not.toContain(FILE_A);
  });

  it('still excludes a repo-relative claim (the half that always worked)', () => {
    writeState('ours', ourState());
    writeState('theirs', {
      sessionId: 'theirs',
      sessionTag: 'theirs',
      repoPath: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [FILE_A] }],
    });

    expect(uncommittedExcludeUnion(ourState() as any)).toContain(FILE_A);
  });

  it('keeps pre-existing dirt in the union', () => {
    const state = { ...ourState(), sessionStartDirtyFiles: ['stray.txt'] };
    writeState('ours', state);
    expect(uncommittedExcludeUnion(state as any)).toContain('stray.txt');
  });
});

// Two ways a concurrent session's file still reached our diff after the
// exclusion above was in place. Both measured on a real four-session checkout
// (b629d2cb / 97ad4482 / ff3ac057 / 3bfa24e6) while #1114 was landing.
describe('uncommittedExcludeUnion — leaks the mapping-based owner check missed', () => {
  let repo: string;
  let gitDir: string;

  const writeState = (tag: string, state: Record<string, unknown>) => {
    fs.writeFileSync(path.join(gitDir, `origin-session-${tag}.json`), JSON.stringify(state));
  };
  const ledger = (files: string[]) => [
    { promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(),
      edits: files.map((f) => ({ file: f, op: 'edit', oldContent: 'a', newContent: 'b' })) },
  ];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-cc2-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    gitDir = path.join(repo, '.git');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('breaks the feedback loop: a file that ALREADY leaked into our rows is still theirs', () => {
    // The loop: a foreign file lands in one of our mappings, which made the
    // owner check read it as ours, which switched this exclusion off for it,
    // which let it land again — permanently. Measured on hooks.ts, still being
    // re-attributed to us hours after it leaked.
    const FOREIGN = 'packages/cli/src/commands/hooks.ts';
    const OURS = 'packages/cli/src/transcript.ts';
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      // Our ledger proves we edited OURS — and says nothing about FOREIGN.
      liveEdits: ledger([path.join(repo, OURS)]),
      // …but FOREIGN is sitting in our mappings from an earlier bad attribution.
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [OURS, FOREIGN] }],
    };
    writeState('ours', ours);
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [FOREIGN] }],
    });

    const exclude = uncommittedExcludeUnion(ours as any);
    expect(exclude).toContain(FOREIGN);      // was NOT excluded before
    expect(exclude).not.toContain(OURS);     // our own work still survives

    const filtered = filterUncommittedDiff(diffFor([FOREIGN, OURS]), exclude);
    expect(filtered).not.toContain(`a/${FOREIGN}`);
    expect(filtered).toContain(`a/${OURS}`);
  });

  it('sees a sibling turn that is still IN FLIGHT, before its mappings exist', () => {
    // A sibling writes completedPromptMappings only at ITS Stop, so mid-turn
    // it claims nothing — and mid-turn is exactly when our diff runs over the
    // tree it is writing to. This is how commit-attribution.test.ts reached us.
    const THEIRS_INFLIGHT = 'apps/api/src/__tests__/utils/commit-attribution.test.ts';
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: ledger([path.join(repo, 'packages/cli/src/transcript.ts')]),
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      completedPromptMappings: [],                 // nothing finished yet
      liveEdits: ledger([path.join(repo, THEIRS_INFLIGHT)]),
    });

    expect(uncommittedExcludeUnion(ours as any)).toContain(THEIRS_INFLIGHT);
  });

  it('leaves a genuinely contested file alone — file-level cannot split it', () => {
    // Both ledgers claim it, because both agents really did edit it. Dropping
    // it would delete our own work; keeping it means their lines ride along.
    // Splitting that is line-level scoping's job, not this function's.
    const SHARED = 'packages/cli/src/commands/hooks.ts';
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: ledger([path.join(repo, SHARED)]),
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      liveEdits: ledger([path.join(repo, SHARED)]),
      completedPromptMappings: [],
    });

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(SHARED);
  });

  it('falls back to mappings when the ledger is off, so shell-only work survives', () => {
    // ORIGIN_LIVE_CAPTURE=0 / older state file: no ledger. Ownership has to
    // come from mappings or every contested file vanishes from our diff.
    const OURS = 'apps/api/src/routes/sessions.ts';
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [OURS] }],
    };
    writeState('ours', ours);
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [OURS] }],
    });

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(OURS);
  });
});

// The residual race after the ledger fix: liveEdits is written at POST-tool-use,
// so between a sibling's bytes hitting the shared tree and its ledger entry
// landing, nothing says the file is theirs. Measured on b629d2cb's row for
// "take it yourself", which took 97ad4482's routes/sessions.ts in that window.
describe('uncommittedExcludeUnion — pending writes claimed before the bytes land', () => {
  let repo: string;
  let gitDir: string;
  const writeState = (tag: string, state: Record<string, unknown>) =>
    fs.writeFileSync(path.join(gitDir, `origin-session-${tag}.json`), JSON.stringify(state));
  const ledger = (files: string[]) => [
    { promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(),
      edits: files.map((f) => ({ file: f, op: 'edit', oldContent: 'a', newContent: 'b' })) },
  ];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-cc3-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    gitDir = path.join(repo, '.git');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const ours = (extra: Record<string, unknown> = {}) => ({
    sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
    prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
    liveEdits: ledger([path.join(repo, 'packages/cli/src/transcript.ts')]),
    completedPromptMappings: [],
    ...extra,
  });

  it('excludes a sibling write that is announced but not yet in its ledger', () => {
    const THEIRS = 'apps/api/src/routes/sessions.ts';
    writeState('ours', ours());
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      liveEdits: [], completedPromptMappings: [],       // nothing recorded yet
      pendingWrites: [{ file: path.join(repo, THEIRS), at: new Date().toISOString() }],
    });

    const exclude = uncommittedExcludeUnion(ours() as any);
    expect(exclude).toContain(THEIRS);
    expect(filterUncommittedDiff(diffFor([THEIRS]), exclude)).not.toContain(`a/${THEIRS}`);
  });

  it('ignores a stale claim, so a crashed tool call cannot hold a file hostage', () => {
    const FILE = 'apps/api/src/routes/sessions.ts';
    writeState('ours', ours());
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      liveEdits: [], completedPromptMappings: [],
      pendingWrites: [{ file: path.join(repo, FILE), at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
    });

    expect(uncommittedExcludeUnion(ours() as any)).not.toContain(FILE);
  });

  it('our own claim outranks a sibling that already touched the file', () => {
    // We are mid-write; the sibling merely edited it earlier. Ours must survive.
    const CONTESTED = 'packages/cli/src/commands/hooks.ts';
    const us = ours({ pendingWrites: [{ file: path.join(repo, CONTESTED), at: new Date().toISOString() }] });
    writeState('ours', us);
    writeState('theirs', {
      sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
      liveEdits: ledger([path.join(repo, CONTESTED)]), completedPromptMappings: [],
    });

    expect(uncommittedExcludeUnion(us as any)).not.toContain(CONTESTED);
  });
});
