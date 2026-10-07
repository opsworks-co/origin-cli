// END-TO-END, the BUILT heartbeat: when it ends a session, the session's entry
// in the repo memory note is rewritten from the whole session.
//
// Claude Code's SessionEnd hook is handled as a Stop (its desktop app fires it
// on reconnect too), so the heartbeat's end is the only real end a Claude Code
// session has — and it never touched memory. Every Claude Code entry on this
// repo was whatever its LAST COMMIT wrote: `endedAt` a minute or two after the
// final commit, and for session 22005642, whose last commit merged main in, the
// summary was the agent's narration — "While that runs, I'm pushing the merge
// commit so the PR shows the exact head being tested."
//
// Driven through SIGTERM, which runs the same endSession the idle sweep does.
// Requires `dist/`. POSIX-only for a reason of its own, which is why it is not
// in the capture-e2e family (whose Windows gate it would rightly trip): on
// Windows `child.kill('SIGTERM')` is TerminateProcess, so no handler runs and
// there is no signal to drive the end with. The idle sweep that ends sessions
// there takes 20 minutes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEARTBEAT = path.join(cliRoot, 'dist', 'heartbeat.js');
const MEMORY = path.join(cliRoot, 'dist', 'memory.js');
const haveDist = fs.existsSync(HEARTBEAT) && fs.existsSync(MEMORY);

const SESSION = 'e2e-final-memory-0001';
const NARRATION = "While that runs, I'm pushing the merge commit so the PR shows the exact head being tested.";

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function readNote(repo: string): any {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
  return JSON.parse(git(repo, 'notes', '--ref=origin-memory', 'show', root));
}

/** Run a snippet against the BUILT memory module, in the test's HOME. */
function withMemory(home: string, repo: string, body: string): void {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import * as m from ${JSON.stringify(MEMORY)};
    const repo = ${JSON.stringify(repo)};
    ${body}
  `], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function runHeartbeatToEnd(home: string, stateFile: string): Promise<void> {
  const pidFile = path.join(home, '.origin', 'heartbeats', `${SESSION}.pid`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  // Standalone: no api url/key, no parent pid to watch.
  const child = spawn(process.execPath, [HEARTBEAT, SESSION, '', '', pidFile, '0', stateFile], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The pid file is what marks this daemon as the session's owner; without it
  // signalExit reads the exit as a supersession and ends nothing.
  fs.writeFileSync(pidFile, String(child.pid));
  // Signal only once it can end the session. A fixed 1.5 s sleep was not
  // enough under full-suite load: the SIGTERM arrived before the module had
  // registered its handler, killed the daemon outright, and no entry was
  // written ("no note found").
  const log = path.join(home, '.origin', 'hooks.log');
  const readyBy = Date.now() + 30_000;
  const ready = () => { try { return fs.readFileSync(log, 'utf-8').split('\n').some((l) => l.includes('[heartbeat] ready') && l.includes(`"pid":${child.pid}`)); } catch { return false; } };
  while (!ready()) {
    if (Date.now() > readyBy) { child.kill('SIGKILL'); throw new Error('heartbeat never logged ready'); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
  if (code === 'timeout') { child.kill('SIGKILL'); throw new Error('heartbeat did not exit after SIGTERM'); }
}

describe.skipIf(!haveDist || process.platform === 'win32')('heartbeat end writes the session\'s final memory entry (built binary)', () => {
  let tmp: string;
  let home: string;
  let repo: string;
  let stateFile: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-final-memory-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');

    const transcript = path.join(tmp, 'transcript.jsonl');
    const line = (role: 'user' | 'assistant', text: string, ts: string) => JSON.stringify({
      type: role, timestamp: ts, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    });
    fs.writeFileSync(transcript, [
      line('user', 'make the memory note keep what fits a byte budget', '2026-09-29T00:00:00.000Z'),
      line('assistant', 'Done.\n\n[Origin: Decision] byte budget over a session count — the count protected nothing', '2026-09-29T00:10:00.000Z'),
      line('assistant', 'Merged and released.', '2026-09-29T01:10:00.000Z'),
    ].join('\n') + '\n');

    stateFile = path.join(repo, '.git', 'origin-session.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionId: SESSION, repoPath: repo, startedAt: '2026-09-29T00:00:00.000Z', agentSlug: 'claude-code',
      model: 'claude-opus-5-5', branch: 'main', prompts: ['make the memory note keep what fits a byte budget'],
      transcriptPath: transcript, status: 'RUNNING',
    }));
  });

  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('replaces the last commit\'s narration with the session\'s commits, and adds its decision', async () => {
    // What `memoryUpdate: commit` left: the entry from the session's LAST
    // commit, a merge, whose subject is noise — so it fell to the narration.
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ memoryUpdate: 'commit' }));
    withMemory(home, repo, `
      const at = (m) => '2026-09-29T00:' + m + ':00.000Z';
      m.writeCommitMemory(repo, { commitSha: 'a'.repeat(40), sessionId: '${SESSION}', agentSlug: 'claude-code', message: 'fix(memory): keep what fits a byte budget', filesChanged: ['memory.ts'], linesAdded: 400, linesRemoved: 80, branch: 'main', committedAt: at('20') });
      m.writeCommitMemory(repo, { commitSha: 'b'.repeat(40), sessionId: '${SESSION}', agentSlug: 'claude-code', message: "Merge remote-tracking branch 'origin/main' into feature", filesChanged: ['package.json'], linesAdded: 1, linesRemoved: 1, branch: 'main', committedAt: at('30') });
      m.writeSessionMemory(repo, { sessionId: '${SESSION}', agentSlug: 'claude-code', model: 'claude-opus-5-5', startedAt: at('00'), endedAt: at('30'), branch: 'main', summary: ${JSON.stringify(NARRATION)}, filesChanged: ['memory.ts', 'package.json'], promptCount: 1, linesAdded: 401, linesRemoved: 81, openTodos: [] });
    `);
    expect(readNote(repo).sessions[0].summary).toBe(NARRATION);

    await runHeartbeatToEnd(home, stateFile);

    const entry = readNote(repo).sessions.find((s: any) => s.sessionId === SESSION);
    expect(entry.summary).toBe('fix(memory): keep what fits a byte budget');
    expect(entry.decisions).toEqual(['byte budget over a session count — the count protected nothing']);
    // The reply after the commit is where the agent wrote it: the commit record
    // made in that turn is filled too.
    const fixCommit = readNote(repo).commits.find((c: any) => c.commitSha === 'a'.repeat(40));
    expect(fixCommit.decisions).toEqual(['byte budget over a session count — the count protected nothing']);
    // What it already carried is kept.
    expect(entry.filesChanged).toEqual(['memory.ts', 'package.json']);
    expect(entry.linesAdded).toBe(401);
    expect(Date.parse(entry.endedAt)).toBeGreaterThan(Date.parse('2026-09-29T00:30:00.000Z'));
  });

  // Session 46b82050: a logo tried on localhost and rejected ("commit only
  // video change, design change is not approved") left its decision in the
  // transcript, and it was recorded as the why of every commit the session
  // made. Memory is what was committed.
  it('a turn whose work was never committed leaves no decision on the session or its commits', async () => {
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ memoryUpdate: 'commit' }));
    const transcript = path.join(tmp, 'transcript.jsonl');
    const line = (role: 'user' | 'assistant', text: string, ts: string) => JSON.stringify({
      type: role, timestamp: ts, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    });
    fs.writeFileSync(transcript, [
      line('user', 'try a white logo on localhost', '2026-09-29T00:00:00.000Z'),
      line('assistant', 'Done.\n\n[Origin: Decision] The logo became white with a cyan dot', '2026-09-29T00:05:00.000Z'),
      line('user', 'commit only the video change, the design is not approved', '2026-09-29T00:15:00.000Z'),
      line('assistant', 'Committed.\n\n[Origin: Decision] The video plays with no poster', '2026-09-29T00:21:00.000Z'),
    ].join('\n') + '\n');
    withMemory(home, repo, `
      m.writeCommitMemory(repo, { commitSha: 'c'.repeat(40), sessionId: '${SESSION}', agentSlug: 'claude-code', message: 'fix(web): the demo video plays straight away', filesChanged: ['Landing.tsx'], linesAdded: 3, linesRemoved: 3, branch: 'main', committedAt: '2026-09-29T00:20:00.000Z' });
      m.writeSessionMemory(repo, { sessionId: '${SESSION}', agentSlug: 'claude-code', model: 'claude-opus-5-5', startedAt: '2026-09-29T00:00:00.000Z', endedAt: '2026-09-29T00:20:00.000Z', branch: 'main', summary: 'video', filesChanged: ['Landing.tsx'], promptCount: 2, linesAdded: 3, linesRemoved: 3, openTodos: [] });
    `);

    await runHeartbeatToEnd(home, stateFile);

    const note = readNote(repo);
    expect(note.commits.find((c: any) => c.commitSha === 'c'.repeat(40)).decisions).toEqual(['The video plays with no poster']);
    expect(note.sessions.find((s: any) => s.sessionId === SESSION).decisions).toEqual(['The video plays with no poster']);
    expect(JSON.stringify(note)).not.toMatch(/cyan/);
  });

  // The other half: the change and its decision in one turn, "commit it" in
  // the next. The commit's own turn wrote no decision; the earlier turn's work
  // is in the commit, so its decision is the commit's — and the rejected turn
  // between them, whose work is not, stays out.
  it('an earlier turn whose work is in the commit gives the commit its decision', async () => {
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ memoryUpdate: 'commit' }));
    const video = ['const autoplay = true;', 'video.removeAttribute("poster");', 'video.play().catch(() => undefined);'];
    const logo = ['const logoColor = "white";', 'const dotColor = "cyan";', 'export const LOGO_VERSION = 2;'];
    fs.writeFileSync(path.join(repo, 'Landing.tsx'), video.join('\n') + '\n');
    git(repo, 'add', '.');
    execFileSync('git', ['commit', '-qm', 'fix(web): the demo video plays straight away'], {
      cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: '2026-09-29T00:20:30Z', GIT_AUTHOR_DATE: '2026-09-29T00:20:30Z' },
    });
    const sha = git(repo, 'rev-parse', 'HEAD');

    const transcript = path.join(tmp, 'transcript.jsonl');
    const user = (text: string, ts: string) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
    const said = (text: string, ts: string) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const edit = (file: string, lines: string[], ts: string) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: 'x', new_string: lines.join('\n') } }] } });
    fs.writeFileSync(transcript, [
      user('make the demo video autoplay', '2026-09-29T00:00:00.000Z'),
      edit('Landing.tsx', video, '2026-09-29T00:01:00.000Z'),
      said('Done.\n\n[Origin: Decision] The video plays with no poster', '2026-09-29T00:02:00.000Z'),
      user('try a white logo', '2026-09-29T00:05:00.000Z'),
      edit('Logo.tsx', logo, '2026-09-29T00:06:00.000Z'),
      said('Done.\n\n[Origin: Decision] The logo became white with a cyan dot', '2026-09-29T00:07:00.000Z'),
      user('commit only the video change', '2026-09-29T00:20:00.000Z'),
      said('Committed.', '2026-09-29T00:21:00.000Z'),
    ].join('\n') + '\n');
    withMemory(home, repo, `
      m.writeCommitMemory(repo, { commitSha: '${sha}', sessionId: '${SESSION}', agentSlug: 'claude-code', message: 'fix(web): the demo video plays straight away', filesChanged: ['Landing.tsx'], linesAdded: 3, linesRemoved: 0, branch: 'main', committedAt: '2026-09-29T00:20:30.000Z' });
      m.writeSessionMemory(repo, { sessionId: '${SESSION}', agentSlug: 'claude-code', model: 'claude-opus-5-5', startedAt: '2026-09-29T00:00:00.000Z', endedAt: '2026-09-29T00:21:00.000Z', branch: 'main', summary: 'video', filesChanged: ['Landing.tsx'], promptCount: 3, linesAdded: 3, linesRemoved: 0, openTodos: [] });
    `);

    await runHeartbeatToEnd(home, stateFile);

    const note = readNote(repo);
    expect(note.commits.find((c: any) => c.commitSha === sha).decisions).toEqual(['The video plays with no poster']);
    expect(note.sessions.find((s: any) => s.sessionId === SESSION).decisions).toEqual(['The video plays with no poster']);
    expect(JSON.stringify(note)).not.toMatch(/cyan/);
  });

  it('does not start an entry for a session that never committed when memory is written at commits', async () => {
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ memoryUpdate: 'commit' }));
    await runHeartbeatToEnd(home, stateFile);
    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
    expect(() => git(repo, 'notes', '--ref=origin-memory', 'show', root)).toThrow();
  });

  it('writes the entry when memory is written at session end, the default', async () => {
    await runHeartbeatToEnd(home, stateFile);
    const entry = readNote(repo).sessions.find((s: any) => s.sessionId === SESSION);
    expect(entry).toBeDefined();
    // No commits: the agent's last message is the summary.
    expect(entry.summary).toBe('Merged and released.');
  });
});
