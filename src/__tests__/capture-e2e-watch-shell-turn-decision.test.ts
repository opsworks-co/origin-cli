// END-TO-END, transcript watcher: the BUILT binary's `transcript-watch --once`,
// a real repo, a real transcript on disk, a fake API.
//
// Turn 1 writes retry.ts through the shell (a heredoc — no Edit/Write call) and
// states a decision; turn 2, "commit it", commits the file. The commit's memory
// record must carry turn 1's decision: its work is the commit. The hook paths
// prove that from Origin's per-turn diff (withTurnDiffs); the watcher did not,
// so the shell-only turn showed no written lines and its decision was dropped.
//
// Second case: the watcher first sees BOTH turns in one poll (turn 1 finished
// and turn 2 began between polls). Both baselines are then one snapshot and
// turn 1's own window is empty, so its shell write went unrecorded and its
// decision was still dropped.
//
// Requires `dist/`. Runs on Windows too: nothing here needs a POSIX shell —
// the heredoc is only transcript text — and the watcher is the path that
// captures GUI agents on Windows (capture-e2e-windows-gate).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { readAllCommitMemory } from '../memory.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

let server: http.Server;
const hits: Array<{ method: string; url: string; body: any }> = [];
let apiUrl = '';
function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          let raw = Buffer.concat(chunks);
          if (req.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
          hits.push({ method: req.method || '', url: req.url || '', body: raw.length ? JSON.parse(raw.toString('utf-8')) : null });
        } catch { /* not JSON */ }
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-watch-shell-0001', enforcementRules: [] }));
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

const DECISION = 'Retry with exponential backoff capped at 30s — the API rate-limits bursts';
const retry = [
  'export async function withRetry(fn, attempts = 5) {',
  '  for (let attempt = 0; attempt < attempts; attempt++) {',
  '    try { return await fn(); } catch (err) { lastError = err; }',
  '    await sleepFor(Math.min(30_000, 2 ** attempt * 250));',
  '  }',
  '  throw lastError;',
  '}',
].join('\n') + '\n';

let SID = 'e2e0wtch-1111-2222-3333-444455556666';
let repo = '';
let transcript = '';
let lines: string[] = [];
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
function append(o: Record<string, unknown>) {
  lines.push(JSON.stringify({ cwd: repo, sessionId: SID, ...o }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const userSays = (text: string, ts: string) => append({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const ranBash = (command: string, ts: string) => append({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: `b${lines.length}`, name: 'Bash', input: { command } }] } });
const said = (text: string, ts: string) => append({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }] } });

const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();
// Async: the fake API lives in this process, and a sync spawn would freeze it
// while the binary waits on it.
function poll(): Promise<void> {
  const child = spawn(process.execPath, [BIN, 'transcript-watch', '--once', '--quiet'], {
    cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve, reject) => child.on('close', (code) => (
    code === 0 ? resolve() : reject(new Error(`transcript-watch exited ${code}: ${stderr}`)))));
}

// The edits the watcher last sent for one turn.
function sentEdits(promptIndex: number): Array<{ file: string; newContent?: string }> {
  const row = hits
    .filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges))
    .map((h) => h.body.promptChanges.find((p: any) => p.promptIndex === promptIndex))
    .filter((p: any) => p && typeof p.editsJson === 'string')
    .at(-1);
  if (!row) return [];
  try { return JSON.parse(row.editsJson).edits || []; } catch { return []; }
}

function dump(): void {
  try {
    console.log(fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8')
      .split('\n').filter((l) => /transcript-watch|shell|window/.test(l)).join('\n'));
  } catch (e) { console.log('no hooks.log', String(e)); }
  try {
    const dir = path.join(os.homedir(), '.origin', 'transcript-watch');
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (String(f).endsWith('.json')) console.log(`--- ${f}\n` + fs.readFileSync(path.join(dir, f), 'utf-8').slice(0, 3000));
    }
  } catch (e) { console.log('no state', String(e)); }
}

const tmps: string[] = [];
// A fresh repo, transcript and conversation id per case.
function freshRepo(sid: string): void {
  SID = sid;
  lines = [];
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-watch-shell-')));
  tmps.push(tmp);
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const projDir = path.join(os.homedir(), '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  transcript = path.join(projDir, `${SID}.jsonl`);
  git('init', '-q');
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  fs.writeFileSync(path.join(repo, 'README.md'), 'uploader\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
}

describe.skipIf(!haveDist)('transcript watcher keeps a shell-only turn\'s decision on the commit a later turn made', () => {
  beforeAll(async () => {
    await startFakeApi();
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer', memoryUpdate: 'both',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude-code'], orgId: 'org-e2e',
    }));
  }, 60_000);

  afterAll(() => {
    server?.close();
    for (const tmp of tmps) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records the decision of the turn whose shell write was committed', async () => {
    freshRepo('e2e0wtch-1111-2222-3333-444455556666');
    // Turn 1 starts; the watcher snapshots the tree at its start.
    userSays('add retry with backoff to the uploader', iso(120_000));
    said('Adding it.', iso(115_000));
    await poll();
    const shadows = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.origin', 'transcript-watch', 'claude', `${SID}.json`), 'utf-8')).promptShadows;
    expect(shadows(), 'the first poll took no snapshot of turn 1\'s start').toHaveLength(1);

    // Turn 1 writes through the shell and states its decision. Turn 2 starts;
    // the watcher snapshots the tree with turn 1's file in it.
    ranBash(`cat > retry.ts <<'EOF'\n${retry}EOF`, iso(110_000));
    fs.writeFileSync(path.join(repo, 'retry.ts'), retry);
    said(`Added retry.ts.\n[Origin: Decision] ${DECISION}`, iso(100_000));
    userSays('looks good, commit it', iso(60_000));
    await poll();

    // Turn 2 commits.
    ranBash('git add retry.ts && git commit -m "add retry with backoff"', iso(50_000));
    git('add', 'retry.ts');
    git('commit', '-q', '-m', 'add retry with backoff');
    const sha = git('rev-parse', 'HEAD');
    said('Committed.', iso(40_000));
    await poll();

    const record = readAllCommitMemory(repo).find((c) => c.commitSha === sha);
    if (process.env.E2E_DUMP || !record?.decisions?.length) dump();
    expect(record, 'the watcher wrote no record for the commit').toBeDefined();
    expect(record!.decisions).toEqual([DECISION]);
  }, 180_000);

  it('records turn 1\'s shell write and decision when the first poll sees both turns', async () => {
    freshRepo('e2e1wtch-1111-2222-3333-444455556666');
    // Turn 1 writes through the shell and states its decision; a README tweak
    // it never names rides in the same window. Turn 2 starts — all before the
    // watcher's first poll, so both turns get one snapshot.
    userSays('add retry with backoff to the uploader', iso(120_000));
    ranBash(`cat > retry.ts <<'EOF'\n${retry}EOF`, iso(110_000));
    fs.writeFileSync(path.join(repo, 'retry.ts'), retry);
    fs.appendFileSync(path.join(repo, 'README.md'), 'edited by hand\n');
    said(`Added retry.ts.\n[Origin: Decision] ${DECISION}`, iso(100_000));
    userSays('looks good, commit it', iso(60_000));
    await poll();
    const shadows = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.origin', 'transcript-watch', 'claude', `${SID}.json`), 'utf-8')).promptShadows;
    expect(shadows, 'the first poll should snapshot both turns at once').toHaveLength(2);

    const turn1 = sentEdits(0);
    if (process.env.E2E_DUMP || turn1.length === 0) dump();
    expect(turn1.map((e) => e.file), 'turn 1\'s shell write went unrecorded').toEqual(['retry.ts']);
    expect(turn1[0].newContent).toBe(retry);
    expect(sentEdits(1).map((e) => e.file), 'turn 2 claimed turn 1\'s file').not.toContain('retry.ts');

    // Turn 2 commits.
    ranBash('git add retry.ts && git commit -m "add retry with backoff"', iso(50_000));
    git('add', 'retry.ts');
    git('commit', '-q', '-m', 'add retry with backoff');
    const sha = git('rev-parse', 'HEAD');
    said('Committed.', iso(40_000));
    await poll();

    const record = readAllCommitMemory(repo).find((c) => c.commitSha === sha);
    if (process.env.E2E_DUMP || !record?.decisions?.length) dump();
    expect(record, 'the watcher wrote no record for the commit').toBeDefined();
    expect(record!.decisions).toEqual([DECISION]);
  }, 180_000);
});
