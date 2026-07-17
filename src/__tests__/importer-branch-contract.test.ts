// The platform importer's contract with the branch this CLI publishes.
//
// apps/api/src/services/origin-sessions-import.ts does NOT clone. It walks the
// branch over the GitHub/GitLab REST API and picks sessions out of the tree with
// a literal path regex, then parses the blobs into its own copy of the
// SessionMetadata / SessionChanges interfaces. Nothing type-checks the CLI's
// writer against the API's reader — they are separate packages with duplicated
// interfaces — so drift here is silent and only shows up as "connected the repo,
// imported nothing".
//
// PR #692 made this worth pinning: it changed WHERE sessions are written (per-
// session refs) and added a README at the branch root, so the branch is now
// assembled by publishSessionToBranch rather than written directly. This asserts
// the assembled result still matches what the importer greps for.
//
// Kept in the CLI package deliberately: the CLI is the producer, and it's the
// side that moves. The duplication of the regex/fields below is the point — it
// is the contract, restated where it can fail loudly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

// Verbatim from origin-sessions-import.ts — the filter that decides what the
// importer even sees.
const IMPORTER_METADATA_RE = /^sessions\/[^/]+\/metadata\.json$/;
const IMPORTER_BRANCH = 'origin-sessions';

/** The tree the importer walks: `git/trees/origin-sessions?recursive=1`. */
function recursiveTree(repo: string): Array<{ path: string; type: 'blob' | 'tree' }> {
  const raw = git(repo, 'ls-tree', '-r', '-t', '--format=%(objecttype) %(path)', `refs/heads/${IMPORTER_BRANCH}`);
  return raw.split('\n').filter(Boolean).map((line) => {
    const [type, ...rest] = line.split(' ');
    return { path: rest.join(' '), type: type === 'blob' ? 'blob' : 'tree' };
  });
}

describe('published branch satisfies the platform importer’s contract', () => {
  let repo: string;
  let headSha: string;

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-contract-'));
    git(repo, 'init', '-q', '-b', 'main', '.');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.py'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'c1');
    headSha = git(repo, 'rev-parse', 'HEAD');

    // Produce the branch exactly as production does: refs backend on the hot
    // path, then publish folds onto the branch.
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, publishSessionToBranch } = await import('../local-entrypoint.js');
    for (const id of ['imp-one', 'imp-two']) {
      writeSessionFiles(repo, {
        sessionId: id,
        model: 'claude-opus-4-8',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 5000,
        status: 'ended',
        costUsd: 4.25,
        tokensUsed: 12345,
        inputTokens: 5000,
        outputTokens: 7345,
        toolCalls: 9,
        linesAdded: 42,
        linesRemoved: 7,
        prompts: [{ index: 1, text: `prompt for ${id}`, filesChanged: ['a.py'] }],
        filesChanged: ['a.py'],
        git: { branch: 'main', headBefore: '', headAfter: headSha, commitShas: [headSha] },
        summary: '',
        originUrl: '',
        changes: [{ promptIndex: 1, promptText: `prompt for ${id}`, filesChanged: ['a.py'], diff: '--- a\n+++ b\n' }],
      } as any);
      publishSessionToBranch(repo, id);
    }
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('the importer’s path regex finds every published session', () => {
    const tree = recursiveTree(repo);
    const found = tree
      .filter((e) => e.type === 'blob' && IMPORTER_METADATA_RE.test(e.path))
      .map((e) => e.path)
      .sort();
    expect(found).toEqual([
      'sessions/imp-one/metadata.json',
      'sessions/imp-two/metadata.json',
    ]);
  });

  it('the README added at the branch root does not masquerade as a session', () => {
    // #692 put a README.md at the branch root for humans/agents who clone. If it
    // ever matched the session filter, the importer would try to parse it as
    // metadata and count a bogus skip.
    const tree = recursiveTree(repo);
    expect(tree.some((e) => e.path === 'README.md')).toBe(true);
    expect(IMPORTER_METADATA_RE.test('README.md')).toBe(false);
    const matches = tree.filter((e) => IMPORTER_METADATA_RE.test(e.path)).map((e) => e.path);
    expect(matches).not.toContain('README.md');
  });

  it('metadata.json carries every field the importer reads, in the shape it expects', () => {
    const raw = git(repo, 'show', `refs/heads/${IMPORTER_BRANCH}:sessions/imp-one/metadata.json`);
    const meta = JSON.parse(raw);

    // Bail-out fields: the importer skips the session without these.
    expect(meta.sessionId).toBe('imp-one');
    expect(typeof meta.model).toBe('string');
    // Nested shape — the importer's interface declares tokens/cost/lines as
    // objects. A flattening here would silently zero every imported session.
    expect(typeof meta.tokens.total).toBe('number');
    expect(typeof meta.cost.usd).toBe('number');
    expect(typeof meta.lines.added).toBe('number');
    expect(typeof meta.lines.removed).toBe('number');
    expect(Array.isArray(meta.filesChanged)).toBe(true);
    // Commit linkage — how imported sessions attach to commits.
    expect(meta.git.commitShas).toEqual([headSha]);
    expect(meta.version).toBe(1);
    expect(meta.status).toBe('ended');
  });

  it('changes.json sits where the importer looks and parses to its shape', () => {
    // The importer derives it as `${dir}/changes.json` from the metadata path.
    const tree = recursiveTree(repo);
    const metaEntry = tree.find((e) => e.path === 'sessions/imp-one/metadata.json')!;
    const dir = metaEntry.path.replace(/\/metadata\.json$/, '');
    expect(tree.some((e) => e.path === `${dir}/changes.json`)).toBe(true);

    const changes = JSON.parse(git(repo, 'show', `refs/heads/${IMPORTER_BRANCH}:${dir}/changes.json`));
    expect(changes.version).toBe(2); // importer gates richer hydration on version >= 2
    expect(changes.sessionId).toBe('imp-one');
    expect(changes.changes[0].promptIndex).toBe(1);
    expect(changes.changes[0].promptText).toContain('prompt for imp-one');
  });

  it('publishing a second session does not evict the first from the tree', () => {
    // Each publish folds onto the branch tip; a bad fold would leave the
    // importer seeing only the most recent session.
    const ids = recursiveTree(repo)
      .filter((e) => IMPORTER_METADATA_RE.test(e.path))
      .map((e) => e.path.split('/')[1])
      .sort();
    expect(ids).toEqual(['imp-one', 'imp-two']);
  });
});
