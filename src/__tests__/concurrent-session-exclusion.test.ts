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
