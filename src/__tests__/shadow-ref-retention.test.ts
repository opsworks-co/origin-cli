import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as exec from '../utils/exec.js';
import { cleanShadowRefs } from '../shadow-ref-retention.js';

const PREFIX = 'refs/origin/shadow/';
const old = '2026-01-01T00:00:00.000Z';
const now = Date.parse('2026-03-01T00:00:00.000Z');
let root: string;
let repo: string;
let home: string;
function git(args: string[]) { return exec.git(args, { cwd: repo }).trim(); }
function shadow(tag: string, date = old, author = 'shadow@origin.local') {
  const sha = exec.gitDetailed(['commit-tree', git(['rev-parse', 'HEAD^{tree}']), '-p', 'HEAD', '-m', `origin shadow ${tag} ${date}`], {
    cwd: repo,
    env: { GIT_AUTHOR_NAME: 'Origin', GIT_COMMITTER_NAME: 'Origin', GIT_AUTHOR_EMAIL: author,
      GIT_COMMITTER_EMAIL: author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).stdout.trim();
  git(['update-ref', PREFIX + tag, sha]);
  return sha;
}
function save(dir: string, name: string, value: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}
function clean(apply = false) { return cleanShadowRefs(repo, { originHome: home, now, apply }); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-retention-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'origin');
  fs.mkdirSync(repo);
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'base']);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('shadow ref retention with real Git', () => {
  it('previews by default; apply removes only an old orphan and leaves objects and branches intact', () => {
    const sha = shadow('orphan');
    const head = git(['rev-parse', 'HEAD']);
    shadow('recent', '2026-02-20T00:00:00.000Z');
    git(['update-ref', 'refs/origin/sessions/kept', sha]);
    expect(clean()).toMatchObject({ total: 2, removed: 0, candidates: [{ name: PREFIX + 'orphan', sha }] });
    expect(git(['rev-parse', PREFIX + 'orphan'])).toBe(sha);
    expect(clean(true).removed).toBe(1);
    expect(git(['cat-file', '-t', sha])).toBe('commit');
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['rev-parse', 'refs/origin/sessions/kept'])).toBe(sha);
  });

  it('retains active, ended and unsynced session owners, including secondary-repo suffixes', () => {
    for (const [index, status] of ['RUNNING', 'ENDED', 'QUEUED'].entries()) {
      const id = `abcdef12345${index}-session`;
      const tag = id.slice(0, 12);
      shadow(`start-${tag}`);
      shadow(`prompt-${tag}-wt`);
      shadow(`${tag}-nested-repo`);
      save(path.join(home, 'sessions'), `${index}.json`, { sessionId: id, status });
    }
    expect(clean(true).removed).toBe(0);
  });

  it('protects SHA references in queued uploads and journal boundaries', () => {
    const queued = shadow('queued');
    const journal = shadow('journal');
    save(path.join(home, 'queue'), 'pending.json', { sessionId: 'different', payload: { baseline: queued } });
    save(path.join(home, 'journals'), 'writes.jsonl', { headBefore: journal });
    expect(clean(true).removed).toBe(0);
  });

  it('retains an old shadow whose abbreviated SHA is saved under a different session tag', () => {
    const sha = shadow('old-tag');
    save(path.join(home, 'sessions'), 'saved.json', { sessionId: 'new-tag', promptShadows: [{ sha: sha.slice(0, 10) }] });
    expect(clean(true).removed).toBe(0);
  });

  it('stops on a valid JSON session with an unknown schema', () => {
    shadow('orphan');
    save(path.join(home, 'sessions'), 'unknown.json', {});
    expect(() => clean(true)).toThrow('Missing session identity');
    expect(git(['for-each-ref', '--format=%(refname)', PREFIX])).toBe(PREFIX + 'orphan');
  });

  it('protects common-dir and legacy worktree state even from another worktree', () => {
    const common = path.join(repo, '.git');
    const a = shadow('common');
    const b = shadow('legacy');
    save(common, 'origin-session-a.json', { sessionId: 'a', prePromptSha: a });
    const wt = path.join(root, 'linked');
    git(['worktree', 'add', '-b', 'linked', wt]);
    save(path.join(common, 'worktrees', 'linked'), 'origin-session-b.json', { sessionId: 'b', prePromptSha: b });
    expect(cleanShadowRefs(wt, { originHome: home, now, apply: true }).removed).toBe(0);
  });

  it('retains unfamiliar objects, identities, messages and symbolic refs', () => {
    shadow('foreign', old, 'human@example.com');
    git(['update-ref', PREFIX + 'unknown', 'HEAD']);
    git(['symbolic-ref', PREFIX + 'symbolic', 'refs/heads/main']);
    expect(clean(true).removed).toBe(0);
    expect(git(['symbolic-ref', PREFIX + 'symbolic'])).toBe('refs/heads/main');
  });

  it.each(['broken.json', 'writing.json.tmp.123'])('fails closed on incomplete evidence: %s', name => {
    shadow('orphan');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', name), '{');
    expect(() => clean(true)).toThrow();
    expect(git(['for-each-ref', '--format=%(refname)', PREFIX])).toBe(PREFIX + 'orphan');
  });

  it('aborts if evidence changes after the initial scan', () => {
    const sha = shadow('orphan');
    const original = exec.git;
    vi.spyOn(exec, 'git').mockImplementation((args, opts) => {
      const result = original(args, opts);
      if (args[0] === 'for-each-ref') save(path.join(home, 'sessions'), 'new.json', { sessionId: 'resumed', prePromptSha: sha });
      return result;
    });
    expect(() => clean(true)).toThrow('Capture evidence changed');
    expect(git(['rev-parse', PREFIX + 'orphan'])).toBe(sha);
  });

  it('a concurrent ref refresh aborts the whole transaction without deleting other candidates', () => {
    const a = shadow('a');
    shadow('b');
    const original = exec.gitDetailed;
    vi.spyOn(exec, 'gitDetailed').mockImplementation((args, opts) => {
      if (args[0] === 'update-ref') git(['update-ref', PREFIX + 'b', 'HEAD']);
      return original(args, opts);
    });
    expect(() => clean(true)).toThrow('Ref transaction aborted');
    expect(git(['rev-parse', PREFIX + 'a'])).toBe(a);
    expect(git(['rev-parse', PREFIX + 'b'])).toBe(git(['rev-parse', 'HEAD']));
  });
});
