// ─── Context replay: measure what Origin's context is worth ──────────────────
//
// Replays past tasks with the same agent under different context variants
// (context-variant.ts) and grades each run the same day, instead of waiting
// 7-30 days for survival:
//
//   1. A task is a real past commit, the prompt that asked for it, and the test
//      files that commit added or changed.
//   2. The agent works in a FRESH clone that holds only the history up to the
//      commit's parent. A worktree of the real repo would not do: `git log
//      --all` would show the agent the answer. Notes are pruned the same way,
//      and the memory note is cut to sessions that ended before the parent was
//      committed — otherwise memory would describe the solution.
//   3. Each arm runs in its own copy of that clone with ORIGIN_CONTEXT_VARIANT
//      set; Origin's hooks inherit it from the agent.
//   4. Afterwards the commit's own test files are dropped in and run. Cost,
//      turns and time come from the agent's JSON output.
//
// Arms live under ~/.origin/bakeoff-repos/, so isBakeoffRepo keeps Origin from
// WRITING any of it into memory, while the variant lets the injection paths
// READ the pruned history the clone was given.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDetailed } from './utils/exec.js';
import { isOriginAutoManagedPath } from './ignore-patterns.js';
import type { ContextVariant } from './context-variant.js';

export interface ReplayTask {
  id: string;
  /** The past commit whose change the agent must reproduce. */
  commit: string;
  /** What to ask the agent. Should read like the original request, not the diff. */
  prompt: string;
  /** Repo-relative test files taken from `commit` and run to grade an arm. */
  tests: string[];
  /** Command run in the arm to grade it. `{tests}` expands to the test files. */
  testCommand: string;
  /**
   * Repo-relative directory the test command runs in; `{tests}` is then given
   * relative to it. A package-scoped runner (vitest with `--root`) matches its
   * own relative paths, not the repo's.
   */
  testDir?: string;
  /** Run once in the base clone before any arm (e.g. installing dependencies). */
  setupCommand?: string;
}

export interface ReplayTaskFile {
  /** Source repo. Defaults to the current repo. */
  repo?: string;
  tasks: ReplayTask[];
}

export interface ArmResult {
  runId: string;
  taskId: string;
  variant: ContextVariant;
  repeat: number;
  /** Agent finished without an error. */
  agentOk: boolean;
  agentError?: string;
  /** Reference tests passed on the arm's result. */
  testsPassed: boolean;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * The task's regression tests — existing tests of the modules the real fix
   * changed — still pass on the arm's result. Null when the task has none.
   */
  regressionPassed?: boolean | null;
  /** The regression test files that failed. */
  regressionFailures?: string[];
  /** Files the arm changed, and how many of the real commit's non-test files it touched. */
  filesChanged: string[];
  fileRecall: number | null;
  finishedAt: string;
  /** `<taskId>-<variant>-<repeat>`; the arm's directory name. */
  armName?: string;
  /** The branch the arm worked on (armBranch). Absent on runs before it existed. */
  branch?: string;
  model?: string;
  /** The task's prompt, so the Replays tab can say what was asked. */
  prompt?: string;
  /** The repo the task came from. The upload is filed under the org that owns it. */
  sourceRepo?: string;
}

const MANAGED_OPEN = '<!-- origin-managed -->';
const MANAGED_CLOSE = '<!-- /origin-managed -->';
const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const START_REF = 'refs/replay/start';
// Bumped when what a base clone holds changes, so a cached base from an older
// harness is rebuilt. 2: memory read from the notes' history at the parent.
const BASE_FORMAT = 2;

function git(cwd: string, args: string[], timeoutMs = 120_000): string {
  const r = runDetailed('git', args, { cwd, timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

function gitOk(cwd: string, args: string[]): string | null {
  const r = runDetailed('git', args, { cwd, timeoutMs: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Root for replay runs. Under bakeoff-repos so Origin never writes arm work to memory. */
export function replayRoot(): string {
  return path.join(os.homedir(), '.origin', 'bakeoff-repos', 'replay');
}

/**
 * Keep only the memory records that existed before `asOf`. Every record type
 * carries a date; one without a date is dropped rather than guessed about.
 * Pure + exported for testing.
 */
export function memoryPayloadAsOf(payload: Record<string, any>, asOf: number): Record<string, any> {
  const when = (r: Record<string, any>): number => {
    const d = r?.endedAt || r?.committedAt || r?.at || r?.createdAt || r?.startedAt;
    const t = Date.parse(d || '');
    return Number.isFinite(t) ? t : Infinity;
  };
  const out: Record<string, any> = { ...payload };
  for (const key of Object.keys(payload)) {
    if (Array.isArray(payload[key])) out[key] = payload[key].filter((r: any) => when(r) < asOf);
  }
  return out;
}

/** Remove Origin's managed block from a context file's text. Pure + exported for testing. */
export function stripManagedBlock(text: string): string {
  const start = text.indexOf(MANAGED_OPEN);
  if (start < 0) return text;
  const end = text.indexOf(MANAGED_CLOSE, start);
  const cut = end < 0 ? text.length : end + MANAGED_CLOSE.length;
  return (text.slice(0, start) + text.slice(cut)).replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n');
}

/** The notes refs a session reads its memory from, both keyed on the root commit. */
const MEMORY_NOTE_REFS = ['refs/notes/origin-memory', 'refs/notes/origin-memory-brief'];

/**
 * The note `ref` held for `object` at time `asOf`: the newest commit of the
 * notes ref at or before then, and the blob it keeps for the object (notes
 * trees may fan paths out as `ab/cdef…`). Null when the ref has no history
 * that old, or no note for the object in it.
 */
export function noteAsOf(repo: string, ref: string, object: string, asOf: number): string | null {
  const at = gitOk(repo, ['log', '-1', `--before=${new Date(asOf).toISOString()}`, '--format=%H', ref]);
  const commit = at?.trim();
  if (!commit) return null;
  const names = gitOk(repo, ['ls-tree', '-r', '--name-only', commit]) || '';
  const entry = names.split('\n').find((n) => n.replace(/\//g, '') === object);
  return entry ? gitOk(repo, ['show', `${commit}:${entry}`]) : null;
}

/**
 * Build the clone every arm of `task` starts from: history up to the commit's
 * parent, pruned notes, memory as of the parent, no injected context files.
 * Returns the clone's path. Idempotent: an existing base is reused.
 */
export function prepareTaskBase(sourceRepo: string, task: ReplayTask, dir: string, log: (m: string) => void = () => {}): string {
  const base = path.join(dir, 'base');
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(base, '.git', 'replay-ready'), 'utf-8'));
    if (ready?.format === BASE_FORMAT) return base;
  } catch { /* absent or from an older format: rebuild */ }
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });

  const commit = git(sourceRepo, ['rev-parse', `${task.commit}^{commit}`]).trim();
  const parent = git(sourceRepo, ['rev-parse', `${commit}^`]).trim();
  const asOf = Date.parse(git(sourceRepo, ['log', '-1', '--format=%cI', parent]).trim());

  log(`task ${task.id}: cloning history up to ${parent.slice(0, 9)}`);
  git(base, ['init', '-q']);
  git(base, ['config', 'user.email', 'replay@origin.local']);
  git(base, ['config', 'user.name', 'Origin replay']);
  git(base, ['config', 'commit.gpgsign', 'false']);
  git(base, ['fetch', '-q', '--no-tags', sourceRepo, parent], 600_000);
  git(base, ['checkout', '-q', '-B', 'replay', parent]);

  // Per-commit notes: fetch, keep only notes on commits this clone has, then
  // re-root the ref as ONE commit so no earlier notes tree (with notes on
  // future commits) is reachable from it.
  if (gitOk(sourceRepo, ['rev-parse', '--verify', '-q', 'refs/notes/origin'])) {
    git(base, ['fetch', '-q', '--no-tags', sourceRepo, 'refs/notes/origin:refs/notes/origin'], 600_000);
    git(base, ['notes', '--ref=origin', 'prune']);
    const tree = git(base, ['rev-parse', 'refs/notes/origin^{tree}']).trim();
    const root = git(base, ['commit-tree', tree, '-m', 'replay: notes as of the task parent']).trim();
    git(base, ['update-ref', 'refs/notes/origin', root]);
  }

  // The memory an agent had at the parent: the notes as they stood then, read
  // from each notes ref's own history. Cutting TODAY's note to records dated
  // before the parent was the first version, and it starved the baseline arm:
  // the note keeps only its newest sessions, so a task from a few days back
  // got 0 sessions and 4 commit records where the note of that day held 20
  // sessions and 212. The date filter still runs over the historical note, as
  // a guard against a record written late.
  const srcRoot = git(sourceRepo, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n').pop()!;
  const cloneRoot = git(base, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n').pop()!;
  if (cloneRoot === srcRoot) { // path-compare-ok: two commit SHAs
    for (const ref of MEMORY_NOTE_REFS) {
      const raw = noteAsOf(sourceRepo, ref, srcRoot, asOf)
        ?? (ref === 'refs/notes/origin-memory' ? gitOk(sourceRepo, ['notes', `--ref=${ref}`, 'show', srcRoot]) : null);
      if (!raw) continue;
      try {
        const payload = ref === 'refs/notes/origin-memory' ? JSON.stringify(memoryPayloadAsOf(JSON.parse(raw), asOf)) : raw;
        const file = path.join(dir, `${ref.split('/').pop()}-as-of.json`);
        fs.writeFileSync(file, payload);
        git(base, ['notes', `--ref=${ref}`, 'add', '-f', '-F', file, cloneRoot]);
      } catch (e: any) {
        log(`task ${task.id}: ${ref} not copied (${e.message})`);
      }
    }
  }

  // Context files as committed at the parent carry Origin's digest from that
  // time. Every arm starts without it; the variant decides what it gets.
  let stripped = false;
  for (const name of CONTEXT_FILES) {
    const f = path.join(base, name);
    if (!fs.existsSync(f)) continue;
    const before = fs.readFileSync(f, 'utf-8');
    const after = stripManagedBlock(before);
    if (after === before) continue;
    if (after.trim()) fs.writeFileSync(f, after);
    else fs.rmSync(f);
    stripped = true;
  }
  if (stripped) {
    git(base, ['add', '-A']);
    git(base, ['commit', '-q', '-m', 'replay: remove injected context from the task parent']);
  }
  // Where every arm starts, so what an arm changed includes its own commits.
  git(base, ['update-ref', START_REF, 'HEAD']);

  // Drop every object the clone no longer references (old notes trees).
  git(base, ['reflog', 'expire', '--expire=now', '--all']);
  git(base, ['gc', '-q', '--prune=now'], 600_000);

  if (task.setupCommand) {
    log(`task ${task.id}: setup — ${task.setupCommand}`);
    const r = runDetailed('sh', ['-c', task.setupCommand], { cwd: base, timeoutMs: 1_800_000 });
    if (r.status !== 0) throw new Error(`setup failed for ${task.id}: ${(r.stderr || r.stdout).slice(-2000)}`);
  }

  fs.writeFileSync(path.join(base, '.git', 'replay-ready'), JSON.stringify({ format: BASE_FORMAT, commit, parent, asOf: new Date(asOf).toISOString() }));
  return base;
}

/**
 * The branch an arm works on. Under `bakeoff/` so the server files the arm's
 * session with bake-offs: hidden from Sessions and Prompt Search, shown on the
 * Benchmarks page. The base clone's own branch (`replay`) matched nothing and
 * every arm landed in the main views.
 */
export function armBranch(runId: string, armName: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'x';
  return `bakeoff/replay/${safe(runId)}/${safe(armName)}`;
}

/** Copy the base clone for one arm. APFS clones make this near-free on macOS. */
export function copyForArm(base: string, armDir: string, branch?: string): void {
  fs.rmSync(armDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(armDir), { recursive: true });
  const clone = runDetailed('cp', ['-cR', base, armDir], { timeoutMs: 600_000 });
  if (clone.status !== 0) {
    const plain = runDetailed('cp', ['-R', base, armDir], { timeoutMs: 1_800_000 });
    if (plain.status !== 0) throw new Error(`copy failed: ${plain.stderr}`);
  }
  fs.rmSync(path.join(armDir, '.git', 'replay-ready'), { force: true });
  // Same commit, new name — the base clone stays reusable across runs.
  if (branch) git(armDir, ['checkout', '-q', '-B', branch]);
}

/** Files the arm changed relative to its starting commit, tracked or not. */
export function armChangedFiles(armDir: string): string[] {
  const out = gitOk(armDir, ['status', '--porcelain', '--untracked-files=all']) || '';
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const name = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
    files.add(name);
  }
  // Commits the agent made on top of the starting point count too.
  const committed = gitOk(armDir, ['diff', '--name-only', START_REF, 'HEAD']);
  for (const f of (committed || '').split('\n')) if (f) files.add(f);
  // Origin's session start writes its notice into CLAUDE.md / AGENTS.md in
  // every arm. That is Origin's write, not the agent's, and it put CLAUDE.md
  // on every pilot arm's list.
  return [...files].filter((f) => !isOriginAutoManagedPath(f)).sort();
}

/** Parse Claude Code's `--output-format json` result. Pure + exported for testing. */
export function parseClaudeJson(stdout: string): Pick<ArmResult, 'costUsd' | 'turns' | 'durationMs' | 'inputTokens' | 'outputTokens'> & { isError: boolean; error?: string } {
  const text = stdout.trim();
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{');
  try {
    const d = JSON.parse(text.slice(Math.max(0, start)));
    const u = d.usage || {};
    const input = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens]
      .reduce((n: number, v: unknown) => n + (typeof v === 'number' ? v : 0), 0);
    return {
      isError: !!d.is_error,
      error: d.is_error ? String(d.result || d.terminal_reason || 'error').slice(0, 300) : undefined,
      costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null,
      turns: typeof d.num_turns === 'number' ? d.num_turns : null,
      durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : null,
      inputTokens: input || null,
      outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    };
  } catch {
    return { isError: true, error: 'no JSON result from the agent', costUsd: null, turns: null, durationMs: null, inputTokens: null, outputTokens: null };
  }
}

/** Write the task commit's reference test files into `dir`, from the source repo. */
export function installReferenceTests(sourceRepo: string, task: ReplayTask, dir: string): void {
  for (const t of task.tests) {
    const content = runDetailed('git', ['show', `${task.commit}:${t}`], { cwd: sourceRepo, maxBuffer: 64 * 1024 * 1024 });
    if (content.status !== 0) throw new Error(`test file ${t} not found at ${task.commit}`);
    fs.mkdirSync(path.dirname(path.join(dir, t)), { recursive: true });
    fs.writeFileSync(path.join(dir, t), content.stdout);
  }
}

/** Run the task's test command in `dir`. */
export function runReferenceTests(task: ReplayTask, dir: string, timeoutMs = 1_200_000): { passed: boolean; ran: boolean; tail: string } {
  const cwd = path.join(dir, task.testDir || '');
  const rel = task.tests.map((t) => path.relative(cwd, path.join(dir, t)));
  const cmd = task.testCommand.replace('{tests}', rel.map((t) => `'${t.replace(/'/g, `'\\''`)}'`).join(' '));
  const r = runDetailed('sh', ['-c', cmd], { cwd, timeoutMs });
  const out = r.stdout + r.stderr;
  // A runner that found nothing to run also exits non-zero. That is a broken
  // task, not a failing one, and must never read as "fails on the parent".
  const ran = !/no test files found/i.test(out);
  return { passed: r.status === 0 && ran, ran, tail: out.slice(-1500) };
}

/**
 * Why a task's tests cannot grade an agent fairly, from their text alone.
 * Round 1 had both:
 *
 *   - a test that read heartbeat.ts's SOURCE, cut one function out of it and
 *     injected a helper by name. A correct fix built any other way failed, and
 *     the arm that passed was the one whose names happened to match.
 *   - a test importing a name the parent does not export yet. No agent can
 *     pass it unless the prompt names it.
 *
 * `testSources` maps each test path to its text at the commit; `parentFile`
 * reads a repo-relative file at the parent (null when absent). Pure + exported
 * for testing.
 */
export function gradeabilityProblems(
  task: Pick<ReplayTask, 'prompt'>,
  testSources: Record<string, string>,
  parentFile: (repoRelative: string) => string | null,
): string[] {
  const problems: string[] = [];
  for (const [testPath, text] of Object.entries(testSources)) {
    if (/from ['"]typescript['"]|readFileSync\(\s*new URL\(\s*['"]\.\.?\/[^'"]+\.[cm]?[jt]sx?['"]/.test(text)) {
      problems.push(`${testPath} reads source code, so it grades one implementation, not the behaviour`);
    }
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const modRel = path.posix.normalize(path.posix.join(path.posix.dirname(testPath), m[2])).replace(/\.js$/, '.ts');
      const source = parentFile(modRel) ?? parentFile(modRel.replace(/\.ts$/, '/index.ts'));
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        const exported = source !== null && new RegExp(
          `export\\s+(declare\\s+)?(async\\s+)?(function\\*?|const|let|var|class|interface|type|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`,
        ).test(source);
        if (!exported && !task.prompt.includes(name)) {
          problems.push(`${testPath} imports ${name} from ${modRel}, which the parent does not export and the prompt does not name`);
        }
      }
    }
  }
  return problems;
}

/**
 * Check a task is gradeable: its reference tests must FAIL on the parent (or
 * the task asks for nothing) and PASS on the commit (or the tests are broken).
 */
export function validateTask(sourceRepo: string, task: ReplayTask, dir: string, log: (m: string) => void = () => {}): { failsOnParent: boolean; passesOnCommit: boolean; problems: string[]; detail: string } {
  const base = prepareTaskBase(sourceRepo, task, dir, log);
  const testSources: Record<string, string> = {};
  for (const t of task.tests) testSources[t] = gitOk(sourceRepo, ['show', `${task.commit}:${t}`]) || '';
  const problems = gradeabilityProblems(task, testSources, (rel) => {
    const f = path.join(base, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null;
  });
  const onParent = path.join(dir, 'validate-parent');
  copyForArm(base, onParent);
  installReferenceTests(sourceRepo, task, onParent);
  const parentRun = runReferenceTests(task, onParent);

  // The commit's full tree over the base: the change itself plus its tests.
  const onCommit = path.join(dir, 'validate-commit');
  copyForArm(base, onCommit);
  applyCommit(sourceRepo, task, onCommit);
  const commitRun = runReferenceTests(task, onCommit);
  fs.rmSync(onParent, { recursive: true, force: true });
  fs.rmSync(onCommit, { recursive: true, force: true });
  return {
    failsOnParent: parentRun.ran && !parentRun.passed,
    passesOnCommit: commitRun.passed,
    problems,
    detail: commitRun.passed ? parentRun.tail : commitRun.tail,
  };
}

/** Write every file the task's commit changed into `dir`, as the commit left it. */
export function applyCommit(sourceRepo: string, task: ReplayTask, dir: string): void {
  const files = (gitOk(sourceRepo, ['diff', '--name-only', `${task.commit}^`, task.commit]) || '').split('\n').filter(Boolean);
  for (const f of files) {
    const content = runDetailed('git', ['show', `${task.commit}:${f}`], { cwd: sourceRepo, maxBuffer: 64 * 1024 * 1024 });
    const dest = path.join(dir, f);
    if (content.status !== 0) { fs.rmSync(dest, { force: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content.stdout);
  }
}

// ─── Regression grading ──────────────────────────────────────────────────────
//
// A task's reference tests say whether the arm fixed THIS bug. They do not say
// whether it re-broke an earlier one in the same code — which is exactly what
// the file card exists to prevent, so round 3 grades it. The regression set is
// the existing tests of the modules the real fix changed, kept only if they
// pass both before and after the real fix: a test that fails on either is
// flaky, or was changed on purpose by the fix, and grades nothing.

const MAX_REGRESSION_FILES = 12;

/**
 * Test files in `testFiles` (repo-relative, with their text) that import one of
 * the `changedSources` modules. End-to-end tests are left out: they need a
 * build and take minutes. Pure + exported for testing.
 */
export function testsImportingModules(changedSources: string[], testFiles: Record<string, string>, exclude: string[] = []): string[] {
  const stems = changedSources
    .filter((f) => /\.[cm]?tsx?$/.test(f) && !/__tests__|\.test\./.test(f))
    .map((f) => path.posix.basename(f).replace(/\.[cm]?tsx?$/, ''));
  if (!stems.length) return [];
  const skip = new Set(exclude);
  const out: string[] = [];
  for (const [file, text] of Object.entries(testFiles)) {
    if (skip.has(file) || /capture-e2e-/.test(file)) continue;
    const imports = [...text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => path.posix.basename(m[1]).replace(/\.[cm]?[jt]sx?$/, ''));
    if (imports.some((i) => stems.includes(i))) out.push(file);
  }
  return out.sort();
}

/**
 * The task's regression tests: chosen once per task, then cached next to its
 * base clone. Each candidate must pass on the parent and on the real commit.
 */
export function regressionTestsFor(sourceRepo: string, task: ReplayTask, dir: string, base: string, log: (m: string) => void = () => {}): string[] {
  const cache = path.join(dir, 'regression-tests.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cache, 'utf-8'));
    if (cached?.commit === task.commit && Array.isArray(cached.tests)) return cached.tests;
  } catch { /* choose them */ }

  const testRoot = path.join(base, task.testDir || '', 'src', '__tests__');
  const testFiles: Record<string, string> = {};
  if (fs.existsSync(testRoot)) {
    for (const name of fs.readdirSync(testRoot)) {
      if (!/\.test\.[cm]?tsx?$/.test(name)) continue;
      const rel = path.posix.join(task.testDir || '', 'src', '__tests__', name);
      testFiles[rel] = fs.readFileSync(path.join(testRoot, name), 'utf-8');
    }
  }
  const changed = (gitOk(sourceRepo, ['diff', '--name-only', `${task.commit}^`, task.commit]) || '').split('\n').filter(Boolean);
  const candidates = testsImportingModules(changed, testFiles, task.tests).slice(0, MAX_REGRESSION_FILES * 2);

  const passing = (tree: string): Set<string> => {
    const ok = new Set<string>();
    for (const t of candidates) if (runReferenceTests({ ...task, tests: [t] }, tree).passed) ok.add(t);
    return ok;
  };
  const onParent = path.join(dir, 'regression-parent');
  copyForArm(base, onParent);
  const parentOk = passing(onParent);
  const onCommit = path.join(dir, 'regression-commit');
  copyForArm(base, onCommit);
  applyCommit(sourceRepo, task, onCommit);
  const commitOk = passing(onCommit);
  fs.rmSync(onParent, { recursive: true, force: true });
  fs.rmSync(onCommit, { recursive: true, force: true });

  const tests = candidates.filter((t) => parentOk.has(t) && commitOk.has(t)).slice(0, MAX_REGRESSION_FILES);
  log(`task ${task.id}: ${tests.length} regression test file(s) of ${candidates.length} candidate(s)`);
  fs.writeFileSync(cache, JSON.stringify({ commit: task.commit, tests }));
  return tests;
}

/** Run the regression tests in an arm; name the files that fail. */
export function runRegressionTests(task: ReplayTask, tests: string[], dir: string): { passed: boolean | null; failures: string[] } {
  if (!tests.length) return { passed: null, failures: [] };
  if (runReferenceTests({ ...task, tests }, dir).passed) return { passed: true, failures: [] };
  const failures = tests.filter((t) => !runReferenceTests({ ...task, tests: [t] }, dir).passed);
  return { passed: false, failures };
}

/** The real commit's non-test files — what a faithful arm would have touched. */
export function referenceFiles(sourceRepo: string, task: ReplayTask): string[] {
  const out = gitOk(sourceRepo, ['diff', '--name-only', `${task.commit}^`, task.commit]) || '';
  const tests = new Set(task.tests);
  return out.split('\n').filter((f) => f && !tests.has(f) && !/(^|\/)package(-lock)?\.json$/.test(f));
}

export interface VariantSummary {
  variant: ContextVariant;
  runs: number;
  passRate: number;
  meanCostUsd: number | null;
  meanTurns: number | null;
  meanDurationMin: number | null;
  meanFileRecall: number | null;
  /** Share of runs whose regression tests still pass; null when no run had any. */
  regressionPassRate: number | null;
  agentErrors: number;
}

/** Aggregate results per variant. Errors count as failed runs. Pure + exported for testing. */
export function summarizeResults(results: ArmResult[]): VariantSummary[] {
  const mean = (xs: Array<number | null>): number | null => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const byVariant = new Map<ContextVariant, ArmResult[]>();
  for (const r of results) byVariant.set(r.variant, [...(byVariant.get(r.variant) || []), r]);
  return [...byVariant.entries()].map(([variant, rs]) => {
    const dur = mean(rs.map((r) => r.durationMs));
    return {
      variant,
      runs: rs.length,
      passRate: rs.filter((r) => r.testsPassed).length / rs.length,
      meanCostUsd: mean(rs.map((r) => r.costUsd)),
      meanTurns: mean(rs.map((r) => r.turns)),
      meanDurationMin: dur === null ? null : dur / 60_000,
      meanFileRecall: mean(rs.map((r) => r.fileRecall)),
      regressionPassRate: (() => {
        const graded = rs.filter((r) => typeof r.regressionPassed === 'boolean');
        return graded.length ? graded.filter((r) => r.regressionPassed).length / graded.length : null;
      })(),
      agentErrors: rs.filter((r) => !r.agentOk).length,
    };
  });
}
