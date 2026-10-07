// Context replay grades an agent on a past task. The one property that makes
// its numbers mean anything is that the agent cannot see the answer: not in
// git history, not in a note, not in the memory digest. Most of this file pins
// that, against a real repo.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  memoryPayloadAsOf, parseClaudeJson, prepareTaskBase, stripManagedBlock, summarizeResults, validateTask,
  copyForArm, armBranch, armChangedFiles, gradeabilityProblems, noteAsOf, testsImportingModules, type ArmResult, type ReplayTask,
} from '../context-replay.js';
import { DEFAULT_REPLAY_VARIANTS, contextVariant, variantAllowsFileCards, variantAllowsHistorySearchNote, variantAllowsRepoContext } from '../context-variant.js';
import { memoryReadBlocked } from '../memory.js';
import { armEnv } from '../commands/benchmark-replay.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.ORIGIN_CONTEXT_VARIANT;
});

function tmp(prefix: string): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

describe('context variants', () => {
  it('reads the variant from the environment and ignores anything else', () => {
    expect(contextVariant({ ORIGIN_CONTEXT_VARIANT: 'file-cards' })).toBe('file-cards');
    expect(contextVariant({ ORIGIN_CONTEXT_VARIANT: ' NONE ' })).toBe('none');
    expect(contextVariant({ ORIGIN_CONTEXT_VARIANT: 'everything' })).toBeNull();
    expect(contextVariant({})).toBeNull();
  });

  it('gives each arm exactly its slice, and a normal session everything', () => {
    expect([variantAllowsRepoContext('none'), variantAllowsFileCards('none')]).toEqual([false, false]);
    expect([variantAllowsRepoContext('baseline'), variantAllowsFileCards('baseline')]).toEqual([true, false]);
    expect([variantAllowsRepoContext('file-cards'), variantAllowsFileCards('file-cards')]).toEqual([false, true]);
    expect([variantAllowsRepoContext(null), variantAllowsFileCards(null)]).toEqual([true, true]);
  });

  it('hands a search arm no memory, only the note that it can look the history up', () => {
    expect(contextVariant({ ORIGIN_CONTEXT_VARIANT: 'search' })).toBe('search');
    expect([variantAllowsRepoContext('search'), variantAllowsFileCards('search')]).toEqual([false, false]);
    expect(variantAllowsHistorySearchNote('search')).toBe(true);
    for (const v of ['none', 'baseline', 'file-cards', null] as const) expect(variantAllowsHistorySearchNote(v)).toBe(false);
  });

  it('runs search only when asked for: the default replay is the three original arms', () => {
    expect([...DEFAULT_REPLAY_VARIANTS]).toEqual(['none', 'baseline', 'file-cards']);
  });

  it('opens memory reads in a bake-off repo only under a variant', () => {
    const repo = path.join(os.homedir(), '.origin', 'bakeoff-repos', 'replay', 'x');
    expect(memoryReadBlocked(repo)).toBe(true);
    process.env.ORIGIN_CONTEXT_VARIANT = 'baseline';
    expect(memoryReadBlocked(repo)).toBe(false);
  });
});

describe('pure helpers', () => {
  it('runs an arm as its own session, not as a child of the Claude session that started it', () => {
    const env = armEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', ANTHROPIC_API_KEY: 'k' });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' });
  });

  it('keeps only memory records dated before the cut, whatever their date field', () => {
    const cut = Date.parse('2026-09-10T00:00:00Z');
    const out = memoryPayloadAsOf({
      version: 2,
      sessions: [{ id: 'old', endedAt: '2026-09-09T00:00:00Z' }, { id: 'new', endedAt: '2026-09-11T00:00:00Z' }, { id: 'undated' }],
      commits: [{ id: 'c-old', committedAt: '2026-09-01T00:00:00Z' }, { id: 'c-new', committedAt: '2026-09-12T00:00:00Z' }],
      closedTodos: [{ id: 't', at: '2026-09-15T00:00:00Z' }],
    }, cut);
    expect(out.version).toBe(2);
    expect(out.sessions.map((s: any) => s.id)).toEqual(['old']);
    expect(out.commits.map((c: any) => c.id)).toEqual(['c-old']);
    expect(out.closedTodos).toEqual([]);
  });

  it('strips Origin\'s managed block and keeps what people wrote', () => {
    const text = '<!-- origin-managed -->\nOrigin: tracking\nmemory digest\n<!-- /origin-managed -->\n\n# Project rules\nUse tabs.\n';
    expect(stripManagedBlock(text)).toBe('# Project rules\nUse tabs.\n');
    expect(stripManagedBlock('# no block\n')).toBe('# no block\n');
  });

  it('reads cost, turns, time and tokens from Claude\'s JSON result', () => {
    const r = parseClaudeJson('noise\n{"is_error":false,"total_cost_usd":1.25,"num_turns":14,"duration_ms":90000,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":7}}');
    expect(r).toMatchObject({ isError: false, costUsd: 1.25, turns: 14, durationMs: 90000, inputTokens: 100, outputTokens: 7 });
    expect(parseClaudeJson('{"is_error":true,"result":"Failed to authenticate"}')).toMatchObject({ isError: true, error: 'Failed to authenticate' });
    expect(parseClaudeJson('not json').isError).toBe(true);
  });

  it('summarizes per variant, counting an agent error as a failed run', () => {
    const r = (variant: any, testsPassed: boolean, costUsd: number | null, agentOk = true): ArmResult => ({
      runId: 'r', taskId: 't', variant, repeat: 1, agentOk, testsPassed, costUsd, turns: 10, durationMs: 60_000,
      inputTokens: null, outputTokens: null, filesChanged: [], fileRecall: 0.5, finishedAt: '',
    });
    const [none, cards] = summarizeResults([r('none', false, 2), r('none', true, 4), r('file-cards', false, null, false)]);
    expect(none).toMatchObject({ variant: 'none', runs: 2, passRate: 0.5, meanCostUsd: 3, meanDurationMin: 1, agentErrors: 0 });
    expect(cards).toMatchObject({ variant: 'file-cards', runs: 1, passRate: 0, meanCostUsd: null, agentErrors: 1 });
  });
});

// ─── Against a real repo ─────────────────────────────────────────────────────

function sourceRepo(): { src: string; parent: string; commit: string; future: string } {
  const src = tmp('origin-replay-src-');
  git(src, 'init', '-q');
  git(src, 'config', 'user.email', 'dev@example.com');
  git(src, 'config', 'user.name', 'Dev');
  git(src, 'config', 'commit.gpgsign', 'false');
  const at = (iso: string) => ({ ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  const commit = (msg: string, iso: string) => execFileSync('git', ['commit', '-qm', msg], { cwd: src, env: at(iso) });

  fs.writeFileSync(path.join(src, 'CLAUDE.md'), '<!-- origin-managed -->\nOrigin digest: the answer is 42\n<!-- /origin-managed -->\n\n# Rules\nBe brief.\n');
  fs.writeFileSync(path.join(src, 'add.js'), 'module.exports = (a, b) => a - b;\n');
  git(src, 'add', '.');
  commit('init', '2026-09-01T00:00:00Z');
  const root = git(src, 'rev-parse', 'HEAD');
  const parent = root;

  fs.writeFileSync(path.join(src, 'add.js'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(src, 'add.test.js'), "const add = require('./add.js');\nif (add(2, 3) !== 5) { console.error('wrong'); process.exit(1); }\n");
  git(src, 'add', '.');
  commit('fix: add adds', '2026-09-05T00:00:00Z');
  const fix = git(src, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(src, 'later.js'), 'later\n');
  git(src, 'add', '.');
  commit('later work', '2026-09-08T00:00:00Z');
  const future = git(src, 'rev-parse', 'HEAD');

  // Notes on every commit, and a memory note with records before and after.
  for (const sha of [root, fix, future]) git(src, 'notes', '--ref=origin', 'add', '-m', JSON.stringify({ sessionId: `s-${sha.slice(0, 6)}` }), sha);
  git(src, 'notes', '--ref=origin-memory', 'add', '-m', JSON.stringify({
    version: 2,
    sessions: [
      { sessionId: 'before', endedAt: '2026-08-31T00:00:00Z', summary: 'set up the repo' },
      { sessionId: 'solver', endedAt: '2026-09-05T00:00:00Z', summary: 'made add add' },
    ],
    commits: [],
  }), root);
  return { src, parent, commit: fix, future };
}

const task = (commit: string): ReplayTask => ({
  id: 'add', commit, prompt: 'add() is wrong, fix it', tests: ['add.test.js'], testCommand: 'node {tests}',
});

describe('prepareTaskBase', () => {
  it('holds only the history before the task: no future commit, note or memory record', () => {
    const { src, parent, commit, future } = sourceRepo();
    const base = prepareTaskBase(src, task(commit), tmp('origin-replay-task-'));

    // History stops at the parent.
    expect(git(base, 'rev-list', '--all').split('\n')).not.toContain(commit);
    expect(() => git(base, 'cat-file', '-e', `${commit}^{commit}`)).toThrow();
    expect(() => git(base, 'cat-file', '-e', `${future}^{commit}`)).toThrow();
    // No remote to fetch the rest from.
    expect(git(base, 'remote')).toBe('');

    // Notes: only the parent's survives, and no older notes tree is reachable.
    expect(git(base, 'notes', '--ref=origin', 'list').split('\n').map((l) => l.split(' ')[1])).toEqual([parent]);
    expect(git(base, 'rev-list', '--count', 'refs/notes/origin')).toBe('1');

    // Memory: the session that solved the task ended after the parent — gone.
    const memory = JSON.parse(git(base, 'notes', '--ref=origin-memory', 'show', parent));
    expect(memory.sessions.map((s: any) => s.sessionId)).toEqual(['before']);

    // The injected digest is gone from CLAUDE.md; the person's rules are not.
    const claude = fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf-8');
    expect(claude).not.toContain('Origin digest');
    expect(claude).toContain('Be brief.');
    expect(git(base, 'status', '--porcelain')).toBe('');
  });

  it('validates a task whose tests fail on the parent and pass on the commit', () => {
    const { src, commit } = sourceRepo();
    const v = validateTask(src, task(commit), tmp('origin-replay-validate-'));
    expect(v).toMatchObject({ failsOnParent: true, passesOnCommit: true });
  });

  it('sees what an arm changed, committed or not', () => {
    const { src, commit } = sourceRepo();
    const dir = tmp('origin-replay-arm-');
    const base = prepareTaskBase(src, task(commit), dir);
    const arm = path.join(dir, 'arm');
    copyForArm(base, arm);
    fs.writeFileSync(path.join(arm, 'add.js'), 'module.exports = (a, b) => a + b;\n');
    git(arm, 'commit', '-qam', 'agent fix');
    fs.writeFileSync(path.join(arm, 'notes.txt'), 'scratch\n');
    // Origin's own session-start write, in every arm — not the agent's work.
    fs.appendFileSync(path.join(arm, 'CLAUDE.md'), '\n<!-- origin-managed -->\nOrigin: tracking\n<!-- /origin-managed -->\n');
    expect(armChangedFiles(arm)).toEqual(['add.js', 'notes.txt']);
  });

  it('puts each arm on a bake-off branch, so its session stays out of Sessions and Prompt Search', () => {
    const { src, commit } = sourceRepo();
    const dir = tmp('origin-replay-branch-');
    const base = prepareTaskBase(src, task(commit), dir);
    const arm = path.join(dir, 'arm');
    const branch = armBranch('2026-09-30-a1b2c3', 'checkout round/trip-none-1');
    expect(branch).toBe('bakeoff/replay/2026-09-30-a1b2c3/checkout-round-trip-none-1');
    copyForArm(base, arm, branch);
    expect(git(arm, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(git(arm, 'rev-parse', 'HEAD')).toBe(git(base, 'rev-parse', 'HEAD'));
    // The cached base keeps its own branch for the next run.
    expect(git(base, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('replay');
  });
});

describe('gradeabilityProblems', () => {
  const parent = (files: Record<string, string>) => (rel: string) => files[rel] ?? null;

  it('rejects a test that reads source code, as round 1\'s heartbeat test did', () => {
    const test = "import ts from 'typescript';\nconst source = fs.readFileSync(new URL('../heartbeat.ts', import.meta.url), 'utf8');";
    const problems = gradeabilityProblems({ prompt: 'fix it' }, { 'src/__tests__/h.test.ts': test }, parent({}));
    expect(problems.join()).toMatch(/reads source code/);
  });

  it('rejects a test importing a name the parent lacks, unless the prompt names it', () => {
    const test = "import { stillOwnsSession, pingOnce } from '../heartbeat.js';";
    const files = parent({ 'src/heartbeat.ts': 'export async function pingOnce() {}\n' });
    const blind = gradeabilityProblems({ prompt: 'the daemon keeps sending' }, { 'src/__tests__/h.test.ts': test }, files);
    expect(blind).toEqual(['src/__tests__/h.test.ts imports stillOwnsSession from src/heartbeat.ts, which the parent does not export and the prompt does not name']);
    const named = gradeabilityProblems({ prompt: 'add stillOwnsSession() to heartbeat.ts' }, { 'src/__tests__/h.test.ts': test }, files);
    expect(named).toEqual([]);
  });

  it('accepts names the parent exports in any form, aliases and type imports included', () => {
    const test = "import { a, b as bee, type C, D } from '../m.js';";
    const files = parent({ 'src/m.ts': 'export const a = 1;\nfunction b() {}\nexport interface C {}\nexport { b, D };\n' });
    expect(gradeabilityProblems({ prompt: '' }, { 'src/__tests__/m.test.ts': test }, files)).toEqual([]);
  });
});

describe('noteAsOf', () => {
  it('returns the note as it stood at a past time, not today\'s', () => {
    const repo = tmp('origin-note-as-of-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'dev@example.com');
    git(repo, 'config', 'user.name', 'Dev');
    fs.writeFileSync(path.join(repo, 'a'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    const root = git(repo, 'rev-parse', 'HEAD');
    const at = (iso: string, text: string) => execFileSync('git', ['notes', '--ref=origin-memory', 'add', '-f', '-m', text, root], {
      cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso },
    });
    at('2026-09-01T00:00:00Z', 'first');
    at('2026-09-10T00:00:00Z', 'second');
    at('2026-09-20T00:00:00Z', 'third');
    expect(noteAsOf(repo, 'refs/notes/origin-memory', root, Date.parse('2026-09-15T00:00:00Z'))?.trim()).toBe('second');
    expect(noteAsOf(repo, 'refs/notes/origin-memory', root, Date.parse('2026-08-01T00:00:00Z'))).toBeNull();
    expect(noteAsOf(repo, 'refs/notes/origin-memory-brief', root, Date.now())).toBeNull();
  });
});

describe('testsImportingModules', () => {
  const tests = {
    'packages/cli/src/__tests__/stop-probe.test.ts': "import { recordProbedShellEdits } from '../commands/hooks/stop.js';",
    'packages/cli/src/__tests__/ledger.test.ts': "import { applyLedgerToMappings } from '../capture-from-ledger.js';",
    'packages/cli/src/__tests__/unrelated.test.ts': "import { x } from '../heartbeat.js';",
    'packages/cli/src/__tests__/capture-e2e-stop.test.ts': "import { y } from '../commands/hooks/stop.js';",
    'packages/cli/src/__tests__/the-fix.test.ts': "import { z } from '../commands/hooks/stop.js';",
  };

  it('picks the existing tests of the modules the fix changed, not end-to-end ones or the fix\'s own', () => {
    const out = testsImportingModules(
      ['packages/cli/src/commands/hooks/stop.ts', 'packages/cli/src/capture-from-ledger.ts', 'packages/cli/package.json'],
      tests,
      ['packages/cli/src/__tests__/the-fix.test.ts'],
    );
    expect(out).toEqual(['packages/cli/src/__tests__/ledger.test.ts', 'packages/cli/src/__tests__/stop-probe.test.ts']);
  });

  it('has nothing to pick when the fix changed no source module', () => {
    expect(testsImportingModules(['docs/CLI.md', 'packages/cli/src/__tests__/a.test.ts'], tests)).toEqual([]);
  });
});

describe('summarizeResults regression rate', () => {
  const r = (variant: any, regressionPassed: boolean | null | undefined): ArmResult => ({
    runId: 'r', taskId: 't', variant, repeat: 1, agentOk: true, testsPassed: true, costUsd: 1, turns: 1, durationMs: 1,
    inputTokens: null, outputTokens: null, filesChanged: [], fileRecall: null, finishedAt: '', regressionPassed,
  });

  it('counts only runs that had regression tests', () => {
    const [none, cards] = summarizeResults([r('none', true), r('none', false), r('none', null), r('file-cards', undefined)]);
    expect(none.regressionPassRate).toBe(0.5);
    expect(cards.regressionPassRate).toBeNull();
  });
});
