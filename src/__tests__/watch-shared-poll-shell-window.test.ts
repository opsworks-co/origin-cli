// The transcript watcher (hookless agents — Cursor on Windows, Gemini,
// Antigravity) bounds a shell-writing turn's window by the NEXT turn's
// baseline. When one poll first sees two turns (turn 0 finished and turn 1
// began between polls), both baselines are one snapshot taken after turn 0's
// writes, so turn 0's window was empty: its shell write was recorded nowhere,
// and its [Origin: Decision] could not ride with the commit a later turn made.
//
// The window is widened to the last snapshot from an earlier poll (or the HEAD
// the shared snapshot was cut on) and only the files turn 0's own commands
// name are kept; a file another turn in that span also names stays unclaimed.

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { reconcileSession, sharedPollWindow } from '../transcript-watch.js';
import { shellCommandNamesFile } from '../shell-write-capture.js';
import type { TranscriptAdapter, ParsedSession } from '../transcript-adapters.js';

const POLL_1 = '2026-10-01T10:00:00.000Z';
const POLL_2 = '2026-10-01T10:05:00.000Z';

describe('sharedPollWindow', () => {
  it('is null on the normal path: each turn\'s baseline came from its own poll', () => {
    const shadows = [
      { promptIndex: 0, baselineSha: 'a', capturedAt: POLL_1 },
      { promptIndex: 1, baselineSha: 'b', capturedAt: POLL_2 },
    ];
    expect(sharedPollWindow(shadows, 0)).toBeNull();
    expect(sharedPollWindow(shadows, 1)).toBeNull(); // the last turn has no successor
  });

  it('first poll saw both turns: no earlier snapshot, the span is both turns', () => {
    const shadows = [
      { promptIndex: 0, baselineSha: 's', capturedAt: POLL_1 },
      { promptIndex: 1, baselineSha: 's2', capturedAt: POLL_1 },
    ];
    expect(sharedPollWindow(shadows, 0)).toEqual({ fromSha: null, spanTurns: [0, 1] });
  });

  it('a later poll saw two new turns: starts at the earlier poll\'s snapshot, whose turn is in the span', () => {
    const shadows = [
      { promptIndex: 0, baselineSha: 'a', capturedAt: POLL_1 },
      { promptIndex: 1, baselineSha: 'b', capturedAt: POLL_2 },
      { promptIndex: 2, baselineSha: 'c', capturedAt: POLL_2 },
      { promptIndex: 3, baselineSha: 'd', capturedAt: POLL_2 },
    ];
    expect(sharedPollWindow(shadows, 1)).toEqual({ fromSha: 'a', spanTurns: [0, 1, 2] });
    expect(sharedPollWindow(shadows, 2)).toEqual({ fromSha: 'a', spanTurns: [0, 1, 2, 3] });
    expect(sharedPollWindow(shadows, 0)).toBeNull();
  });
});

describe('shellCommandNamesFile', () => {
  it('matches whole words, relative or absolute, in the command and in a script it pipes', () => {
    expect(shellCommandNamesFile("cat > retry.ts <<'EOF'\nx\nEOF", 'retry.ts')).toBe(true);
    expect(shellCommandNamesFile('sed -i "s/a/b/" ./src/a.ts', 'src/a.ts')).toBe(true);
    expect(shellCommandNamesFile("python3 - <<'PY'\nopen('src/a.ts','w').write(x)\nPY", 'src/a.ts')).toBe(true);
    expect(shellCommandNamesFile('cp x /repo/src/a.ts', 'src/a.ts', '/repo')).toBe(true);
    expect(shellCommandNamesFile('git checkout -- src', 'src/a.ts', '/repo')).toBe(true);
  });

  it('never matches a substring, another tree, or a whole-tree git command', () => {
    expect(shellCommandNamesFile('cat > old-retry.ts', 'retry.ts')).toBe(false);
    expect(shellCommandNamesFile('cat > retry.tsx', 'retry.ts')).toBe(false);
    expect(shellCommandNamesFile('cp x /other/src/a.ts', 'src/a.ts', '/repo')).toBe(false);
    expect(shellCommandNamesFile('git checkout -- .', 'src/a.ts', '/repo')).toBe(false);
  });
});

describe('transcript watcher: one poll first sees two turns', () => {
  const retry = 'export const retry = (n) => n * 2;\n';

  async function run(opts: { turn1Commands: string[] }) {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-watch-shared-poll-')));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t.co', '-c', 'user.name=T', ...a], { cwd: repo, env, encoding: 'utf-8', windowsHide: true }).trim();
    try {
      git('init', '-q');
      fs.writeFileSync(path.join(repo, 'README.md'), 'uploader\n');
      git('add', '-A');
      git('commit', '-qm', 'init');
      const head = git('rev-parse', 'HEAD');
      // Turn 0 writes retry.ts through the shell; README.md changes too, which
      // no command names (the user's own edit). Then turn 1 starts — and only
      // now does the watcher poll, snapshotting both turns' start at once.
      fs.writeFileSync(path.join(repo, 'retry.ts'), retry);
      fs.appendFileSync(path.join(repo, 'README.md'), 'by hand\n');
      git('add', '-A');
      const snapshot = git('commit-tree', git('write-tree'), '-p', head, '-m', 'origin shadow twatch-cursor-0 x');
      git('reset', '-q', head);

      const transcriptPath = path.join(repo, '.t.jsonl');
      fs.writeFileSync(transcriptPath, '');
      const parsed: ParsedSession = {
        userPrompts: ['add retry', 'now the tests'],
        promptTimestamps: [],
        transcript: '',
        model: 'm', tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 1,
        filePaths: [], filesChanged: [], promptDiffs: [],
        promptsThatWroteViaShell: opts.turn1Commands.length ? [0, 1] : [0],
        promptShellWriteCommands: opts.turn1Commands.length
          ? { 0: [`cat > retry.ts <<'EOF'\n${retry}EOF`], 1: opts.turn1Commands }
          : { 0: [`cat > retry.ts <<'EOF'\n${retry}EOF`] },
      };
      const adapter: TranscriptAdapter = { slug: 'cursor', agentSlugForServer: 'cursor', listActive: () => [], parse: () => parsed };
      const updateSession = vi.fn().mockResolvedValue({});

      await reconcileSession(
        { sessionId: 'sess-shared', transcriptPath, cwd: repo, mtimeMs: Date.now() },
        adapter,
        {
          now: () => Date.now(),
          idleMs: 60 * 60_000,
          machineId: 'm',
          stateDir: path.join(repo, '.state'),
          api: { startSession: vi.fn(), updateSession },
          resolveRepo: () => ({ repoPath: repo, workRoot: repo }),
          createShadow: () => null,
          getHead: () => head,
          captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
          captureGit: () => ({ headBefore: head, headAfter: head, commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0 }),
          writeMemory: vi.fn(),
          loadState: () => ({
            agentSlug: 'cursor', sessionId: 'sess-shared', originSessionId: 'o1',
            repoPath: repo, workRoot: repo, promptCount: 2,
            createdAt: POLL_1, status: 'RUNNING' as const, lastTranscriptMtime: 0,
            headShaAtStart: head, sessionCommitShas: [],
            // Both baselines from ONE poll — the same snapshot, the same stamp.
            promptShadows: [
              { promptIndex: 0, baselineSha: snapshot, capturedAt: POLL_1 },
              { promptIndex: 1, baselineSha: snapshot, capturedAt: POLL_1 },
            ],
          }),
          saveState: vi.fn(),
        } as any,
      );

      const sent = (idx: number): Array<{ file: string; newContent?: string }> => {
        const rows = updateSession.mock.calls
          .flatMap((c) => c.flatMap((a: any) => (a && Array.isArray(a.promptChanges) ? a.promptChanges : [])))
          .filter((p: any) => p.promptIndex === idx && typeof p.editsJson === 'string');
        const last = rows.at(-1);
        return last ? JSON.parse(last.editsJson).edits || [] : [];
      };
      return { turn0: sent(0), turn1: sent(1) };
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  it('records turn 0\'s shell write on turn 0, and nothing its commands do not name', async () => {
    const { turn0 } = await run({ turn1Commands: [] });
    expect(turn0.map((e) => e.file)).toEqual(['retry.ts']);
    expect(turn0[0].newContent).toBe(retry);
  });

  it('leaves a file both turns\' commands name unclaimed rather than guess', async () => {
    const { turn0, turn1 } = await run({ turn1Commands: ['sed -i "s/2/3/" retry.ts'] });
    expect(turn0.map((e) => e.file)).not.toContain('retry.ts');
    expect(turn1.map((e) => e.file)).not.toContain('retry.ts');
  });
});
