import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { gitReader, isTestFile, replayTaskFor, replayTasksCommand, taskPrompt, type ReplayCandidate } from '../commands/issue-replay-tasks.js';

let root = '';
let repo = '';
const sha: Record<string, string> = {};
const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();
const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-replay-tasks-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.test'); g('config', 'user.name', 'T');
  write('package.json', JSON.stringify({ name: 'root', private: true }));
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write('packages/cli/package.json', JSON.stringify({ name: 'cli', devDependencies: { vitest: '4' } }));
  write('packages/cli/src/a.ts', 'export const a = 1;\n');
  write('packages/cli/src/__tests__/old.test.ts', 'old\n');
  g('add', '.'); g('commit', '-qm', 'base');
  // The fix: code + a new test + an edited test + a deleted test + a fixture.
  write('packages/cli/src/a.ts', 'export const a = 2;\n');
  write('packages/cli/src/__tests__/a.test.ts', 'new test\n');
  write('packages/cli/src/__tests__/fixtures/x.test.ts', 'fixture\n');
  g('rm', '-q', 'packages/cli/src/__tests__/old.test.ts');
  g('add', '.'); g('commit', '-qm', 'fix (#12)');
  sha.fix = g('rev-parse', 'HEAD');
  write('README.md', 'docs\n'); g('add', '.'); g('commit', '-qm', 'docs only (#13)');
  sha.docs = g('rev-parse', 'HEAD');
  write('svc/test_api.py', 'def test_x(): pass\n'); g('add', '.'); g('commit', '-qm', 'py (#14)');
  sha.py = g('rev-parse', 'HEAD');
  // A fix whose test imports a name the code before it did not export.
  write('packages/cli/src/a.ts', 'export const a = 2;\nexport const RETRY_LIMIT = 3;\nexport function backoffMs(n: number) { return n * 100; }\n');
  write('packages/cli/src/__tests__/retry.test.ts', "import { a, RETRY_LIMIT, backoffMs } from '../a.js';\n");
  g('add', '.'); g('commit', '-qm', 'retry (#15)');
  sha.iface = g('rev-parse', 'HEAD');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const cand = (over: Partial<ReplayCandidate>): ReplayCandidate => ({ shortId: 'ISS-1', title: 'Retry on 502', description: 'Deliveries drop on a 502.', prNumber: 12, mergeCommitSha: sha.fix, ...over });

describe('replay tasks from closed issues', () => {
  it('recognises test files, not fixtures or snapshots', () => {
    expect(isTestFile('packages/cli/src/__tests__/a.test.ts')).toBe(true);
    expect(isTestFile('apps/web/src/x.spec.tsx')).toBe(true);
    expect(isTestFile('svc/test_api.py')).toBe(true);
    expect(isTestFile('packages/cli/src/__tests__/fixtures/x.test.ts')).toBe(false);
    expect(isTestFile('packages/cli/src/a.ts')).toBe(false);
    expect(isTestFile('docs/testing.md')).toBe(false);
  });

  it('the merge commit, the issue as the prompt, the tests it added or changed, run with vitest in their package', () => {
    const r = replayTaskFor(cand({}), gitReader(repo));
    expect(r).toEqual({ task: {
      id: 'issue-ISS-1', commit: sha.fix, prompt: 'Retry on 502\n\nDeliveries drop on a 502.',
      tests: ['packages/cli/src/__tests__/a.test.ts'], testDir: 'packages/cli',
      testCommand: 'pnpm exec vitest run {tests}', setupCommand: 'pnpm install --frozen-lockfile --prefer-offline >/dev/null',
    } });
  });

  it('skips a fix with no tests, a commit not in the clone, and a PR with no merge commit — saying why', () => {
    const git = gitReader(repo);
    expect(replayTaskFor(cand({ mergeCommitSha: sha.docs, prNumber: 13 }), git)).toEqual({ skip: 'PR #13 added or changed no tests, so nothing grades a replay' });
    expect((replayTaskFor(cand({ mergeCommitSha: 'f'.repeat(40) }), git) as any).skip).toContain('not in this clone');
    expect((replayTaskFor(cand({ mergeCommitSha: '' }), git) as any).skip).toContain('no merge commit');
  });

  it('python tests run with pytest; --test-command overrides the guess', () => {
    const git = gitReader(repo);
    expect(replayTaskFor(cand({ mergeCommitSha: sha.py }), git)).toMatchObject({ task: { tests: ['svc/test_api.py'], testCommand: 'python -m pytest {tests}' } });
    expect(replayTaskFor(cand({}), git, { testCommand: 'make test', setupCommand: 'make deps' })).toMatchObject({ task: { testCommand: 'make test', setupCommand: 'make deps' } });
  });

  it('names the interface the tests need that the code before the fix lacks — never names what already exists', () => {
    const r = replayTaskFor(cand({ mergeCommitSha: sha.iface, prNumber: 15 }), gitReader(repo)) as any;
    expect(r.task.prompt).toBe('Retry on 502\n\nDeliveries drop on a 502.\n\nThe tests expect `RETRY_LIMIT`, `backoffMs` exported from packages/cli/src/a.ts.');
    // The validator's check now passes on it.
    expect(r.task.prompt).not.toContain('`a`');
  });

  it('a title-only issue is its own prompt', () => {
    expect(taskPrompt({ title: '  Fix it ', description: null })).toBe('Fix it');
  });

  it('writes the task file for the issues it could use and names the next commands', async () => {
    const logs: string[] = [];
    const out = path.join(root, 'tasks.json');
    const file = await replayTasksCommand({ out }, {
      cwd: repo, log: (l) => logs.push(l), error: (l) => logs.push(l),
      repoId: async () => 'repo-1',
      candidates: async () => [cand({}), cand({ shortId: 'ISS-2', mergeCommitSha: sha.docs, prNumber: 13 })],
    });
    expect(file!.tasks.map((t) => t.id)).toEqual(['issue-ISS-1']);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8')).tasks).toHaveLength(1);
    expect(logs.join('\n')).toContain('ISS-2  skipped: PR #13 added or changed no tests');
    expect(logs.join('\n')).toContain('--validate');
  });

  it('says so when the repo is not on Origin', async () => {
    const errs: string[] = [];
    expect(await replayTasksCommand({}, { cwd: repo, log: () => {}, error: (l) => errs.push(l), repoId: async () => null, candidates: async () => [] })).toBeNull();
    expect(errs.join()).toContain('not on Origin');
    process.exitCode = undefined;
  });
});
