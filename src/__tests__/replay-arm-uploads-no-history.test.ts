// A benchmark replay arm's clone never uploads the history it was cloned with.
//
// `origin benchmark replay` runs each arm in a fresh clone of the replayed repo
// under ~/.origin/bakeoff-repos/replay/runs/<runId>/arms/<arm>, with no remote.
// Session start spawned `origin hooks git-history-sync` for it; the sync
// advertised the clone's ~500 SHAs, the server (a new repo per arm) reported
// all of them unknown, and the backfill uploaded every one with its patch.
// Prod, 2026-09-29 → 10-02: ~68k duplicate Commit rows.
//
// The first half pins the two guards in-process; the second runs the built
// binary's history sync against a fake API.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      if (args[1]?.includes?.('git-history-sync')) {
        spawnSpy(...args);
        return { unref() { /* detached child stand-in */ } } as any;
      }
      return (actual.spawn as any)(...args);
    },
  };
});

import { isBenchmarkClonePath } from '../benchmark-clone.js';
import { api } from '../api.js';
import { maybeSpawnHistorySync } from '../commands/hooks/session-start.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');

let tmp: string;
let home: string;
let gitEnv: NodeJS.ProcessEnv;

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim();
}

/** A repo with `n` commits at `dir`. */
function repoWithHistory(dir: string, n: number): string[] {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, 'f.txt'), `line ${i}\n`);
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', `real past commit ${i}`]);
  }
  return g(dir, ['rev-list', 'HEAD']).split('\n');
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-replay-arm-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.origin', 'last-update-check.json'), JSON.stringify({ latest: '0.0.1', checkedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, '.gitconfig'), '');
  gitEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    LC_ALL: 'C',
  };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NOTES_REF', 'ORIGIN_CONTEXT_VARIANT']) delete gitEnv[k];
  spawnSpy.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const armDir = () => path.join(home, '.origin', 'bakeoff-repos', 'replay', 'runs', '2026-10-02-abc123', 'arms', 'task-a-baseline-1');

describe('isBenchmarkClonePath', () => {
  it('matches a replay arm clone, POSIX or Windows', () => {
    expect(isBenchmarkClonePath('/Users/x/.origin/bakeoff-repos/replay/runs/r/arms/t-baseline-1')).toBe(true);
    expect(isBenchmarkClonePath('C:\\Users\\x\\.origin\\bakeoff-repos\\replay\\runs\\r\\arms\\t-none-2')).toBe(true);
  });

  it('does not match a real repo, nor an agent bake-off worktree of one', () => {
    expect(isBenchmarkClonePath('/Users/x/code/origin')).toBe(false);
    expect(isBenchmarkClonePath('/Users/x/code/origin-bakeoff-ab12-codex')).toBe(false);
    expect(isBenchmarkClonePath(undefined)).toBe(false);
  });
});

describe('the guards', () => {
  it('api.ingestCommits sends nothing for a clone and reports nothing unknown', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res: any = await api.ingestCommits({
      repoPath: armDir(), recentShas: ['a'.repeat(40), 'b'.repeat(40)],
      commits: [{ sha: 'a'.repeat(40), message: 'x', diff: '+1' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.unknownShas).toEqual([]);
  });

  it('session start spawns no history sync for a clone; an ordinary repo still gets one', () => {
    const arm = path.join(tmp, '.origin', 'bakeoff-repos', 'replay', 'runs', 'r', 'arms', 'task-a-none-1');
    repoWithHistory(arm, 3);
    maybeSpawnHistorySync(arm, arm);
    expect(spawnSpy).not.toHaveBeenCalled();

    const real = path.join(tmp, 'code', 'side-project');
    repoWithHistory(real, 3);
    maybeSpawnHistorySync(real, real);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('built binary: `origin hooks git-history-sync`', () => {
  /** Run the history sync for `repo` against a fake API; returns the ingest bodies it received. */
  async function syncAgainstFakeApi(repo: string): Promise<any[]> {
    const ingests: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/api/mcp/commits/ingest') {
          const body = JSON.parse(raw || '{}');
          ingests.push(body);
          const known = new Set((body.commits || []).map((c: any) => c.sha));
          // A brand-new repo on the server: everything advertised is unknown.
          res.end(JSON.stringify({ ingested: body.commits?.length || 0, unknownShas: (body.recentShas || []).filter((s: string) => !known.has(s)) }));
          return;
        }
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}`, apiKey: 'ok_test_key', orgId: 'org-1', userId: 'user-1',
    }));
    try {
      // Async spawn (the real one — the module mock above stands in for the
      // detached child); a sync one would freeze this process's fake API.
      const { spawn } = await vi.importActual<typeof import('child_process')>('child_process');
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [distPath, 'hooks', 'git-history-sync'], {
          cwd: repo, stdio: 'ignore',
          env: { ...gitEnv, ORIGIN_HISTORY_REPO: repo, ORIGIN_HISTORY_CWD: repo },
        });
        child.on('close', resolve);
      });
      expect(code).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return ingests;
  }

  it('a replay arm clone uploads nothing', async () => {
    const arm = armDir();
    repoWithHistory(arm, 5);
    expect(await syncAgainstFakeApi(arm)).toEqual([]);
  }, 60_000);

  it('control: an ordinary local repo advertises and backfills its history', async () => {
    const real = path.join(tmp, 'code', 'side-project');
    const shas = repoWithHistory(real, 5);
    const ingests = await syncAgainstFakeApi(real);
    const uploaded = new Set(ingests.flatMap((b) => (b.commits || []).map((c: any) => c.sha)));
    expect(ingests.length).toBeGreaterThanOrEqual(2);
    expect([...uploaded].sort()).toEqual([...shas].sort());
  }, 60_000);
});
