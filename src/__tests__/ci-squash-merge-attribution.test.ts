// OR-11/A5: a hosted squash merge carries attribution only through an
// explicit source range and target.
//
// A forge's "Squash and merge" runs no Origin hook and states no old→new pairs.
// After it, HEAD of the base branch IS the squash commit, so the old
// `origin ci squash-merge <base>` read `<base>..HEAD` — which holds no original
// commit — and wrote an empty or foreign aggregate that summed session totals
// per commit. The command now takes the original commits and the squash commit
// by name and writes one commit-level record with every proven contribution.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { readRecord, validateFull } from '../attribution-record.js';
import { generateGitHubActionsWorkflow, squashMergeAttribution } from '../ci-integration.js';
import { REWRITE_NOTE_KEY, REWRITE_NOTE_SCHEMA } from '../history-rewrite.js';
import { NOTE_LOCK_NAME, processStartToken } from '../note-write-lock.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const isWindows = process.platform === 'win32';
const REF = (id: string) => `https://origin.example.com/sessions/${id}`;

let tmp = '';
let env: NodeJS.ProcessEnv;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function sessionNote(commit: string, sessionId: string, agent: string, model: string) {
  const record = {
    schema_version: '1.0',
    revision: { vcs: 'git', id: commit, diff_stats: { lines_added: 1, lines_removed: 0 } },
    attribution_level: 'line',
    recorded_at: '2026-09-01T00:00:00Z',
    producer: { name: 'origin-cli', version: '0.1.0' },
    contributions: [{
      evidence: 'session_capture', agent: { id: agent }, model: { id: model },
      session: {
        id: sessionId, reference_uri: REF(sessionId), prompt_count: 4,
        iterations: [{ index: 2, reference_uri: `${REF(sessionId)}?prompt=2` }],
        usage: { cost: { amount: '1.25', currency: 'USD', basis: 'estimated' } },
      },
      files: [{ path: 'f.txt', ranges: [{ start_line: 1, end_line: 1, iteration_index: 2 }] }],
    }],
  };
  expect(validateFull(record).ok).toBe(true);
  return {
    origin: {
      version: 1, sessionId, agent, model, promptCount: 4, promptSummary: `SECRET-${sessionId}`,
      tokensUsed: 900, costUsd: 1.25, durationMs: 1000, linesAdded: 1, linesRemoved: 0, originUrl: REF(sessionId),
    },
    attribution_record: record,
  };
}

function ci(cwd: string, ...args: string[]) {
  return ciWith({}, cwd, ...args);
}
function ciWith(extra: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, 'ci', 'squash-merge', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf-8', timeout: 60_000 });
}
const noteOf = (cwd: string, sha: string): string | null => { try { return run(cwd, 'notes', '--ref=origin', 'show', sha); } catch { return null; } };

describe.skipIf(isWindows || !fs.existsSync(BIN))('forge squash merge → explicit range and target', () => {
  let remote = '';
  let dev = '';
  let forge = '';
  let ciClone = '';
  let head = '';
  let squash = '';
  const feature: string[] = [];

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-ci-squash-'));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORIGIN_') && !k.startsWith('GIT_')) base[k] = v;
    env = {
      ...base, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });

    // The developer: a feature branch with work from two sessions and two agents.
    dev = path.join(tmp, 'dev');
    execFileSync('git', ['clone', '-q', remote, dev], { env, stdio: 'ignore' });
    fs.writeFileSync(path.join(dev, 'base.txt'), 'base\n');
    run(dev, 'add', '.');
    run(dev, 'commit', '-q', '-m', 'base');
    run(dev, 'push', '-q', 'origin', 'main');
    run(dev, 'checkout', '-q', '-b', 'feature');
    const agents: Array<[string, string, string]> = [['sess-claude', 'claude-code', 'claude-opus-4-6'], ['sess-codex', 'codex', 'gpt-5'], ['sess-claude', 'claude-code', 'claude-opus-4-6']];
    agents.forEach(([s, a, m], i) => {
      fs.writeFileSync(path.join(dev, `f${i}.txt`), `${i}\n`);
      run(dev, 'add', '.');
      run(dev, 'commit', '-q', '-m', `feature ${i}`);
      const sha = run(dev, 'rev-parse', 'HEAD');
      feature.push(sha);
      run(dev, 'notes', '--ref=origin', 'add', '-m', JSON.stringify(sessionNote(sha, s, a, m)), sha);
    });
    fs.writeFileSync(path.join(dev, 'human.txt'), 'no agent\n');
    run(dev, 'add', '.');
    run(dev, 'commit', '-q', '-m', 'human commit, no note');
    head = run(dev, 'rev-parse', 'HEAD');
    run(dev, 'push', '-q', 'origin', 'feature', `feature:refs/pull/7/head`, 'refs/notes/origin');

    // The forge squashes the PR onto main where no Origin hook runs, then the
    // branch is deleted; only the pull ref keeps the originals reachable.
    forge = path.join(tmp, 'forge');
    execFileSync('git', ['clone', '-q', remote, forge], { env, stdio: 'ignore' });
    run(forge, 'fetch', '-q', 'origin', 'feature');
    run(forge, 'merge', '--squash', 'origin/feature');
    run(forge, 'commit', '-q', '-m', 'Feature (#7)');
    squash = run(forge, 'rev-parse', 'HEAD');
    run(forge, 'push', '-q', 'origin', 'main');
    run(forge, 'push', '-q', 'origin', '--delete', 'feature');

    // CI: a fresh checkout of main, then the pull ref and the notes, as the generated workflow fetches them.
    ciClone = path.join(tmp, 'ci');
    execFileSync('git', ['clone', '-q', remote, ciClone], { env, stdio: 'ignore' });
    run(ciClone, 'fetch', '-q', '--no-tags', 'origin', '+refs/pull/7/head:refs/origin-ci/pr-head');
    run(ciClone, 'fetch', '-q', '--no-tags', 'origin', '+refs/notes/origin:refs/notes/origin');
  }, 120_000);
  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('the originals are not ancestors of main, and the old <base>..HEAD reading finds none of them', () => {
    expect(() => run(ciClone, 'merge-base', '--is-ancestor', head, 'origin/main')).toThrow();
    expect(run(ciClone, 'rev-list', 'origin/main..HEAD')).toBe('');
  });

  it('the base-branch-only form is refused and writes nothing', () => {
    const r = ci(ciClone, 'main');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--range <base-before-merge>..<source-tip> --target <squash-sha>');
    expect(noteOf(ciClone, squash)).toBeNull();
  });

  it('a range whose source commits were never fetched is refused and writes nothing', () => {
    const fresh = path.join(tmp, 'no-sources');
    // --no-local: a path clone would hard-link every object, reachable or not.
    execFileSync('git', ['clone', '-q', '--no-local', remote, fresh], { env, stdio: 'ignore' });
    run(fresh, 'fetch', '-q', '--no-tags', 'origin', '+refs/notes/origin:refs/notes/origin');
    const r = ci(fresh, '--range', `${squash}^..${head}`, '--target', squash);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cannot resolve');
    expect(noteOf(fresh, squash)).toBeNull();
  });

  it('explicit range + target: one commit-level record naming the squash, both sessions, nothing summed', () => {
    const r = ci(ciClone, '--range', `${squash}^..${head}`, '--target', squash);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Attribution note written');
    const n = JSON.parse(noteOf(ciClone, squash)!);
    const rec = n.attribution_record;
    expect(readRecord(rec).status).toBe('exact');
    expect(rec.revision).toEqual({ vcs: 'git', id: squash });
    expect(rec.attribution_level).toBe('commit');
    expect(rec.contributions).toEqual([
      { evidence: 'session_capture', agent: { id: 'claude-code' }, model: { id: 'claude-opus-4-6' }, session: { id: 'sess-claude', reference_uri: REF('sess-claude') } },
      { evidence: 'session_capture', agent: { id: 'codex' }, model: { id: 'gpt-5' }, session: { id: 'sess-codex', reference_uri: REF('sess-codex') } },
    ]);
    // Legacy readers still see an AI commit; no double-counted totals, no prompt text.
    // Four commits were squashed — three attributed, one human — and two sessions own no single claim to all of it.
    expect(n.origin).toMatchObject({ version: 1, squashMerge: true, commitsSquashed: 4, sessionIds: ['sess-claude', 'sess-codex'], models: ['claude-opus-4-6', 'gpt-5'] });
    for (const k of ['sessionId', 'agent', 'model']) expect(n.origin).not.toHaveProperty(k);
    expect(JSON.stringify(n)).not.toMatch(/SECRET|total|tokensUsed|costUsd/);
    expect(n[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: squash, sources: [...feature, head].sort(), base: 'none' });
    // The originals keep their own notes.
    for (const sha of feature) expect(JSON.parse(noteOf(ciClone, sha)!).attribution_record.revision.id).toBe(sha);
  });

  it('a second run changes nothing', () => {
    const before = noteOf(ciClone, squash);
    const r = ci(ciClone, '--range', `${squash}^..${head}`, '--target', squash);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('already carries this attribution');
    expect(noteOf(ciClone, squash)).toBe(before);
  });

  it('a fresh consumer reads the published record as exact', () => {
    const pub = spawnSync(process.execPath, [BIN, 'push-metadata'], { cwd: ciClone, env, encoding: 'utf-8', timeout: 60_000 });
    expect(pub.status, pub.stderr + pub.stdout).toBe(0);
    const consumer = path.join(tmp, 'consumer');
    execFileSync('git', ['clone', '-q', remote, consumer], { env, stdio: 'ignore' });
    run(consumer, 'fetch', '-q', 'origin', '+refs/notes/origin:refs/notes/origin');
    const rec = JSON.parse(noteOf(consumer, squash)!).attribution_record;
    expect(readRecord(rec)).toMatchObject({ status: 'exact' });
    expect(rec.contributions.map((c: any) => c.session.id)).toEqual(['sess-claude', 'sess-codex']);
  });

  it('refuses a merge commit, a target inside the range and an empty range', () => {
    const merge = path.join(tmp, 'merge');
    execFileSync('git', ['clone', '-q', remote, merge], { env, stdio: 'ignore' });
    run(merge, 'fetch', '-q', 'origin', '+refs/pull/7/head:refs/pr');
    run(merge, 'merge', '-q', '--no-ff', '-m', 'merge', 'refs/pr');
    const mergeSha = run(merge, 'rev-parse', 'HEAD');
    expect(squashMergeAttribution(merge, { range: `${mergeSha}^..refs/pr`, target: mergeSha }))
      .toMatchObject({ success: false, message: expect.stringContaining('has 2 parents') });
    expect(squashMergeAttribution(merge, { range: `${feature[0]}^..refs/pr`, target: feature[1] }))
      .toMatchObject({ success: false, message: expect.stringContaining('inside the source range') });
    expect(squashMergeAttribution(merge, { range: 'refs/pr..refs/pr', target: `${mergeSha}^1` }))
      .toMatchObject({ success: false, message: expect.stringContaining('holds no commits') });
    expect(squashMergeAttribution(merge, { range: 'main', target: mergeSha }))
      .toMatchObject({ success: false, message: expect.stringContaining('--range must be') });
    expect(noteOf(merge, mergeSha)).toBeNull();
  });

  it('a range with no attributed commit writes nothing', () => {
    run(ciClone, 'checkout', '-q', '-b', 'scratch', squash);
    run(ciClone, 'commit', '-q', '--allow-empty', '-m', 'later');
    const later = run(ciClone, 'rev-parse', 'HEAD');
    run(ciClone, 'checkout', '-q', 'main');
    expect(squashMergeAttribution(ciClone, { range: `${feature[2]}..${head}`, target: later }))
      .toMatchObject({ success: true, outcome: 'skipped', message: expect.stringContaining('nothing was written') });
    expect(noteOf(ciClone, later)).toBeNull();
  });

  // What the generated job runs (--skip-unless-squash) on every kind of merged pull request.
  it('--skip-unless-squash: a merge commit is skipped with exit 0 and no note', () => {
    const m = path.join(tmp, 'mergecommit');
    execFileSync('git', ['clone', '-q', remote, m], { env, stdio: 'ignore' });
    run(m, 'fetch', '-q', '--no-tags', 'origin', '+refs/pull/7/head:refs/pr', '+refs/notes/origin:refs/notes/origin');
    run(m, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'refs/pr');
    const mc = run(m, 'rev-parse', 'HEAD');
    const r = ci(m, '--range', `${mc}^..${head}`, '--target', mc, '--skip-unless-squash');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('merge commit, not a squash');
    expect(noteOf(m, mc)).toBeNull();
  });

  it('--skip-unless-squash: a rebase merge gets no N→1 note on its last commit', () => {
    const rb = path.join(tmp, 'rebasemerge');
    execFileSync('git', ['clone', '-q', remote, rb], { env, stdio: 'ignore' });
    run(rb, 'fetch', '-q', '--no-tags', 'origin', '+refs/pull/7/head:refs/pr', '+refs/notes/origin:refs/notes/origin');
    run(rb, 'checkout', '-q', '-b', 'rebased', 'refs/pr');
    // The forge's "Rebase and merge": every commit copied onto the base, author and message kept.
    execFileSync('git', ['rebase', '-q', '--force-rebase', 'main~1'], { cwd: rb, env: { ...env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' }, stdio: 'ignore' });
    const last = run(rb, 'rev-parse', 'HEAD');
    expect(last).not.toBe(head);
    const r = ci(rb, '--range', `${last}^..${head}`, '--target', last, '--skip-unless-squash');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('rebased copy');
    expect(noteOf(rb, last)).toBeNull();
  });

  it('--skip-unless-squash still carries a real squash', () => {
    const sq = path.join(tmp, 'squash-again');
    execFileSync('git', ['clone', '-q', remote, sq], { env, stdio: 'ignore' });
    run(sq, 'fetch', '-q', '--no-tags', 'origin', '+refs/pull/7/head:refs/pr', '+refs/notes/origin:refs/notes/origin');
    run(sq, 'notes', '--ref=origin', 'remove', '--ignore-missing', squash);
    const r = ci(sq, '--range', `${squash}^..${head}`, '--target', squash, '--skip-unless-squash');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Attribution note written');
    expect(JSON.parse(noteOf(sq, squash)!).attribution_record.contributions).toHaveLength(2);
  });
});

// External review, smaller 2: the opt-in post-merge job must not turn an
// already merged pull request red because attribution could not be carried.
describe.skipIf(isWindows || !fs.existsSync(BIN))('--warn-only: strict by default, lenient for post-merge automation', () => {
  let repo = '';
  let squashSha = '';
  let tip = '';
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-ci-warn-'));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORIGIN_') && !k.startsWith('GIT_')) base[k] = v;
    env = {
      ...base, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    repo = path.join(tmp, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'base');
    run(repo, 'checkout', '-q', '-b', 'feature');
    for (const i of [1, 2]) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`);
      run(repo, 'add', '.');
      run(repo, 'commit', '-q', '-m', `f${i}`);
      const sha = run(repo, 'rev-parse', 'HEAD');
      run(repo, 'notes', '--ref=origin', 'add', '-m', JSON.stringify(sessionNote(sha, `sess-${i}`, 'codex', 'gpt-5')), sha);
    }
    tip = run(repo, 'rev-parse', 'HEAD');
    run(repo, 'checkout', '-q', 'main');
    run(repo, 'merge', '-q', '--squash', 'feature');
    run(repo, 'commit', '-q', '-m', 'Feature (#8)');
    squashSha = run(repo, 'rev-parse', 'HEAD');
  }, 120_000);
  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  const operational: Array<[string, () => string[]]> = [
    ['an unresolvable range (originals never fetched)', () => ['--range', `${squashSha}^..${'0'.repeat(40)}`, '--target', squashSha]],
    ['an empty range', () => ['--range', `${tip}..${tip}`, '--target', squashSha]],
  ];
  for (const [label, args] of operational) {
    it(`${label}: exit 1 without the flag, a warning and exit 0 with it; nothing written either way`, () => {
      const strict = ci(repo, ...args());
      expect(strict.status).toBe(1);
      const lenient = ci(repo, ...args(), '--warn-only');
      expect(lenient.status, lenient.stderr).toBe(0);
      expect(lenient.stderr).toContain('warning: attribution was not carried (--warn-only)');
      expect(noteOf(repo, squashSha)).toBeNull();
    });
  }

  it('a note lock held by a live writer: exit 1 without the flag, exit 0 with it; nothing written', () => {
    const dir = path.join(repo, '.git', NOTE_LOCK_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const owner: Record<string, unknown> = { pid: process.pid, host: os.hostname(), token: 'busy', at: new Date().toISOString(), leaseMs: 120_000 };
    const start = processStartToken(process.pid);
    if (start) owner.start = start;
    fs.writeFileSync(path.join(dir, 'e1'), JSON.stringify(owner));
    try {
      const args = ['--range', `${squashSha}^..${tip}`, '--target', squashSha];
      const strict = ciWith({ ORIGIN_NOTE_LOCK_WAIT_MS: '100' }, repo, ...args);
      expect(strict.status).toBe(1);
      expect(strict.stdout + strict.stderr).toContain('note-lock-unavailable');
      const lenient = ciWith({ ORIGIN_NOTE_LOCK_WAIT_MS: '100' }, repo, ...args, '--warn-only');
      expect(lenient.status, lenient.stderr).toBe(0);
      expect(lenient.stderr).toContain('warning: attribution was not carried');
      expect(noteOf(repo, squashSha)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The lock gone, the same command carries it.
    const ok = ci(repo, '--range', `${squashSha}^..${tip}`, '--target', squashSha, '--warn-only');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Attribution note written');
  });

  it('a wrong invocation is never masked: the positional form and a malformed --range still exit 1', () => {
    expect(ci(repo, 'main', '--warn-only').status).toBe(1);
    const bad = ci(repo, '--range', 'main', '--target', squashSha, '--warn-only');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--range must be');
  });
});

describe('the generated GitHub Actions workflow', () => {
  const yaml = generateGitHubActionsWorkflow();
  it('triggers on closed; the squash job is opt-in and never runs for a closed, unmerged pull request', () => {
    expect(yaml).toContain('types: [opened, synchronize, closed]');
    const cond = yaml.split('\n').find((l) => l.includes('squash-attribution:'))
      ? yaml.slice(yaml.indexOf('squash-attribution:')).split('\n').find((l) => l.trim().startsWith('if:'))!.trim()
      : '';
    expect(cond).toBe("if: github.event.action == 'closed' && github.event.pull_request.merged == true && vars.ORIGIN_SQUASH_MERGE_ONLY == 'true'");
    expect(yaml).toContain("if: github.event.action != 'closed'");
    expect(yaml).toContain('--skip-unless-squash');
  });
  it('the post-merge job passes --warn-only, so a merged pull request never turns red over attribution', () => {
    const job = yaml.slice(yaml.indexOf('squash-attribution:'));
    const step = job.slice(job.indexOf('origin ci squash-merge'), job.indexOf('- name: Publish the notes'));
    expect(step).toContain('--skip-unless-squash');
    expect(step).toContain('--warn-only');
    expect(job).toContain('origin push-metadata');
  });
  it('hands the command the SHAs the event states, after fetching the originals and the notes', () => {
    expect(yaml).toContain('+refs/pull/${{ github.event.pull_request.number }}/head:refs/origin-ci/pr-head');
    expect(yaml).toContain('+refs/notes/origin:refs/notes/origin');
    expect(yaml).toContain('--range "${{ github.event.pull_request.merge_commit_sha }}^..${{ github.event.pull_request.head.sha }}"');
    expect(yaml).toContain('--target "${{ github.event.pull_request.merge_commit_sha }}"');
    expect(yaml).toContain('origin push-metadata');
    expect(yaml).not.toMatch(/squash-merge \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
  });
});
