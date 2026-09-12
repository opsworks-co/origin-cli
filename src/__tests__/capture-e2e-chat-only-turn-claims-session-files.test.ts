// END-TO-END: a chat-only turn must not claim files its own diff does not hold.
//
// Found by `origin verify-capture` on a real session (4968c7df, 2026-09-09).
// Turn 6's prompt was "what is next?" — the transcript shows NO tool calls for
// it at all — yet the stored row reads:
//
//   filesChanged: ["src/components/layout/Section.tsx"]
//   diff:         a single hunk DELETING .claude/launch.json
//
// Two halves describing different files, so the row contradicts itself
// (`claimed_file_absent_from_diff` + `diff_file_unclaimed`), and the file it
// names has no content anywhere in the row.
//
// The mechanism is in stop.ts's safety-net synthesis: its mapping takes
// `filesChanged` from `parsed.filesChanged`, which is
// `parseTranscript(..., { since: state.startedAt })` — the whole SESSION — and
// unions it with the files of THIS turn's uncommitted diff, while `diff`
// carries only this turn's window. stop.ts already documents that exact hazard
// one screen away, for a different consumer: "'This turn' has to mean this
// turn. The exemption used to read `parsed.filesChanged` … so a file ANY
// earlier turn had touched was exempt forever after."
//
// The turn reaches that synthesis because untracked churn in its window (the
// Browser pane's `.claude/launch.json`, written and removed by preview
// tooling) reads as "git shows work", which drops the honest empty mapping.
// Attributing that churn is a separate question; naming a file the row has no
// diff for is this one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-chatonly-session-9012';
let server: http.Server;
let apiUrl = '';
let repo = '';
let transcript = '';
const lines: string[] = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-chatonly-0001', verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
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

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[], cwd = repo): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
/** The agent answers in prose: no tool call, nothing written. */
function assistantSays(text: string) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

function state(): Record<string, any> {
  const dir = path.join(repo, '.git');
  const f = fs.readdirSync(dir).find((n) => n.startsWith('origin-session') && n.endsWith('.json'));
  if (!f) throw new Error('no session state file');
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

/** Files a diff actually carries sections for. */
function diffFiles(diff: string | null | undefined): string[] {
  return [...String(diff || '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill the detached write-journal watcher and take its lock away.
 *
 * This is the production condition, not a contrivance: on session 4968c7df the
 * watcher spawned at 22:01 and was gone by 22:39, and the next one only
 * appeared at 23:12 — the whole of turn 6 ran with no recorder. A turn whose
 * span holds no entries yields a ledger capture that resolves nothing, which
 * `ledgerCaptureIsUsable` correctly refuses (a dead watcher and a chat-only
 * turn look identical from there), so the LEGACY reconstruction answers.
 */
async function killJournalWatcher(): Promise<void> {
  let journal: string | undefined;
  try { journal = state().writeJournalPath; } catch { /* no state yet */ }
  if (!journal) return;
  const lock = journal.replace(/\.jsonl$/, '.lock');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf-8').trim());
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  } catch { /* no lock */ }
  // Drop the lock too, or the next hook sees a live recorder that is not there.
  try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ }
  await sleep(300);
}

describe.skipIf(!haveDist)('a chat-only turn beside untracked churn', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-chatonly-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, '');

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));

    git(['init', '-q']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('does not claim a file its own diff has no content for', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 0: real work on Section.tsx, committed. From here the SESSION's
    // transcript file list is permanently non-empty — the state the bug needs.
    say('restyle the section');
    expect((await run('user-prompt-submit', { prompt: 'restyle the section' })).code).toBe(0);
    await agentWrites('tu-1', 'src/components/layout/Section.tsx', 'export const Section = () => null;\n');
    const cmd = 'git add -A && git commit -q -m "restyle"';
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-2' });
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'restyle']);
    toolUse('tu-2', 'Bash', { command: cmd });
    await run('post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-2', tool_response: { stdout: '', stderr: '' } });
    expect((await run('stop', {})).code).toBe(0);

    // The agent's own tooling leaves an untracked file behind — the Browser
    // pane writes .claude/launch.json when it starts a dev server. Not the
    // agent's authored work, and no tool call describes it.
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'launch.json'), JSON.stringify({
      version: '0.0.1',
      configurations: [{ name: 'dev', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 }],
    }, null, 2) + '\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'launch config']);

    // Turn 1: a QUESTION. No tool calls, nothing written by the agent — but
    // the preview tooling removes its launch.json inside the window.
    say('what is next?');
    expect((await run('user-prompt-submit', { prompt: 'what is next?' })).code).toBe(0);
    // The recorder dies inside the turn, exactly as it did in production, so
    // the ledger cannot answer for this turn and the legacy path does.
    await killJournalWatcher();
    fs.rmSync(path.join(repo, '.claude', 'launch.json'));
    assistantSays('Next I would look at the hero section.');
    expect((await run('stop', {})).code).toBe(0);

    const rows = state().completedPromptMappings || [];
    const turn1 = rows.find((r: any) => r.promptIndex === 1);
    expect(turn1, 'turn 1 must have a row').toBeTruthy();

    // The row must have come from the legacy reconstruction. With a live
    // watcher the ledger owns the turn and produces a self-consistent row on
    // its own, so a test that let that happen would pass without the fix.
    expect(turn1.diffSource, 'turn 1 must be the legacy path, not the ledger').toBeUndefined();

    const claimed: string[] = turn1.filesChanged || [];
    const carried = new Set([
      ...diffFiles(turn1.diff),
      ...diffFiles(turn1.uncommittedDiff),
      ...(turn1.outOfRepoFiles || []),
      ...(turn1.contentUnavailableFiles || []),
    ]);
    // THE DEFECT: every file the row NAMES must be a file the row can SHOW.
    const unbacked = claimed.filter((f) => !carried.has(f));
    expect(unbacked, `turn 1 claims files it stores no content for (diff carries ${JSON.stringify([...carried])})`).toEqual([]);

    // And the specific shape seen in production: a question turn must not be
    // credited with the file an EARLIER turn edited.
    expect(claimed).not.toContain('src/components/layout/Section.tsx');
  }, 120_000 * WINDOWS_SLOWDOWN);

  // A legacy row used to be stored as `diff.slice(0, 200_000)`. A byte offset
  // cuts MID-HUNK — a diff `git apply` refuses, a corrupt capture rather than a
  // smaller one — and drops whole files off the end while the row went on
  // naming them. Seen live on session d5cc625b turn 2: a stored diff of
  // EXACTLY 200000 bytes, nine files claimed, seven present.
  it('cuts an over-budget diff at file boundaries and names what did not fit', async () => {
    // Six files of ~60 KB each: comfortably over the 200 KB budget, so some
    // must be dropped whole rather than the text sliced through a hunk.
    const big = (seed: string) =>
      Array.from({ length: 1200 }, (_, i) => `export const ${seed}_${i} = ${i}; // ${seed.repeat(4)}`).join('\n') + '\n';
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `src/bulk/${n}.ts`);

    say('generate the bulk modules');
    expect((await run('user-prompt-submit', { prompt: 'generate the bulk modules' })).code).toBe(0);
    // Written by a shell command, so no tool call describes them, and with the
    // recorder dead the legacy reconstruction is what answers.
    await killJournalWatcher();
    for (const [i, f] of files.entries()) {
      const abs = path.join(repo, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, big(`M${i}`));
    }
    assistantSays('Generated the bulk modules with a shell loop.');
    expect((await run('stop', {})).code).toBe(0);

    const rows = state().completedPromptMappings || [];
    const turn = rows.find((r: any) => r.promptIndex === 2);
    expect(turn, 'turn 2 must have a row').toBeTruthy();
    expect(turn.diffSource, 'must be the legacy path, not the ledger').toBeUndefined();

    // Over budget, so something had to give — that is the case under test.
    expect(String(turn.diff || '').length).toBeGreaterThan(0);
    expect(turn.contentUnavailableFiles?.length, 'the row must say what did not fit').toBeGreaterThan(0);

    // The stored diff is never cut mid-hunk: every section it opens, it closes
    // with a real hunk header, and the byte count is not the raw cap.
    expect(String(turn.diff).length).not.toBe(200_000);
    for (const section of String(turn.diff).split(/(?=^diff --git )/m).filter(Boolean)) {
      expect(section, 'a stored section must carry a hunk header').toMatch(/^diff --git .*\n[\s\S]*@@ /);
    }

    // And the row still names every file it knows changed — those it can show,
    // plus those it had to drop.
    const shown = new Set(diffFiles(turn.diff));
    const unavailable: string[] = turn.contentUnavailableFiles || [];
    for (const f of files) {
      expect(shown.has(f) || unavailable.includes(f), `${f} is neither shown nor declared unavailable`).toBe(true);
    }
    const claimed: string[] = turn.filesChanged || [];
    for (const f of claimed) {
      expect(shown.has(f) || unavailable.includes(f), `${f} claimed with no content and no declaration`).toBe(true);
    }
  }, 120_000 * WINDOWS_SLOWDOWN);
});
