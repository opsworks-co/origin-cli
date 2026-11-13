// END-TO-END: with NO git hooks installed, a turn that rebases the session's
// own earlier commits onto a moved main is not billed those commits' lines.
//
// Prod f0bf6c29 (2026-10-15, Ihor, no trailers/notes = hooks off). Turns 4, 6
// and 10 each committed (v1, v2, v3); turn 11 ran "rebase onto main, resolve
// the conflicts". Turn 11's row read 14 files +634/-189 — exactly
// new-main..v3', the whole branch — and claimed v1', v2', v3' as its own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { gitAsync } from './helpers/git-async.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

let server: http.Server;
let apiUrl = '';
const sentRows: Array<{ sessionId: string; promptIndex: number; filesChanged?: string[]; diff?: string }> = [];
/** Every PATCH body's commit record, per session: what the server is told replaced what. */
const sentCommitRecords: Array<{ sessionId: string; rewrittenCommits?: Array<{ from: string; to: string }>; commitShas?: string[] }> = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        try {
          const body = JSON.parse(raw || '{}');
          const sid = /\/api\/mcp\/session\/([^/?]+)/.exec(u)?.[1] || '';
          if (Array.isArray(body?.promptChanges)) sentRows.push(...body.promptChanges.map((r: any) => ({ ...r, sessionId: sid })));
          const gc = body?.gitCapture;
          if (sid && gc && (gc.rewrittenCommits || gc.commitShas)) {
            sentCommitRecords.push({ sessionId: sid, rewrittenCommits: gc.rewrittenCommits, commitShas: gc.commitShas });
          }
        } catch { /* not JSON */ }
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          let agentSession = '';
          try { agentSession = JSON.parse(raw).agentSessionId || ''; } catch { /* ignore */ }
          res.end(JSON.stringify({ sessionId: `api-${agentSession || 'x'}`, verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    holdIdleConnections(server);
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const diffLines = (diff: string | undefined, sign: '+' | '-') =>
  (diff || '').split('\n').filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1));
const REPLAYED = ['turn 0 wrote this', 'turn 1 wrote this', 'upstream wrote this', 'route = 2'];

/** The row adds none of the replayed lines; it names the replayed file only as the conflict it resolved. */
function expectNoReplayedCode(row: { filesChanged?: string[]; diff?: string } | undefined, label: string, conflicted: boolean) {
  const added = diffLines(row?.diff, '+');
  for (const line of REPLAYED) expect(added.filter((l) => l.includes(line)), `${label}: added lines`).toEqual([]);
  // without a conflict the replayed code is not even context of the row
  if (!conflicted) expect(row?.diff || '', label).not.toContain('turn 0 wrote this');
  expect(row?.filesChanged || [], `${label}: files`).not.toContain('src/other.ts');
  expect(row?.filesChanged || [], `${label}: files`).not.toContain('src/route.ts');
  if (!(row?.filesChanged || []).includes('src/scope.ts')) return;
  expect(conflicted, `${label} names the replayed file without a conflict to resolve`).toBe(true);
  expect(diffLines(row?.diff, '-').some((l) => l.startsWith('<<<<<<<')), `${label}: the resolution removed the markers`).toBe(true);
}

const numbered = (n: number, edit: (i: number) => string | null = () => null) =>
  Array.from({ length: n }, (_, i) => edit(i + 1) ?? `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
const ORIGINAL = numbered(40);
/** Turn 0's edit: a new line after line 3. */
const TURN_0 = numbered(40, (i) => (i === 3 ? 'export const line3 = 3;\nexport const turn0 = "turn 0 wrote this";' : null));

/** One session in one repo: turn 0 commits, turn 1 rebases it onto `upstream`. */
function scenario(sessionId: string, upstream: string, resolved: string | null) {
  let repo = '';
  let hooksDir = '';
  let transcript = '';
  const lines: string[] = [];

  const git = (args: string[], opts: { allowFail?: boolean } = {}): string => {
    try {
      return execFileSync('git', args, {
        cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
      }).trim();
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  };

  /** git through an EMPTY hooks dir: no Origin git hook fires, as on a machine without them installed. */
  const hookedGit = (args: string[], opts: { allowFail?: boolean } = {}): Promise<string> =>
    gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' }, allowFail: opts.allowFail });

  function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null }> {
    const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
      cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => { /* context injection — not asserted */ });
    child.stderr.on('data', () => { /* not asserted */ });
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
    return new Promise((resolve) => child.on('close', (code) => resolve({ code })));
  }

  function append(entry: Record<string, unknown>) {
    lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
  }
  const say = (text: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  function toolUse(id: string, name: string, input: Record<string, unknown>, output = 'ok') {
    append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
  }

  async function agentWrites(id: string, file: string, content: string) {
    const abs = path.join(repo, file);
    const input = { file_path: abs, content };
    expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id })).code).toBe(0);
    fs.writeFileSync(abs, content);
    toolUse(id, 'Write', input);
    expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } })).code).toBe(0);
  }

  /** `body` may return the command's output — git's `[branch sha] subject` is what Stop's transcript proof reads. */
  async function agentRuns(id: string, command: string, body: () => void | string | Promise<void | string>) {
    const bash = { tool_name: 'Bash', tool_input: { command }, tool_use_id: id };
    expect((await run('pre-tool-use', bash)).code).toBe(0);
    const stdout = (await body()) || '';
    await sleep(1500); // the journal watcher sees the rewrites
    toolUse(id, 'Bash', bash.tool_input, stdout || 'ok');
    expect((await run('post-tool-use', { ...bash, tool_response: { stdout, stderr: '' } })).code).toBe(0);
  }

  function sessionState(): any {
    const dir = git(['rev-parse', '--git-common-dir']);
    const abs = path.isAbsolute(dir) ? dir : path.join(repo, dir);
    const file = fs.readdirSync(abs).find((f) => f.startsWith('origin-session') && f.endsWith('.json'));
    expect(file, 'no session state file').toBeTruthy();
    return JSON.parse(fs.readFileSync(path.join(abs, file!), 'utf-8'));
  }

  async function killJournalWatcher(): Promise<void> {
    const dir = path.join(os.homedir(), '.origin', 'journals');
    try {
      const lock = fs.readdirSync(dir).find((f) => f.startsWith(sessionId.slice(0, 12)) && f.endsWith('.lock'));
      const pid = lock ? Number(fs.readFileSync(path.join(dir, lock), 'utf-8').trim()) : 0;
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* no journal */ }
  }

  return {
    async setUp(tmp: string) {
      repo = path.join(tmp, sessionId, 'repo');
      hooksDir = path.join(tmp, sessionId, 'hooks');
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(hooksDir);
      transcript = path.join(tmp, sessionId, `${sessionId}.jsonl`);
      fs.writeFileSync(transcript, '');
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.name', 'E2E']);
      git(['config', 'user.email', 'e2e@example.com']);
      git(['config', 'commit.gpgsign', 'false']);
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src/scope.ts'), ORIGINAL);
      fs.writeFileSync(path.join(repo, 'src/route.ts'), 'export const route = 1;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
      // Another PR lands on main while the session works: same file.
      git(['checkout', '-q', '-b', 'upstream']);
      fs.writeFileSync(path.join(repo, 'src/scope.ts'), upstream);
      git(['commit', '-q', '-am', 'fix: upstream edits scope.ts too']);
      git(['checkout', '-q', '-b', 'feature', 'main']);
    },

    async play() {
      expect((await run('session-start', { source: 'startup' })).code).toBe(0);

      // Turn 0: writes two files and commits them (no hooks fire).
      expect((await run('user-prompt-submit', { prompt: 'fix the scope' })).code).toBe(0);
      say('fix the scope');
      await agentWrites('tu-1', 'src/scope.ts', TURN_0);
      await agentWrites('tu-2', 'src/route.ts', 'export const route = 2;\n');
      await agentRuns('tu-3', 'git add -A && git commit -m fix', async () => {
        git(['add', '-A']);
        return hookedGit(['commit', '-m', 'fix: the scope']);
      });
      const original0 = git(['rev-parse', 'HEAD']);
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      // Turn 1: a second commit on another file.
      expect((await run('user-prompt-submit', { prompt: 'add the other' })).code).toBe(0);
      say('add the other');
      await agentWrites('tu-1b', 'src/other.ts', 'export const other = "turn 1 wrote this";\n');
      await agentRuns('tu-3b', 'git add -A && git commit -m other', async () => {
        git(['add', '-A']);
        return hookedGit(['commit', '-m', 'feat: other']);
      });
      const original1 = git(['rev-parse', 'HEAD']);
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      // Turn 2: starts clean, rebases both commits onto upstream.
      expect((await run('user-prompt-submit', { prompt: 'rebase on main' })).code).toBe(0);
      say('rebase on main');
      await agentRuns('tu-4', 'git rebase upstream', async () => {
        await hookedGit(['rebase', '-q', 'upstream'], { allowFail: resolved !== null });
      });
      if (resolved !== null) {
        expect(fs.readFileSync(path.join(repo, 'src/scope.ts'), 'utf-8')).toContain('<<<<<<<');
        await agentWrites('tu-5', 'src/scope.ts', resolved);
        await agentRuns('tu-6', 'git add src/scope.ts && git rebase --continue', async () => {
          git(['add', 'src/scope.ts']);
          await hookedGit(['rebase', '--continue']);
        });
      }
      expect(git(['status', '--porcelain'])).toBe('');
      const copy1 = git(['rev-parse', 'HEAD']);
      const copy0 = git(['rev-parse', 'HEAD~1']);
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);
      const atItsStop = (sessionState().completedPromptMappings || []).find((r: any) => r.promptIndex === 2);

      // Turn 3 only talks; its Stop re-derives every row.
      expect((await run('user-prompt-submit', { prompt: 'verify it' })).code).toBe(0);
      say('verify it');
      append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'verified' }] } });
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      const state = sessionState();
      const rows = state.completedPromptMappings || [];
      return {
        shas: { original0, original1, copy0, copy1 },
        rewrittenCommits: (state.rewrittenCommits || []) as Array<{ from: string; to: string }>,
        sessionCommitShas: (state.sessionCommitShas || []) as string[],
        sent: sentCommitRecords.filter((r) => r.sessionId === `api-${sessionId}`),
        turn0: rows.find((r: any) => r.promptIndex === 0),
        turn1: rows.find((r: any) => r.promptIndex === 1),
        turn2: rows.find((r: any) => r.promptIndex === 2),
        atItsStop,
        sent2: sentRows.filter((r) => r.sessionId === `api-${sessionId}` && r.promptIndex === 2),
      };
    },

    killJournalWatcher,
  };
}

describe.skipIf(!haveDist)('hooks off: a rebase that replays the session\'s own commits', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-rebase-nohooks-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const cases = [
    {
      name: 'upstream edited another part of the file',
      sessionId: 'e2e-claude-rebase-nohooks-far-1',
      upstream: numbered(40, (i) => (i === 35 ? 'export const line35 = "upstream wrote this";' : null)),
      resolved: null,
    },
    {
      name: 'the replay conflicted and the turn kept both sides',
      sessionId: 'e2e-claude-rebase-nohooks-conflict-1',
      upstream: numbered(40, (i) => (i === 3 ? 'export const line3 = 3;\nexport const upstream = "upstream wrote this";' : null)),
      resolved: numbered(40, (i) => (i === 3
        ? 'export const line3 = 3;\nexport const upstream = "upstream wrote this";\nexport const turn0 = "turn 0 wrote this";'
        : null)),
    },
  ];

  for (const c of cases) {
    it(`does not bill the rebasing turn the replayed code when ${c.name}`, async () => {
      const s = scenario(c.sessionId, c.upstream, c.resolved);
      try {
        await s.setUp(tmp);
        const { turn0, turn1, turn2, atItsStop, sent2, shas, rewrittenCommits, sessionCommitShas, sent } = await s.play();
        // The server is told which commit replaced which — git's post-rewrite
        // never ran, so only the reflog can say. Without the pairs the server
        // keeps both copies (prod f0bf6c29: v1, v2, v3 listed twice, turn
        // pills pointing at the dead originals).
        const pairs = rewrittenCommits.map((r) => `${r.from.slice(0, 12)}→${r.to.slice(0, 12)}`);
        expect(pairs, 'state names the rebase pairs').toEqual(expect.arrayContaining([
          `${shas.original0.slice(0, 12)}→${shas.copy0.slice(0, 12)}`,
          `${shas.original1.slice(0, 12)}→${shas.copy1.slice(0, 12)}`,
        ]));
        const short = (list: string[]) => list.map((x) => x.slice(0, 12));
        expect(short(sessionCommitShas), 'the dead originals leave the session').not.toEqual(expect.arrayContaining([shas.original0.slice(0, 12)]));
        expect(short(sessionCommitShas)).not.toEqual(expect.arrayContaining([shas.original1.slice(0, 12)]));
        const lastSent = [...sent].reverse().find((r) => r.rewrittenCommits);
        expect((lastSent?.rewrittenCommits || []).map((r) => `${r.from.slice(0, 12)}→${r.to.slice(0, 12)}`), 'the server is told').toEqual(expect.arrayContaining(pairs));
        // …and its commit list names the copies, not the dead originals.
        const lastList = short([...sent].reverse().find((r) => r.commitShas)?.commitShas || []);
        expect(lastList).toEqual(expect.arrayContaining([shas.copy0.slice(0, 12), shas.copy1.slice(0, 12)]));
        expect(lastList).not.toEqual(expect.arrayContaining([shas.original0.slice(0, 12)]));
        const conflicted = c.resolved !== null;
        expectNoReplayedCode(atItsStop, 'at its own Stop', conflicted);
        expect(turn0?.filesChanged, 'turn 0 keeps its own files').toEqual(expect.arrayContaining(['src/scope.ts', 'src/route.ts']));
        expect(turn1?.filesChanged, 'turn 1 keeps its own file').toEqual(expect.arrayContaining(['src/other.ts']));
        expectNoReplayedCode(turn2, 'turn 2 after the later Stop', conflicted);
        for (const r of sent2) expectNoReplayedCode(r, 'a row sent for turn 2', conflicted);
      } finally {
        await s.killJournalWatcher();
      }
    }, 600_000 * WINDOWS_SLOWDOWN);
  }
});
