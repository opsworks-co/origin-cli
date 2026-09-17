// A real hook sequence against the BUILT binary: a real repo, a fake API, a
// transcript the hooks read, and the detached write-journal watcher. Shared by
// the capture-e2e tests that exercise what happens to a turn between its Stop
// and the next prompt (restored-from-history.ts).
import { expect } from 'vitest';
import { holdIdleConnections } from './fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { foldStopRows } from './fold-stop-rows.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BIN = path.join(cliRoot, 'dist', 'index.js');
export const haveDist = fs.existsSync(BIN);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Hit = { method: string; url: string; body: any };

export interface Harness {
  repo: string;
  hits: Hit[];
  git: (args: string[], env?: Record<string, string>) => string;
  run: (event: string, payload?: Record<string, unknown>) => Promise<{ code: number | null; stderr: string }>;
  gitHook: (name: string) => Promise<{ code: number | null; stderr: string }>;
  say: (text: string) => void;
  reply: (text: string) => void;
  /** PreToolUse → the write → PostToolUse. */
  agentWrites: (id: string, file: string, content: string) => Promise<void>;
  /** PreToolUse → `effect` (the command's work on disk) → PostToolUse. */
  agentRuns: (id: string, command: string, effect: () => void | Promise<void>, extra?: Record<string, unknown>) => Promise<void>;
  /** session-start, the first prompt, and a journal watcher that is recording. */
  startSession: (prompt: string) => Promise<void>;
  submit: (prompt: string) => Promise<void>;
  stop: () => Promise<void>;
  journalText: () => string;
  /** A second agent session in the SAME checkout, with its own transcript and server session. */
  sibling: (sessionId: string) => Promise<AgentSession>;
  rows: () => any[];
  hooksLog: () => string;
  close: () => Promise<void>;
}

export interface AgentSession {
  run: (event: string, payload?: Record<string, unknown>) => Promise<{ code: number | null; stderr: string }>;
  say: (text: string) => void;
  reply: (text: string) => void;
  agentWrites: (id: string, file: string, content: string) => Promise<void>;
  agentRuns: (id: string, command: string, effect: () => void | Promise<void>, extra?: Record<string, unknown>) => Promise<void>;
  submit: (prompt: string) => Promise<void>;
  stop: () => Promise<void>;
}

export async function createHarness(sessionId: string, serverSession: string): Promise<Harness> {
  const hits: Hit[] = [];
  const siblings: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      hits.push({ method: req.method || '', url: req.url || '', body });
      res.setHeader('content-type', 'application/json');
      const u = req.url || '';
      if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
        // A sibling session in the same checkout gets its own server row.
        if (process.env.E2E_DUMP_FILE) fs.appendFileSync(process.env.E2E_DUMP_FILE, `START ${raw.slice(0, 600)}\n`);
        const sib = siblings.find((id) => raw.includes(id));
        res.end(JSON.stringify({ sessionId: sib ? `sibling-${sib}` : serverSession, verboseCapture: false }));
      } else if (u.startsWith('/api/pricing')) {
        res.end(JSON.stringify({ models: {} }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  holdIdleConnections(server);
  const apiUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });

  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-stopnext-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const transcript = path.join(tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '');

  const originDir = path.join(os.homedir(), '.origin');
  fs.mkdirSync(originDir, { recursive: true });
  fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
    apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
  }));
  fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
    machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
  }));

  const git = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

  const agentSession = (agentId: string, agentTranscript: string) => {
    const lines: string[] = [];
    const run = (event: string, payload: Record<string, unknown> = {}) => {
      const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
        cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdout.on('data', () => { /* context injection */ });
      child.stdin.end(JSON.stringify({
        session_id: agentId, transcript_path: agentTranscript, cwd: repo, hook_event_name: event, ...payload,
      }));
      return new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stderr })));
    };

    const flush = () => fs.writeFileSync(agentTranscript, lines.join('\n') + '\n');
    const say = (text: string) => {
      lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
      flush();
    };
    const toolUse = (id: string, name: string, input: Record<string, unknown>) => {
      lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
      lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
      flush();
    };
    const reply = (text: string) => {
      lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }));
      flush();
    };

    const agentWrites = async (id: string, file: string, content: string) => {
      const abs = path.join(repo, file);
      const input = { file_path: abs, content };
      await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      toolUse(id, 'Write', input);
      await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
    };

    const agentRuns = async (id: string, command: string, effect: () => void | Promise<void>, extra: Record<string, unknown> = {}) => {
      const input = { command, ...extra };
      await run('pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
      await effect();
      toolUse(id, 'Bash', input);
      await run('post-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
    };

    const submit = async (prompt: string) => {
      say(prompt);
      const r = await run('user-prompt-submit', { prompt });
      expect(r.code, r.stderr).toBe(0);
    };
    const stop = async () => {
      const r = await run('stop', { stop_hook_active: false });
      expect(r.code, r.stderr).toBe(0);
    };
    return { run, say, reply, agentWrites, agentRuns, submit, stop };
  };
  const { run, say, reply, agentWrites, agentRuns, submit, stop } = agentSession(sessionId, transcript);
  const sibling = async (id: string): Promise<AgentSession> => {
    siblings.push(id);
    const t = path.join(tmp, `${id}.jsonl`);
    fs.writeFileSync(t, '');
    const agent = agentSession(id, t);
    const r = await agent.run('session-start', { source: 'startup' });
    expect(r.code, r.stderr).toBe(0);
    return agent;
  };

  const gitHook = (name: string) => {
    const child = spawn(process.execPath, [BIN, 'hooks', name], {
      cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', () => { /* ignore */ });
    return new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  };

  const journalFiles = (id: string = sessionId): { journal: string; lock: string } | null => {
    const dir = path.join(os.homedir(), '.origin', 'journals');
    if (!fs.existsSync(dir)) return null;
    const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(id.slice(0, 12)));
    return j ? { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) } : null;
  };
  const journalText = () => {
    const jf = journalFiles();
    try { return jf ? fs.readFileSync(jf.journal, 'utf-8') : ''; } catch { return ''; }
  };

  const startSession = async (prompt: string) => {
    const s = await run('session-start', { source: 'startup' });
    expect(s.code, s.stderr).toBe(0);
    await submit(prompt);
    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && !journalText().includes('{"f"'); i++) {
      fs.writeFileSync(probe, String(i));
      await sleep(25);
    }
    expect(journalText(), 'the detached journal watcher recorded nothing').toContain('{"f"');
    await sleep(400);
  };

  const rows = () => foldStopRows(hits
    .filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${serverSession}`))
    .map((h) => h.body)
    .filter((b) => b && Array.isArray(b.promptChanges)));

  const hooksLog = () => {
    try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; }
  };

  const close = async () => {
    if (process.env.E2E_DUMP_FILE) {
      try { fs.appendFileSync(process.env.E2E_DUMP_FILE, `--- hooks.log (${sessionId}) ---\n${hooksLog()}\n`); } catch { /* best effort */ }
    }
    if (process.env.E2E_DUMP) {
      console.log(`--- hooks.log (${sessionId}) ---\n` + hooksLog().split('\n')
        .filter((l) => !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 600)).join('\n'));
    }
    for (const id of [sessionId, ...siblings]) {
      const jf = journalFiles(id);
      if (!jf) continue;
      const deadline = Date.now() + (id === sessionId ? 20_000 : 2_000);
      while (Date.now() < deadline) {
        try {
          const pid = Number(fs.readFileSync(jf.lock, 'utf-8').trim());
          if (pid > 0) { process.kill(pid, 'SIGTERM'); break; }
        } catch { /* no lock yet */ }
        await sleep(250);
      }
    }
    await new Promise<void>((r) => server.close(() => r()));
    if (process.env.E2E_KEEP) { try { fs.appendFileSync(process.env.E2E_KEEP, `${sessionId} ${tmp}\n`); } catch { /* best effort */ } return; }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'E2E']);
  git(['config', 'user.email', 'e2e@example.com']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');

  return {
    repo, hits, git, run, gitHook, say, reply, agentWrites, agentRuns, startSession, submit, stop,
    journalText, sibling, rows, hooksLog, close,
  };
}

export const numbered = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}_${i} = ${i}`).join('\n') + '\n';

/** Write files and commit them, returning the new HEAD. */
export function commitFiles(h: Harness, files: Record<string, string>, message: string, env: Record<string, string> = {}): string {
  for (const [f, content] of Object.entries(files)) {
    const abs = path.join(h.repo, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  h.git(['add', '-A']);
  h.git(['commit', '-q', '-m', message], env);
  return h.git(['rev-parse', 'HEAD']);
}
