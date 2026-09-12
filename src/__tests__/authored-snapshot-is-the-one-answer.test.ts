// Every producer of a session's authorship derives from the authored snapshot.
//
// Source guard, deliberately. The defect this closes was not a wrong function
// but a SIXTH producer with its own arithmetic: the turn row, the session
// accumulator, post-commit's snapshot, Stop's snapshot, session-end's range
// capture and the transcript watcher's each answered "what did this session
// author" separately, and a merge got three different answers (51995e1c).
// A behavioural test proves one of them; this proves none of them has been
// re-wired to its own copy. Same shape as post-commit-durable-gitcapture.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hooksSourceFiles } from './helpers/hooks-source.js';

const files = hooksSourceFiles();
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const watcher = fs.readFileSync(path.join(src, 'transcript-watch.ts'), 'utf-8');

describe('the authored snapshot is the one answer', () => {
  it('post-commit rebinds the commit to its authored contribution before anything reads it', () => {
    const pc = files['hooks/post-commit.ts'];
    expect(pc).toContain('const authored = commitAuthoredDelta(hookCwd, commitSha, firstParent)');
    expect(pc).toContain('const { diff, filesChanged } = authored;');
    // The rebind precedes the line count, the ingest payload and the loop
    // that sets the session totals.
    const at = pc.indexOf('const { diff, filesChanged } = authored;');
    expect(pc.indexOf('const ingestCommit = {')).toBeGreaterThan(at);
    expect(pc.indexOf('applyAuthoredTotals(s, snap)')).toBeGreaterThan(at);
  });

  it('post-commit counts a merge by its authored contribution, never numstat', () => {
    const pc = files['hooks/post-commit.ts'];
    expect(pc).toContain('if (authored.isMerge)');
    expect(pc).toContain('linesAdded = authored.linesAdded');
    // numstat is the non-merge branch only — a merge's diff-tree is empty
    // or first-parent, both the wrong answer (51995e1c +326 of another PR).
    const merge = pc.indexOf('if (authored.isMerge)');
    const numstat = pc.indexOf('commitLineCounts(hookCwd, commitSha)');
    expect(merge).toBeGreaterThan(-1);
    expect(numstat).toBeGreaterThan(merge);
  });

  it('post-commit SETS the session totals from the snapshot rather than adding each commit', () => {
    const pc = files['hooks/post-commit.ts'];
    const loop = pc.slice(pc.indexOf('for (const s of activeSessions) {'), pc.indexOf('if (changed) {'));
    expect(loop).toContain('sessionAuthoredSnapshot(hookCwd, s)');
    expect(loop).toContain('applyAuthoredTotals(s, snap)');
    // The per-commit add survives only as the no-owned-commits fallback.
    expect(loop).toContain("snap.source !== 'none'");
  });

  it('Stop sends the authored snapshot for EVERY agent, not only the hookless ones', () => {
    const stop = files['hooks/stop.ts'];
    expect(stop).toContain('sessionAuthoredSnapshot(state.repoPath, state, { uncommittedDiff: filteredUncommitted })');
    expect(stop).not.toContain('codexLikeAgents');
    // And it is a snapshot: the server replaces, it does not merge onto a
    // weaker producer's range.
    const block = stop.slice(stop.indexOf('sessionAuthoredSnapshot(state.repoPath, state'), stop.indexOf("'session-level gitCapture snapshot built'"));
    expect(block).toContain('snapshot: true');
  });

  it('session-end stores the authored snapshot, not the session-start..HEAD range', () => {
    const end = files['hooks/session-end.ts'];
    expect(end).toContain('sessionAuthoredSnapshot(state.repoPath, state, { uncommittedDiff: gitCapture.uncommittedDiff');
    expect(end).toContain('endIsAuthoredSnapshot ? { snapshot: true }');
  });

  it('the transcript watcher renders owned commits by their authored contribution', () => {
    expect(watcher).toContain('authoredCommits: (workRoot: string, shas: string[]) => renderAuthoredCommits(workRoot, shas)');
    expect(watcher).toContain('deps.authoredCommits(repo.workRoot, sessionCommitShas)');
    expect(watcher).toContain('gitCapture.snapshot = true');
  });

  it('the per-commit answer is merge-aware in one place, with no hook-side imports', () => {
    const hb = fs.readFileSync(path.join(src, 'history-backfill.ts'), 'utf-8');
    expect(hb).toContain('export function commitAuthoredDelta(');
    expect(hb).toContain('const merge = mergeOwnDiff(cwd, sha);');
    expect(hb).not.toMatch(/from '\.\/commands\//);
  });
});
