// END-TO-END, transcript watcher, CURSOR: the BUILT binary's
// `transcript-watch --once`, a real repo, a Cursor transcript on disk (no
// times anywhere), a fake API — the path that captures Cursor on Windows.
//
// With no times the watcher could not place a Cursor commit in any turn, so a
// Cursor commit's record carried no decisions at all (TODO 8e7ac8ec). The
// watcher pairs each commit with its turn itself; it now names that turn.
//
// Turn 1 writes retry.ts through the shell and states a decision; turn 2,
// "commit it", commits it and names the sha, as Cursor's agent does.
//
// Requires `dist/`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readAllCommitMemory } from '../memory.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

let server: http.Server;
let apiUrl = '';
function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
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

const SID = 'c0ffee00-e2e0-wtch-3333-444455556666';
let repo = '';
let transcript = '';
const lines: string[] = [];
function push(o: unknown) {
  lines.push(JSON.stringify(o));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const userSays = (text: string) => push({ role: 'user', content: text });
const ranShell = (command: string) => push({ type: 'assistant', role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command } }] } });
const said = (text: string) => push({ type: 'assistant', role: 'assistant', message: { content: [{ type: 'text', text }] } });

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

describe.skipIf(!haveDist)('transcript watcher, Cursor: a commit\'s record carries the decisions of the turns behind it', () => {
  let tmp = '';
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-watch-cursor-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer', memoryUpdate: 'both',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['cursor'], orgId: 'org-e2e',
    }));
    // Cursor's own store. The workspace name is Cursor's; the watcher finds
    // the repo from the absolute paths the agent touched.
    const convDir = path.join(os.homedir(), '.cursor', 'projects', 'e2e-workspace', 'agent-transcripts', SID);
    fs.mkdirSync(convDir, { recursive: true });
    transcript = path.join(convDir, `${SID}.jsonl`);

    git('init', '-q');
    git('config', 'user.name', 'E2E');
    git('config', 'user.email', 'e2e@example.com');
    fs.writeFileSync(path.join(repo, 'README.md'), 'uploader\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  }, 60_000);

  afterAll(() => {
    server?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records the decision of the turn whose shell write was committed', async () => {
    // Turn 1 starts; the watcher snapshots the tree at its start.
    userSays('add retry with backoff to the uploader');
    push({ type: 'assistant', role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: path.join(repo, 'README.md') } }] } });
    await poll();
    const shadows = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.origin', 'transcript-watch', 'cursor', `${SID}.json`), 'utf-8')).promptShadows;
    expect(shadows(), 'the first poll took no snapshot of turn 1\'s start').toHaveLength(1);

    // Turn 1 writes through the shell and states its decision. Turn 2 starts.
    ranShell(`cat > ${path.join(repo, 'retry.ts')} <<'EOF'\n${retry}EOF`);
    fs.writeFileSync(path.join(repo, 'retry.ts'), retry);
    said(`Added retry.ts.\n[Origin: Decision] ${DECISION}`);
    userSays('looks good, commit it');
    said('Committing.');
    await poll();

    // Turn 2 commits and names the sha.
    ranShell(`cd ${repo} && git add retry.ts && git commit -m "add retry with backoff"`);
    git('add', 'retry.ts');
    git('commit', '-q', '-m', 'add retry with backoff');
    const sha = git('rev-parse', 'HEAD');
    said(`Committed \`${sha.slice(0, 7)}\`.`);
    await poll();

    const record = readAllCommitMemory(repo).find((c) => c.commitSha === sha);
    if (process.env.E2E_DUMP || !record?.decisions?.length) {
      try {
        console.log(fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8')
          .split('\n').filter((l) => /transcript-watch|shell|window|commit/.test(l)).join('\n'));
      } catch (e) { console.log('no hooks.log', String(e)); }
      try {
        const dir = path.join(os.homedir(), '.origin', 'transcript-watch');
        for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
          if (String(f).endsWith('.json')) console.log(`--- ${f}\n` + fs.readFileSync(path.join(dir, f), 'utf-8').slice(0, 3000));
        }
      } catch (e) { console.log('no state', String(e)); }
    }
    expect(record, 'the watcher wrote no record for the commit').toBeDefined();
    expect(record!.decisions).toEqual([DECISION]);
  }, 180_000);
});
