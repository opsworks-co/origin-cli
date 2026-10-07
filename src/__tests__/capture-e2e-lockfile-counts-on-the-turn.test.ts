// END-TO-END: a turn that bumps a version counts its lock file, so the turn's
// row and its commit agree to the line.
//
// Session d97d7b2c turn 6 read +434/-56 beside its own commit's +436/-58: the
// version-bump script rewrote package-lock.json's two version lines, the
// commit carried them, and capture left lock files out of turn diffs as
// generated bookkeeping. The session page then had to explain the gap.
//
// Built binary, real hook sequence, fake API (stop-next-prompt-harness).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { commitFiles, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const manifest = (v: string) => `{\n  "name": "app",\n  "version": "${v}"\n}\n`;
const lock = (v: string) => `{\n  "name": "app",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "app",\n      "version": "${v}"\n    }\n  }\n}\n`;

describe.skipIf(!haveDist)('lock files count on the turn, through the built binary', () => {
  it('a turn that fixes code and bumps the version: its row equals its commit, lock file included', async () => {
    const h = await createHarness('e2e-lockfile-0001', 'e2e-lockfile-srv-1');
    try {
      commitFiles(h, { 'src/app.ts': numbered('app', 3), 'package.json': manifest('1.0.0'), 'package-lock.json': lock('1.0.0') }, 'base');

      await h.startSession('fix the app and bump the version');
      await h.agentWrites('tu-1', 'src/app.ts', numbered('app', 3) + 'app_fix = 1\n');
      await sleep(300);
      // The bump runs as a script, the way version-bump.cjs does.
      await h.agentRuns('tu-2', 'node scripts/version-bump.cjs', () => {
        fs.writeFileSync(path.join(h.repo, 'package.json'), manifest('1.0.1'));
        fs.writeFileSync(path.join(h.repo, 'package-lock.json'), lock('1.0.1'));
      });
      await sleep(300);
      let postCommit: Promise<{ code: number | null; stderr: string }> | null = null;
      // Named paths: Origin's own CLAUDE.md sits untracked in the tree.
      await h.agentRuns('tu-3', 'git add src package.json package-lock.json && git commit -m "fix: app"', () => {
        h.git(['add', 'src', 'package.json', 'package-lock.json']);
        h.git(['commit', '-q', '--no-verify', '-m', 'fix: app']);
        postCommit = h.gitHook('git-post-commit');
      });
      const pc = await postCommit!;
      expect(pc.code, pc.stderr).toBe(0);
      h.reply('Fixed and bumped.');
      await h.stop();

      const numstat = h.git(['show', '--numstat', '--format=', 'HEAD']).split('\n').filter(Boolean)
        .map((l) => l.split('\t'));
      const commitFilesList = numstat.map((p) => p[2]).sort();
      const commitTotals = numstat.reduce((t, p) => [t[0] + Number(p[0]), t[1] + Number(p[1])], [0, 0]);
      expect(commitFilesList).toEqual(['package-lock.json', 'package.json', 'src/app.ts']);

      const row = h.rows().filter((r: any) => r.promptIndex === 0).at(-1);
      expect(row, 'turn 0 was never sent').toBeTruthy();
      expect([...row.filesChanged].sort(), 'the turn\'s files are its commit\'s').toEqual(commitFilesList);
      expect([row.linesAdded, row.linesRemoved], 'the turn\'s lines are its commit\'s').toEqual(commitTotals);
      expect(String(row.diff || ''), 'the lock file\'s lines are in the turn\'s diff').toContain('package-lock.json');
    } finally {
      await h.close();
    }
  }, T);
});
