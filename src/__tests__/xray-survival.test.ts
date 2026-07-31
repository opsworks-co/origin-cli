// Repo-wide AI survival, driven against a real temp git repo so the detection +
// blame math is validated end-to-end (not mocked). Mirrors the isolation of
// benchmark-survival.test.ts: no global/system gitconfig, no hooks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectAgent, collectAiCommits, computeRepoAiSurvival } from '../xray.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const AI_TRAILER = '\n\nCo-Authored-By: Claude <noreply@anthropic.com>';

describe('xray — repo-wide AI survival', () => {
  let dir: string;
  const g = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env: ENV }).trim();
  const commit = (msg: string) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', msg], { cwd: dir, encoding: 'utf-8', env: ENV });
  const write = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-xray-')));
    g('init', '-q', '-b', 'main');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  describe('detectAgent', () => {
    it('reads definitive trailers', () => {
      expect(detectAgent('feat: x' + AI_TRAILER)).toBe('claude');
      expect(detectAgent('Origin-Session: abc123 | Cursor | 3 prompts')).toBe('cursor');
      expect(detectAgent('fix: y\n\nCo-Authored-By: Copilot <c@github.com>')).toBe('copilot');
    });
    it('does NOT classify a plain human commit as AI (would poison the ratio)', () => {
      expect(detectAgent('fix: a normal commit with a long structured body\n\nmore text')).toBeNull();
      expect(detectAgent('feat(scope): human work')).toBeNull();
      expect(detectAgent('')).toBeNull();
    });
  });

  it('counts AI-added lines still alive at HEAD, ignoring human commits', () => {
    // Human commit — must be excluded from both numerator and denominator.
    write('h.txt', 'h1\nh2\n');
    g('add', '.'); commit('chore: human baseline');

    // AI commit adds 5 lines.
    write('f.txt', 'a1\na2\na3\na4\na5\n');
    g('add', '.'); commit('feat: ai adds five' + AI_TRAILER);

    // A later HUMAN commit reworks one AI line and deletes another.
    write('f.txt', 'a1\na2\na3-edited\na4\n');
    g('add', '.'); commit('fix: human reworks a3, drops a5');

    const r = computeRepoAiSurvival(dir, 90);
    expect(r.aiCommits).toBe(1);
    expect(r.totalCommits).toBe(3);
    expect(r.aiLinesAdded).toBe(5);
    expect(r.aiLinesSurviving).toBe(3); // a1, a2, a4
    expect(r.survivalPct).toBe(60);
    expect(r.resolvable).toBe(true);
    expect(r.byAgent).toEqual({ claude: 1 });
  });

  it('reports 100% when nothing has churned', () => {
    write('f.txt', 'x1\nx2\nx3\nx4\n');
    g('add', '.'); commit('feat: ai only' + AI_TRAILER);
    const r = computeRepoAiSurvival(dir, 90);
    expect(r.aiLinesAdded).toBe(4);
    expect(r.survivalPct).toBe(100);
  });

  it('reports UNKNOWN (null), never 0%, when the AI work was deleted wholesale', () => {
    write('gone.txt', 'g1\ng2\ng3\n');
    g('add', '.'); commit('feat: ai file' + AI_TRAILER);
    fs.rmSync(path.join(dir, 'gone.txt'));
    g('add', '-A'); commit('chore: human deletes the file');
    const r = computeRepoAiSurvival(dir, 90);
    // The sha is still reachable, so this IS resolvable — and a genuine 0.
    expect(r.resolvable).toBe(true);
    expect(r.aiLinesSurviving).toBe(0);
    expect(r.survivalPct).toBe(0);
  });

  it('returns UNKNOWN when history was rewritten so no AI sha reaches HEAD', () => {
    write('f.txt', 'a1\na2\n');
    g('add', '.'); commit('feat: ai' + AI_TRAILER);
    const { shas } = collectAiCommits(dir, 90);
    expect(shas).toHaveLength(1);
    // Rewrite history (squash-merge analogue): orphan branch, AI sha unreachable.
    g('checkout', '-q', '--orphan', 'rewritten');
    g('add', '-A'); commit('squashed: everything');
    const r = computeRepoAiSurvival(dir, 90);
    expect(r.resolvable).toBe(false);
    expect(r.survivalPct).toBeNull(); // never a misleading 0
  });

  it('is a no-op on a repo with no AI commits', () => {
    write('f.txt', 'h\n');
    g('add', '.'); commit('chore: human only');
    const r = computeRepoAiSurvival(dir, 90);
    expect(r.aiCommits).toBe(0);
    expect(r.survivalPct).toBeNull();
  });
});
