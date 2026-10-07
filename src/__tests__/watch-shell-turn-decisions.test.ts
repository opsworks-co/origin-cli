// The transcript watcher (hookless agents — Cursor on Windows) records a
// commit's decisions from the turns whose work is in it. The hook paths add
// each turn's captured diff to what its edit tools wrote (withTurnDiffs); the
// watcher did not. So a turn that wrote only through the shell, whose work a
// later "commit it" turn committed, showed no written lines, could not show its
// work landed, and its [Origin: Decision] was left off the commit's record.

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>();
  return { ...actual, loadConfig: () => ({ memoryUpdate: 'both' }) };
});

import { promptTimesFor, reconcileSession, turnDiffsFromEdits } from '../transcript-watch.js';
import { commitTurnDecisions, withTurnDiffs } from '../committed-markers.js';
import { splitMarkersByTurn, significantLine } from '../origin-markers.js';
import type { TranscriptAdapter, ParsedSession } from '../transcript-adapters.js';

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-01T10:20:00.000Z';
const COMMITTED = '2026-10-01T10:20:30Z';
const DECISION = 'Retry with exponential backoff capped at 30s — the API rate-limits bursts';

const retry = [
  'export async function withRetry(fn, attempts = 5) {',
  '  for (let attempt = 0; attempt < attempts; attempt++) {',
  '    try { return await fn(); } catch (err) { lastError = err; }',
  '    await sleepFor(Math.min(30_000, 2 ** attempt * 250));',
  '  }',
  '  throw lastError;',
  '}',
].join('\n') + '\n';

// Claude Code JSONL shape (it has times). Turn 0 writes retry.ts with a
// heredoc — a Bash call, which the transcript does not read as written lines.
const rec = (o: unknown) => JSON.stringify(o);
const transcript = [
  rec({ type: 'user', timestamp: T0, message: { role: 'user', content: 'add retry with backoff to the uploader' } }),
  rec({ type: 'assistant', timestamp: '2026-10-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `cat > retry.ts <<'EOF'\n${retry}EOF` } }] } }),
  rec({ type: 'assistant', timestamp: '2026-10-01T10:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n[Origin: Decision] ${DECISION}` }] } }),
  rec({ type: 'user', timestamp: T1, message: { role: 'user', content: 'looks good, commit it' } }),
  rec({ type: 'assistant', timestamp: '2026-10-01T10:20:20Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'git add -A && git commit -m "add retry"' } }] } }),
].join('\n');

describe('turnDiffsFromEdits', () => {
  it('feeds a shell-written turn\'s captured edits to withTurnDiffs, so its decision rides along', () => {
    const turns = splitMarkersByTurn(transcript);
    const added = new Set(retry.split('\n').map(significantLine).filter(Boolean));
    // Without the captured diff the turn shows no work and is left out.
    expect(commitTurnDecisions(turns, COMMITTED, { added })).toEqual([]);

    const edits = new Map([[0, JSON.stringify({ edits: [{ file: 'retry.ts', op: 'create', oldContent: '', newContent: retry, source: 'shell_window' }], commits: [] })]]);
    const state = turnDiffsFromEdits(edits, promptTimesFor(turns, [], 2));
    expect(commitTurnDecisions(withTurnDiffs(turns, state), COMMITTED, { added })).toEqual([DECISION]);
  });

  it('counts only the lines an edit added, and files nothing for a turn with no time', () => {
    const edits = new Map([
      [0, JSON.stringify({ edits: [{ file: 'a.ts', op: 'edit', oldContent: 'kept line one\n', newContent: 'kept line one\nadded line two\n', source: 'tool_call' }] })],
      [1, 'not json'],
    ]);
    const state = turnDiffsFromEdits(edits, [null]);
    expect(state.completedPromptMappings).toEqual([{ promptIndex: 0, diff: '+added line two' }]);
    expect(state.promptSubmittedAt).toEqual(['']);
  });

  it('takes prompt times from the adapter when it has them, else from the marker turns only when the counts agree', () => {
    const turns = splitMarkersByTurn(transcript);
    // Antigravity's adapter fills promptTimestamps — they win.
    expect(promptTimesFor(turns, [111, 222], 2)).toEqual([111, 222]);
    // The transcript.ts adapters leave them empty: the marker turns' times, by position.
    expect(promptTimesFor(turns, [], 2)).toEqual([Date.parse(T0), Date.parse(T1)]);
    // The two readers disagree on how many prompts there are: positions may
    // not line up, so no times — no diff gets filed under the wrong turn.
    expect(promptTimesFor(turns, [], 3)).toEqual([]);
  });
});

describe('transcript watcher: a shell-only turn committed by a later turn', () => {
  it('keeps the earlier turn\'s decision on the commit record', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-watch-shell-dec-')));
    try {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_DATE: COMMITTED, GIT_COMMITTER_DATE: COMMITTED };
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t.co', '-c', 'user.name=T', ...a], { cwd: repo, env, encoding: 'utf-8', windowsHide: true }).trim();
      git('init', '-q');
      fs.writeFileSync(path.join(repo, 'README.md'), 'uploader\n');
      git('add', '-A');
      git('commit', '-qm', 'init', '--date', '2026-10-01T09:00:00Z');
      const base = git('rev-parse', 'HEAD');
      // Turn 0's shell write, then the snapshot the watcher took when turn 1
      // started (a shadow commit off to the side, HEAD unmoved).
      fs.writeFileSync(path.join(repo, 'retry.ts'), retry);
      git('add', '-A');
      const turn1Start = git('commit-tree', git('write-tree'), '-p', base, '-m', 'shadow');
      // Turn 1 commits it.
      git('commit', '-qm', 'add retry');
      const sha = git('rev-parse', 'HEAD');

      const transcriptPath = path.join(repo, '.t.jsonl');
      fs.writeFileSync(transcriptPath, transcript);

      const parsed: ParsedSession = {
        userPrompts: ['add retry with backoff to the uploader', 'looks good, commit it'],
        promptTimestamps: [], // the transcript.ts adapters send none
        transcript,
        model: 'm', tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 2,
        filePaths: [], filesChanged: [], promptDiffs: [],
        promptsThatWroteViaShell: [0],
        promptsThatCommitted: [1],
        promptCommitShas: { 1: [sha.slice(0, 7)] },
      };
      const adapter: TranscriptAdapter = { slug: 'cursor', agentSlugForServer: 'cursor', listActive: () => [], parse: () => parsed };
      const writeCommitMemoryEntry = vi.fn();

      await reconcileSession(
        { sessionId: 'sess-shell', transcriptPath, cwd: repo, mtimeMs: Date.now() },
        adapter,
        {
          now: () => Date.now(),
          idleMs: 60 * 60_000,
          machineId: 'm',
          stateDir: path.join(repo, '.state'),
          api: { startSession: vi.fn(), updateSession: vi.fn().mockResolvedValue({}) },
          resolveRepo: () => ({ repoPath: repo, workRoot: repo }),
          createShadow: () => null,
          getHead: () => sha,
          captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
          captureGit: () => ({ headBefore: base, headAfter: sha, commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0 }),
          writeMemory: vi.fn(),
          writeCommitMemoryEntry,
          loadState: () => ({
            agentSlug: 'cursor', sessionId: 'sess-shell', originSessionId: 'o1',
            repoPath: repo, workRoot: repo, promptCount: 2,
            createdAt: '2026-10-01T09:59:00.000Z', status: 'RUNNING' as const, lastTranscriptMtime: 0,
            headShaAtStart: base, sessionCommitShas: [sha],
            promptShadows: [
              { promptIndex: 0, baselineSha: base, capturedAt: T0, promptStartedAt: Date.parse(T0) },
              { promptIndex: 1, baselineSha: turn1Start, capturedAt: T1, promptStartedAt: Date.parse(T1) },
            ],
          }),
          saveState: vi.fn(),
        } as any,
      );

      const entry = writeCommitMemoryEntry.mock.calls.find((c) => c[1].commitSha === sha)?.[1];
      expect(entry).toBeDefined();
      expect(entry.decisions).toEqual([DECISION]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
