import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';
import { withClaudeHookLock } from '../claude-hook-lock.js';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const children: ChildProcess[] = [];
const dirs: string[] = [];
const url = (name: string) => JSON.stringify(pathToFileURL(path.join(dist, name + '.js')).href);
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-')));
  dirs.push(home);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'old\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base'], { cwd: repo });
  return { home, repo, env: { ...process.env, HOME: home, USERPROFILE: home, ORIGIN_LIVE_CAPTURE: '1', ORIGIN_WRITE_JOURNAL: '0' } };
}
function worker(code: string, env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  children.push(child);
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Claude hooks across processes', () => {
  it('serializes state reads, permits another conversation, and recovers a killed owner', async () => {
    const { home } = fixture();
    const directory = path.join(home, 'locks');
    const owner = worker(`import { withClaudeHookLock } from ${url('claude-hook-lock')};
      await withClaudeHookLock('claude-code', 'pre-tool-use', 'same', async () => {
        process.send('locked'); await new Promise(() => { setInterval(() => {}, 1000); });
      }, {directory:${JSON.stringify(directory)}});`);
    await once(owner, 'message');
    await withClaudeHookLock('claude-code', 'pre-tool-use', 'different', async () => {}, { directory, timeoutMs: 100 });
    expect(owner.exitCode).toBeNull();
    // A hook that cannot get the lock in time runs anyway: Claude kills a hook
    // that waits past its timeout, and a killed user-prompt-submit loses the prompt.
    let ranUnlocked = false;
    await expect(withClaudeHookLock('claude-code', 'post-tool-use', 'same', async () => { ranUnlocked = true; return 'ran'; }, { directory, timeoutMs: 30 })).resolves.toBe('ran');
    expect(ranUnlocked).toBe(true);
    expect(owner.exitCode, 'the live owner must not be displaced by a waiter that gave up').toBeNull();
    const exited = once(owner, 'exit'); owner.kill(); await exited;
    await expect(withClaudeHookLock('claude-code', 'stop', 'same', async () => { throw new Error('failed capture'); }, { directory, timeoutMs: 1000 })).rejects.toThrow('failed capture');
    await withClaudeHookLock('claude-code', 'user-prompt-submit', 'same', async () => {}, { directory, timeoutMs: 1000 });
  });

  it('keeps every tool record, pending claim and edit from parallel real CLI hooks', async () => {
    const { home, repo, env } = fixture();
    const native = 'claude-parallel-native';
    const tag = 'parallel';
    const seed = `import {saveSessionState,getStatePath} from ${url('session-state')};
      const state={sessionId:'local-parallel',sessionTag:'${tag}',claudeSessionId:'${native}',agentSessionId:'${native}',
      agentSlug:'claude-code',repoPath:${JSON.stringify(repo)},startedAt:new Date().toISOString(),prompts:['edit files'],
      promptTurnIds:['t-one'],subagents:[],liveEdits:[],shellProbes:[]};
      saveSessionState(state,state.repoPath,state.sessionTag); console.log(getStatePath(state.repoPath,state.sessionTag));`;
    const statePath = execFileSync(process.execPath, ['--input-type=module', '-e', seed], { cwd: repo, env, encoding: 'utf8' }).trim();
    const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const hook = (event: string, id: string, name = 'Edit', input: any = { file_path: path.join(repo, `${id}.ts`), old_string: 'old', new_string: id }) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(dist, 'index.js'), 'hooks', 'claude-code', event], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let out = ''; let err = '';
      child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(`${event}: ${code}: ${err}`));
        // No expensive automatic blame enrichment on the blocking path.
        if (out.includes('File attribution for')) return reject(new Error('Blocking attribution still runs'));
        resolve();
      });
      child.stdin.end(JSON.stringify({session_id:native,cwd:repo,tool_name:name,tool_use_id:id,tool_input:input,tool_response:{success:true}}));
    });
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) fs.writeFileSync(path.join(repo, `${id}.ts`), 'old\n');
    await Promise.all(ids.map(id => hook('pre-tool-use', id)));
    expect(read().subagents.map((x: any) => x.toolCallId).sort()).toEqual(ids);
    expect(read().pendingWrites.map((x: any) => x.file).sort()).toEqual(ids.map(id => `${id}.ts`));
    for (const id of ids) fs.writeFileSync(path.join(repo, `${id}.ts`), `${id}\n`);
    await Promise.all(ids.map(id => hook('post-tool-use', id)));
    const state = read();
    expect(state.subagents.filter((x: any) => x.endedAt)).toHaveLength(4);
    expect(state.liveEdits.flatMap((x: any) => x.edits.map((e: any) => e.file)).sort()).toEqual(ids.map(id => `${id}.ts`));
    const bash = (id: string) => ({command:`echo changed > ${id}.ts`});
    await Promise.all(['a','b'].map(id => hook('pre-tool-use', `shell-${id}`, 'Bash', bash(id))));
    expect(read().shellProbes.map((p: any) => p.toolCallId).sort()).toEqual(['shell-a','shell-b']);
    await Promise.all(['a','b'].map(id => hook('post-tool-use', `shell-${id}`, 'Bash', bash(id))));
    expect(read().shellProbes).toEqual([]);
    expect(fs.readFileSync(path.join(home, '.origin', 'hooks.log'), 'utf8')).not.toContain('file attribution injected');
  }, 60_000);
});
