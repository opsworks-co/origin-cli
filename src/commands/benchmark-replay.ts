// `origin benchmark replay` — replay past tasks under different context
// variants and grade them the same day. See context-replay.ts for how a task is
// isolated from its own answer, and context-variant.ts for what each arm gets.

import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { findExecutable, runDetailed } from '../utils/exec.js';
import { agentEnvWithKey, resolveAgentKeys } from '../agent-keys.js';
import { waitForLocalCi } from '../local-ci-lock.js';
import { readLocalReplayRuns, uploadReplayArms } from '../replay-upload.js';
import { CONTEXT_VARIANTS, DEFAULT_REPLAY_VARIANTS, type ContextVariant } from '../context-variant.js';
import {
  armBranch, armChangedFiles, copyForArm, installReferenceTests, parseClaudeJson, prepareTaskBase, referenceFiles,
  regressionTestsFor, replayRoot, runReferenceTests, runRegressionTests, summarizeResults, validateTask,
  type ArmResult, type ReplayTaskFile,
} from '../context-replay.js';

export interface ReplayOptions {
  tasks: string;
  variants?: string;
  repeats?: string;
  model?: string;
  only?: string;
  validate?: boolean;
  keep?: boolean;
  timeoutMin?: string;
}

const ARM_TIMEOUT_MIN = 30;

/**
 * The environment an arm's agent runs in: this process's, minus the variables
 * a parent Claude Code session sets for itself. Started from inside one (the
 * desktop app, a terminal session), a child `claude` inherits them and runs as
 * a nested session of the parent — its session id, its host auth — instead of
 * as its own. Pure + exported for testing.
 */
export function armEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    out[k] = v;
  }
  return out;
}

function loadTasks(file: string): ReplayTaskFile {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReplayTaskFile;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) throw new Error(`${file} has no tasks`);
  for (const t of parsed.tasks) {
    if (!t.id || !t.commit || !t.prompt || !Array.isArray(t.tests) || !t.tests.length || !t.testCommand) {
      throw new Error(`task ${t.id || '(no id)'} needs id, commit, prompt, tests and testCommand`);
    }
  }
  return parsed;
}

function parseVariants(raw: string | undefined): ContextVariant[] {
  const list = (raw || DEFAULT_REPLAY_VARIANTS.join(',')).split(',').map((v) => v.trim()).filter(Boolean);
  for (const v of list) {
    if (!(CONTEXT_VARIANTS as readonly string[]).includes(v)) throw new Error(`unknown variant "${v}" (use ${CONTEXT_VARIANTS.join(', ')})`);
  }
  return list as ContextVariant[];
}

export async function benchmarkReplayCommand(opts: ReplayOptions): Promise<void> {
  const taskFile = loadTasks(path.resolve(opts.tasks));
  const sourceRepo = path.resolve(taskFile.repo || runDetailed('git', ['rev-parse', '--show-toplevel']).stdout.trim() || '.');
  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim())) : null;
  const tasks = taskFile.tasks.filter((t) => !only || only.has(t.id));
  const log = (m: string) => console.log(chalk.dim(`  ${m}`));

  if (opts.validate) {
    let bad = 0;
    for (const task of tasks) {
      const v = validateTask(sourceRepo, task, path.join(replayRoot(), 'tasks', task.id), log);
      const ok = v.failsOnParent && v.passesOnCommit && v.problems.length === 0;
      if (!ok) bad++;
      console.log(`${ok ? chalk.green('✓') : chalk.red('✗')} ${task.id}: fails on parent ${v.failsOnParent ? 'yes' : 'NO'}, passes on commit ${v.passesOnCommit ? 'yes' : 'NO'}`);
      for (const p of v.problems) console.log(chalk.red(`    ${p}`));
      if (!v.failsOnParent || !v.passesOnCommit) console.log(chalk.dim(v.detail.split('\n').slice(-12).join('\n')));
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }

  if (!findExecutable('claude')) throw new Error('claude is not on PATH');
  const variants = parseVariants(opts.variants);
  const repeats = Math.max(1, parseInt(opts.repeats || '2', 10) || 2);
  const timeoutMs = Math.max(1, parseInt(opts.timeoutMin || String(ARM_TIMEOUT_MIN), 10) || ARM_TIMEOUT_MIN) * 60_000;
  const runId = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(replayRoot(), 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const resultsFile = path.join(runDir, 'results.jsonl');
  const keys = await resolveAgentKeys();
  console.log(chalk.bold(`Replay ${runId}: ${tasks.length} task(s) × ${variants.join('/')} × ${repeats}`));
  console.log(chalk.dim(`  results: ${resultsFile}`));

  const results: ArmResult[] = [];
  for (const task of tasks) {
    const taskDir = path.join(replayRoot(), 'tasks', task.id);
    const base = prepareTaskBase(sourceRepo, task, taskDir, log);
    const reference = referenceFiles(sourceRepo, task);
    const regression = regressionTestsFor(sourceRepo, task, taskDir, base, log);
    // Interleave variants within each repeat, so drift over a long run (API
    // load, a warm cache) does not land on one variant.
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const variant of variants) {
        const armName = `${task.id}-${variant}-${repeat}`;
        const armDir = path.join(runDir, 'arms', armName);
        // An arm runs the repo's test suite; one started during a local CI
        // run times that run's tests out.
        waitForLocalCi({ log });
        const branch = armBranch(runId, armName);
        copyForArm(base, armDir, branch);
        log(`${task.id} · ${variant} · #${repeat}: running`);
        const args = ['-p', task.prompt, '--dangerously-skip-permissions', '--output-format', 'json'];
        if (opts.model) args.push('--model', opts.model);
        const run = spawnSync('claude', args, {
          cwd: armDir,
          env: { ...armEnv(agentEnvWithKey('ANTHROPIC_API_KEY', keys)), ORIGIN_CONTEXT_VARIANT: variant },
          encoding: 'utf-8',
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        const agent = run.error
          ? { isError: true, error: run.error.message, costUsd: null, turns: null, durationMs: null, inputTokens: null, outputTokens: null }
          : parseClaudeJson(run.stdout || '');

        const filesChanged = armChangedFiles(armDir);
        fs.writeFileSync(path.join(runDir, `${task.id}-${variant}-${repeat}.diff`),
          runDetailed('git', ['diff', 'refs/replay/start'], { cwd: armDir, maxBuffer: 64 * 1024 * 1024 }).stdout);
        installReferenceTests(sourceRepo, task, armDir);
        const tests = runReferenceTests(task, armDir);
        const regress = runRegressionTests(task, regression, armDir);
        const hit = reference.filter((f) => filesChanged.includes(f)).length;

        const result: ArmResult = {
          runId, taskId: task.id, variant, repeat,
          agentOk: !agent.isError, agentError: agent.error,
          testsPassed: tests.passed,
          regressionPassed: regress.passed, regressionFailures: regress.failures,
          costUsd: agent.costUsd, turns: agent.turns, durationMs: agent.durationMs,
          inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
          filesChanged, fileRecall: reference.length ? hit / reference.length : null,
          finishedAt: new Date().toISOString(),
          armName, branch, model: opts.model, prompt: task.prompt, sourceRepo,
        };
        results.push(result);
        fs.appendFileSync(resultsFile, JSON.stringify(result) + '\n');
        const upload = await uploadReplayArms([result]);
        if (!upload.ok) log(chalk.yellow(`  not uploaded to Origin (${upload.error}) — \`origin benchmark replay-sync\` retries`));
        const mark = tests.passed ? chalk.green('pass') : chalk.red('fail');
        const reg = regress.passed === null ? '' : regress.passed ? '  regressions ok' : chalk.red(`  REGRESSED: ${regress.failures.join(', ')}`);
        console.log(`  ${task.id} · ${variant} · #${repeat}: ${mark}${reg}` +
          `${agent.costUsd !== null ? `  $${agent.costUsd.toFixed(2)}` : ''}` +
          `${agent.turns !== null ? `  ${agent.turns} turns` : ''}` +
          `${agent.isError ? chalk.yellow(`  agent error: ${agent.error}`) : ''}`);
        if (!opts.keep) fs.rmSync(armDir, { recursive: true, force: true });
      }
    }
  }

  printSummary(results);
}

export function printSummary(results: ArmResult[]): void {
  const fmt = (n: number | null, d = 2) => (n === null ? '—' : n.toFixed(d));
  console.log('\n' + chalk.bold('variant      runs  pass   $/run  turns  min   file recall  no regressions  agent errors'));
  for (const s of summarizeResults(results)) {
    console.log(
      `${s.variant.padEnd(12)} ${String(s.runs).padStart(4)}  ${`${Math.round(s.passRate * 100)}%`.padStart(4)}  ` +
      `${fmt(s.meanCostUsd).padStart(6)}  ${fmt(s.meanTurns, 1).padStart(5)}  ${fmt(s.meanDurationMin, 1).padStart(4)}  ` +
      `${(s.meanFileRecall === null ? '—' : `${Math.round(s.meanFileRecall * 100)}%`).padStart(11)}  ` +
      `${(s.regressionPassRate === null ? '—' : `${Math.round(s.regressionPassRate * 100)}%`).padStart(14)}  ${String(s.agentErrors).padStart(12)}`,
    );
  }
}

/**
 * `origin benchmark replay-sync` — upload runs already on disk, for the
 * Benchmarks → Replays tab. Safe to repeat: an arm sent again replaces itself.
 */
export async function benchmarkReplaySyncCommand(opts: { only?: string; repo?: string }): Promise<void> {
  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  // Runs written before arms recorded their repo are filed under this one.
  const fallbackRepo = path.resolve(opts.repo || runDetailed('git', ['rev-parse', '--show-toplevel']).stdout.trim() || '.');
  const runs = readLocalReplayRuns(replayRoot()).filter((r) => !only || only.has(r.runId));
  if (runs.length === 0) {
    console.log(chalk.dim(`No replay runs found under ${path.join(replayRoot(), 'runs')}`));
    return;
  }
  let failed = 0;
  for (const run of runs) {
    const out = await uploadReplayArms(run.arms, fallbackRepo);
    if (out.ok) console.log(`${chalk.green('✓')} ${run.runId}: ${run.arms.length} arm(s)`);
    else { failed++; console.log(`${chalk.red('✗')} ${run.runId}: ${out.error}`); }
  }
  if (failed) process.exitCode = 1;
}
