// The transcript watcher backfills a whole-file write from the tree a pull LEFT.
//
// Follow-up to the legacy Stop fix for TODO 0f2038ef. Agents that fire no hooks
// (every GUI agent on Windows) are captured by the poll-based watcher, which
// records a write as the file's ENTIRE new content and recovers the "before"
// with backfillWriteBaselines(<prompt shadow>). A turn that fast-forwarded
// someone else's commit and then rewrote a file that commit touched got the
// PRE-pull shadow as its before-state, so every pulled line in that file read
// as the turn's own.
//
// Drives the REAL reconcile loop against a REAL git repo, the same way
// watcher-ledger-existing-file-baseline.test.ts does.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  __resetStartSessionBackoff,
  __stopAllJournalWatchers,
  reconcileSession,
  loadSessionState,
  saveSessionState,
  type WatchDeps,
  type SessionWatchState,
} from '../transcript-watch.js';
import type { TranscriptAdapter, ScannedTranscript, ParsedSession } from '../transcript-adapters.js';
// Injected into the watcher's deps exactly as the daemon does (see
// WatchDeps.inheritedBaseline): transcript-watch must not import commands/hooks.
import { inheritedBaselineForTurn } from '../commands/hooks.js';

let tmp = '';
let stateDir = '';
let repo = '';

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

const BASE = Array.from({ length: 10 }, (_, i) => `base_${i} = ${i}`).join('\n') + '\n';
const UPSTREAM = Array.from({ length: 20 }, (_, i) => `upstream_${i} = ${i}`).join('\n') + '\n';
const OWN = 'mine = "the turn wrote this"\n';

let upstreamSha = '';

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'twatch-inherited-')));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@example.com']);
  fs.writeFileSync(path.join(repo, 'shared.py'), BASE);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);

  // Someone else's PR, committed by GitHub an hour ago, appending to shared.py.
  const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
  git(['checkout', '-q', '-b', 'upstream']);
  fs.writeFileSync(path.join(repo, 'shared.py'), BASE + UPSTREAM);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'feat: another PR (#9999)'], {
    GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_AUTHOR_DATE: earlier,
    GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_DATE: earlier,
  });
  upstreamSha = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'main']);
  __resetStartSessionBackoff();
});

afterEach(() => {
  __stopAllJournalWatchers();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** One prompt; after the pull its structured edit is a whole-file write of shared.py. */
function adapter(state: { wrote: boolean }): TranscriptAdapter {
  return {
    slug: 'hooklessagent',
    agentSlugForServer: 'hookless-agent',
    listActive: () => [],
    parse: (): ParsedSession => ({
      userPrompts: ['pull main, then add my line to shared.py'],
      promptTimestamps: [1_000],
      transcript: 'the transcript',
      model: 'some-model',
      tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 1,
      promptEdits: state.wrote
        ? [{ promptIndex: 0, edits: [{ file: path.join(repo, 'shared.py'), op: 'write', newContent: BASE + UPSTREAM + OWN }] }]
        : [{ promptIndex: 0, edits: [] }],
    }) as ParsedSession,
  };
}

function scanned(): ScannedTranscript {
  const file = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(file, '{"role":"user","content":"pull main, then add my line to shared.py"}\n');
  return { sessionId: 'conv-inherited-1', transcriptPath: file, cwd: repo, mtimeMs: Date.now() };
}

function deps(updates: any[]): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'machine-1',
    stateDir,
    api: {
      startSession: async () => ({ sessionId: 'sess-inherited' }),
      updateSession: async (_id: string, data: any) => { updates.push(data); return {}; },
    },
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, branch: 'main' }),
    // Clean tree at the prompt: no shadow, HEAD (pre-pull) is the prompt's baseline.
    createShadow: () => null,
    getHead: (workRoot: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workRoot, encoding: 'utf-8' }).trim(),
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: () => ({
      headBefore: '', headAfter: '', commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (a: string, s: string) => loadSessionState(a, s, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
    inheritedBaseline: inheritedBaselineForTurn as NonNullable<WatchDeps['inheritedBaseline']>,
  };
}

/** The whole-file write for shared.py in the newest row for prompt 0 that carries editsJson. */
function sharedEdit(updates: any[]): { oldContent?: string; newContent?: string } | undefined {
  for (let u = updates.length - 1; u >= 0; u--) {
    const row = (updates[u]?.promptChanges || []).find((r: any) => r.promptIndex === 0 && r.editsJson);
    if (!row) continue;
    const edits = (JSON.parse(row.editsJson).edits || []) as any[];
    const e = edits.find((x) => String(x.file).endsWith('shared.py'));
    if (e) return e;
  }
  return undefined;
}

describe('transcript watcher backfill after a mid-turn pull', () => {
  it('measures a whole-file write from the tree the pull left, not the pre-pull baseline', async () => {
    const updates: any[] = [];
    const d = deps(updates);
    const turn = { wrote: false };

    // Poll 1: registers the session and records prompt 0's baseline (pre-pull HEAD).
    const first = await reconcileSession(scanned(), adapter(turn), d);
    expect(first?.originSessionId).toBe('sess-inherited');
    expect((first?.promptShadows || []).find((s) => s.promptIndex === 0)?.baselineSha, 'no baseline for prompt 0').toBeTruthy();

    // The turn pulls someone else's commit, then rewrites shared.py on top of it.
    git(['merge', '-q', '--ff-only', upstreamSha]);
    fs.writeFileSync(path.join(repo, 'shared.py'), BASE + UPSTREAM + OWN);
    turn.wrote = true;

    // Poll 2: the write reaches the backfill.
    await reconcileSession({ ...scanned(), mtimeMs: Date.now() }, adapter(turn), d);

    const edit = sharedEdit(updates);
    expect(edit, 'no editsJson write for shared.py reached the API').toBeTruthy();
    expect(edit!.newContent).toBe(BASE + UPSTREAM + OWN);
    // THE DEFECT: the before-state must include what the pull brought in, so
    // the turn's own change is the one line, not twenty-one.
    expect(edit!.oldContent, 'the before-state is the pre-pull file: the pulled lines are billed to the turn').toBe(BASE + UPSTREAM);
  }, 30_000);

  it("does not re-baseline an earlier turn on a LATER turn's pull", async () => {
    // Upstream PREPENDS to shared.py so a stash around the pull merges cleanly
    // with turn 0's appended line.
    const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
    git(['checkout', '-q', '-b', 'upstream-top', 'main']);
    fs.writeFileSync(path.join(repo, 'shared.py'), UPSTREAM + BASE);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feat: prepend (#9998)'], {
      GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_AUTHOR_DATE: earlier,
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_DATE: earlier,
    });
    const prependSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);

    const prompts = ['add my line to shared.py', 'now pull main'];
    const view = { count: 1, wrote: false };
    const twoTurns: TranscriptAdapter = {
      slug: 'hooklessagent',
      agentSlugForServer: 'hookless-agent',
      listActive: () => [],
      parse: (): ParsedSession => ({
        userPrompts: prompts.slice(0, view.count),
        promptTimestamps: [1_000, 2_000].slice(0, view.count),
        transcript: 'the transcript',
        model: 'some-model',
        tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 1,
        promptEdits: [
          { promptIndex: 0, edits: view.wrote ? [{ file: path.join(repo, 'shared.py'), op: 'write', newContent: BASE + OWN }] : [] },
          ...(view.count > 1 ? [{ promptIndex: 1, edits: [] }] : []),
        ],
      }) as ParsedSession,
    };
    const updates: any[] = [];
    const d = deps(updates);

    // Poll 1: turn 0's baseline is the base commit. Turn 0 appends its line.
    await reconcileSession(scanned(), twoTurns, d);
    fs.writeFileSync(path.join(repo, 'shared.py'), BASE + OWN);

    // Poll 2: turn 1 is noticed; its baseline is still the base commit.
    view.count = 2;
    const second = await reconcileSession({ ...scanned(), mtimeMs: Date.now() }, twoTurns, d);
    expect((second?.promptShadows || []).find((s) => s.promptIndex === 1)?.baselineSha, 'no baseline for prompt 1').toBeTruthy();

    // Turn 1 pulls a foreign commit that changes the same file.
    git(['stash', '-q']);
    git(['merge', '-q', '--ff-only', prependSha]);
    git(['stash', 'pop', '-q']);
    expect(fs.readFileSync(path.join(repo, 'shared.py'), 'utf-8')).toBe(UPSTREAM + BASE + OWN);

    // Poll 3: turn 0's whole-file write reaches the backfill.
    view.wrote = true;
    await reconcileSession({ ...scanned(), mtimeMs: Date.now() }, twoTurns, d);

    const edit = sharedEdit(updates);
    expect(edit, 'no editsJson write for shared.py reached the API').toBeTruthy();
    // Turn 0's window closes at turn 1's shadow: the pull is turn 1's, so turn
    // 0 is still measured from the base file.
    expect(edit!.oldContent, "turn 0 was re-baselined on turn 1's pull").toBe(BASE);
  }, 30_000);
});
