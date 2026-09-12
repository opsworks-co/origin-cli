// END-TO-END, Codex: the BUILT binary's `codex-watch` daemon as a process, a
// real rollout under ~/.codex/sessions, a real repo, a fake API.
//
// Codex has no reliable hooks; the daemon IS its capture. It polls the rollout
// directory, registers the thread, and — as of this change — journals the
// working tree in-process and answers each turn from the ledger. Nothing in
// vitest can see a daemon that exits on start, holds no watcher, or polls a
// directory it was not pointed at; this spawns the real one and reads what
// reached the API.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { journalPathsForTag } from '../write-journal-watch.js';
import { verifyTurn, parseUnifiedDiff } from '../capture-verify.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        hits.push({ method: req.method || '', url: req.url || '', body });
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-codex-session-0001' }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

let repo = '';
let rollout = '';
let daemon: ChildProcess | null = null;
let daemonErr = '';
const THREAD = 'e2e0c0de-1111-2222-3333-444455556666';

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}\n--- daemon stderr ---\n${daemonErr.slice(-2000)}`);
}

const lines: string[] = [];
function writeRollout() {
  fs.writeFileSync(rollout, lines.join('\n') + '\n');
}
function userSays(text: string) {
  lines.push(JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  writeRollout();
}
function shellRan(cmd: string) {
  lines.push(JSON.stringify({ payload: { type: 'function_call', name: 'exec', input: cmd, call_id: `c${lines.length}` } }));
  writeRollout();
}

function rowsSent(): any[][] {
  return hits.filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges)).map((h) => h.body.promptChanges);
}

/**
 * The daemon can send a later partial PATCH after it has sent the row this
 * assertion is waiting for.  Read the newest matching row, not the last
 * payload wholesale: the server folds PATCHes by prompt index and the test
 * must model that asynchronous wire shape too.
 */
function latestSentRow(
  payloads: readonly any[][],
  matches: (row: any) => boolean,
): any | null {
  for (let payloadIndex = payloads.length - 1; payloadIndex >= 0; payloadIndex--) {
    const rows = payloads[payloadIndex];
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
      if (matches(rows[rowIndex])) return rows[rowIndex];
    }
  }
  return null;
}
function journalPath(): string {
  // Keyed by tag AND tree — a tag alone no longer names one journal.
  return journalPathsForTag(THREAD.slice(0, 12), repo).journalPath;
}
function writesIn(): number {
  try { return fs.readFileSync(journalPath(), 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length; } catch { return 0; }
}

describe('Codex e2e payload selection', () => {
  it('does not discard a settled ledger row for a later empty PATCH', () => {
    const ledgerRow = { promptIndex: 0, diffSource: 'ledger', linesAdded: 1 };
    const row = latestSentRow([
      [ledgerRow],
      [], // a poll can legitimately send no prompt changes after the ledger row
    ], (candidate) => candidate.promptIndex === 0 && candidate.diffSource === 'ledger');
    expect(row).toBe(ledgerRow);
  });
});

describe.skipIf(!haveDist)('codex capture end to end through the built daemon', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-codex-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['codex'], orgId: 'org-e2e',
    }));

    git(['init', '-q']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);

    // The rollout, where Codex writes it: ~/.codex/sessions/YYYY/MM/DD/.
    const d = new Date();
    const y = String(d.getUTCFullYear());
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const dir = path.join(os.homedir(), '.codex', 'sessions', y, m, day);
    fs.mkdirSync(dir, { recursive: true });
    rollout = path.join(dir, `rollout-${y}-${m}-${day}T10-00-00-${THREAD}.jsonl`);
    lines.push(JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta',
      payload: { id: THREAD, timestamp: new Date().toISOString(), cwd: repo, originator: 'codex_cli_rs' } }));
    userSays('change the greeting');
    shellRan('sed -i s/old/new/ app.py');

    // The daemon, as `origin enable` / logon autostart runs it.
    daemon = spawn(process.execPath, [BIN, 'codex-watch', '--quiet'], {
      cwd: tmp, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stderr?.on('data', (c) => { daemonErr += c; });
    daemon.stdout?.on('data', (c) => { daemonErr += c; });
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      try {
        const jdir = path.join(os.homedir(), '.origin', 'journals');
        for (const f of fs.readdirSync(jdir).filter((n) => n.endsWith('.jsonl'))) {
          console.log(`--- journal ${f} ---\n` + fs.readFileSync(path.join(jdir, f), 'utf-8'));
        }
      } catch (e) { console.log('no journal dir', String(e)); }
      try {
        const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8').split('\n').filter((l) => /ledger|journal|stop\]|post-tool-use\]|after-file-edit|adopted|pre-mark|antigravity capture|codex-watch/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l));
        console.log('--- hooks.log ---\n' + log.map((l) => l.slice(0, 600)).join('\n'));
      } catch { /* none */ }
    }
    try { daemon?.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('registers the thread, journals the tree, and answers the turn from the ledger', async () => {
    // Poll 1: session registered, journal watcher up, turn 0 marked.
    await waitFor(() => hits.some((h) => h.url.startsWith('/api/mcp/session/start')), 30_000, 'session/start from the daemon');
    await waitFor(() => fs.existsSync(journalPath()), 15_000, 'the thread journal to exist');
    expect(fs.readFileSync(journalPath(), 'utf-8')).toMatch(/"id":"[tw]_/);
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && writesIn() === 0; i++) { fs.writeFileSync(probe, String(i)); await sleep(25); }
    expect(writesIn(), 'the in-process journal watcher recorded nothing').toBeGreaterThan(0);
    const before = writesIn();
    await sleep(400);

    // The shell write the rollout never records as a patch.
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n\n\nmain()\n');
    await waitFor(() => writesIn() > before, 10_000, 'the journal to record the write');
    // Touch the rollout so the next poll sees activity.
    shellRan('git status');

    await waitFor(
      () => latestSentRow(rowsSent(), (r) => r.promptIndex === 0 && r.diffSource === 'ledger') !== null,
      30_000,
      'a ledger-sourced row for turn 0',
    );
    const t1 = latestSentRow(rowsSent(), (r) => r.promptIndex === 0 && r.diffSource === 'ledger');
    if (!t1) throw new Error('the ledger row disappeared after the wait');
    expect(t1.diffSource).toBe('ledger');
    expect(t1.turnId).toMatch(/^[tw]_/);
    expect(t1.authoritative).toBe(true);
    expect(t1.filesChanged).toEqual(['app.py']);
    expect(t1.diff).toContain('-    print("old")');
    expect(t1.diff).toContain('+    print("new")');
    expect(t1.diff).not.toContain('+def main():');
    expect(t1.linesAdded).toBe(1);
    expect(t1.linesRemoved).toBe(1);
    expect(parseUnifiedDiff(t1.diff).files[0].isNew).toBe(false);
    expect(verifyTurn({ promptIndex: 0, filesChanged: t1.filesChanged, diff: t1.diff, linesAdded: t1.linesAdded, linesRemoved: t1.linesRemoved })).toEqual([]);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
