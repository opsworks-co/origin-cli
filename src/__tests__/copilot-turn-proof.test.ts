// OR-45 checkpoint 3C.1 (G2): post-commit attests a running Copilot turn only
// on what that turn's own events.jsonl proves — a successful, content-bearing
// edit of a path the commit changed, or the still-open `git commit` call.
// Everything else leaves the commit "(no active turn)".
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { copilotRunningTurnProof, gitCommitDirChains } from '../copilot-turn-proof.js';
import { copilotCommandCommitsCheckout, copilotRunningTurnMadeCommit } from '../commands/hooks/post-commit.js';

const REPO = '/work/repo';
const PROMPT = 'make it say hello';
const COMMITTING = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/;

const user = (content: string) => ({ type: 'user.message', data: { content } });
const start = (toolCallId: string | undefined, toolName: string, args: Record<string, unknown>) =>
  ({ type: 'tool.execution_start', data: { ...(toolCallId && { toolCallId }), toolName, arguments: args } });
const done = (toolCallId: string, data: Record<string, unknown>) => ({ type: 'tool.execution_complete', data: { toolCallId, ...data } });
const edit = (id: string, file = 'src/app.py') => start(id, 'edit', { path: `${REPO}/${file}`, old_str: 'old', new_str: 'new' });
const bash = (id: string, command: string) => start(id, 'bash', { command, description: 'run' });
const log = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
// The checkout predicate is post-commit's and needs real repositories; the
// signal tests below only need "this command commits here".
const prove = (
  events: unknown[] | string,
  over: Partial<{ runningPrompt: string; commitFiles: string[]; commitsThisCheckout: (c: string, earlier: readonly string[]) => boolean }> = {},
) =>
  copilotRunningTurnProof(typeof events === 'string' ? events : log(events), {
    repoPath: REPO, runningPrompt: PROMPT, commitFiles: ['src/app.py'], commitsThisCheckout: (c) => COMMITTING.test(c), ...over,
  });

describe('copilotRunningTurnProof — the proof signals', () => {
  it('a successful edit of an exact committed path', () => {
    expect(prove([user(PROMPT), edit('c1'), done('c1', { success: true })])).toEqual({ proven: true, signal: 'successful_edit' });
  });

  it('a successful create or apply_patch of an exact committed path', () => {
    expect(prove([user(PROMPT), start('c1', 'create', { path: `${REPO}/src/app.py`, file_text: 'x\n' }), done('c1', { success: true })]).proven).toBe(true);
    const patch = `*** Begin Patch\n*** Update File: ${REPO}/src/app.py\n@@\n-old\n+new\n*** End Patch\n`;
    const charIndexed = Object.fromEntries([...patch].map((ch, i) => [String(i), ch]));
    expect(prove([user(PROMPT), start('c1', 'apply_patch', charIndexed), done('c1', { success: true })]).proven).toBe(true);
  });

  it('the current prompt\'s still-open bash call that commits this checkout', () => {
    for (const command of ['git commit -m "x"', 'git add -A && git commit -qm x']) {
      expect(prove([user(PROMPT), bash('b1', command)]), command).toEqual({ proven: true, signal: 'open_commit_call' });
    }
    // The checkout predicate decides, and sees every bash command run before, in any prompt.
    const seen: string[][] = [];
    const verdict = prove([user('earlier'), bash('b0', 'ls'), done('b0', { success: true }), user(PROMPT), bash('b1', 'git commit -m x')], {
      commitsThisCheckout: (_c, earlier) => { seen.push([...earlier]); return false; },
    });
    expect(verdict).toEqual({ proven: false, reason: 'no_signal' });
    expect(seen).toEqual([['ls']]);
  });

  it('matches the prompt through Copilot\'s envelopes', () => {
    const wrapped = `<copilot_tauri_workspace>\n/work/repo\n</copilot_tauri_workspace>\n${PROMPT}`;
    expect(prove([user(PROMPT), edit('c1'), done('c1', { success: true })], { runningPrompt: wrapped }).proven).toBe(true);
  });
});

describe('copilotRunningTurnProof — everything else is no proof', () => {
  it('a failed, aborted, unknown or both-ways edit', () => {
    const tails: unknown[][] = [
      [done('c1', { success: false, error: { message: 'No match found' } })],
      [{ type: 'abort', data: { reason: 'user_initiated' } }],
      [],
      [done('c1', {})],
      [done('c1', { success: 'true' })],
      [done('c1', { success: true }), done('c1', { success: false })],
      [done('other', { success: true })],
    ];
    for (const tail of tails) {
      expect(prove([user(PROMPT), edit('c1'), ...tail]), JSON.stringify(tail)).toEqual({ proven: false, reason: 'no_signal' });
    }
    // No toolCallId: no verdict can be joined to it.
    expect(prove([user(PROMPT), start(undefined, 'edit', { path: `${REPO}/src/app.py`, old_str: 'old', new_str: 'new' })]).proven).toBe(false);
  });

  it('an edit that carried no content', () => {
    expect(prove([user(PROMPT), start('c1', 'create', { path: `${REPO}/src/app.py` }), done('c1', { success: true })]).proven).toBe(false);
    expect(prove([user(PROMPT), start('c1', 'edit', { path: `${REPO}/src/app.py`, new_str: 'new' }), done('c1', { success: true })]).proven).toBe(false);
  });

  it('a previous prompt\'s edit or open commit call', () => {
    expect(prove([user('earlier'), edit('c1'), done('c1', { success: true }), user(PROMPT)]).proven).toBe(false);
    expect(prove([user('earlier'), bash('b1', 'git commit -m x'), user(PROMPT)]).proven).toBe(false);
  });

  it('a same-named file in another directory, a different file, a path outside the repo', () => {
    expect(prove([user(PROMPT), edit('c1', 'lib/app.py'), done('c1', { success: true })]).proven).toBe(false);
    expect(prove([user(PROMPT), edit('c1', 'src/other.py'), done('c1', { success: true })]).proven).toBe(false);
    expect(prove([user(PROMPT), start('c1', 'edit', { path: '/elsewhere/src/app.py', old_str: 'old', new_str: 'new' }), done('c1', { success: true })]).proven).toBe(false);
  });

  it('a finished, failed or non-committing bash call', () => {
    expect(prove([user(PROMPT), bash('b1', 'git commit -m x'), done('b1', { success: true })]).proven).toBe(false);
    expect(prove([user(PROMPT), bash('b1', 'git commit -m x'), done('b1', { success: false })]).proven).toBe(false);
    expect(prove([user(PROMPT), bash('b1', 'git status && echo commit')]).proven).toBe(false);
    expect(prove([user(PROMPT), start(undefined, 'bash', { command: 'git commit -m x' })]).proven).toBe(false);
  });

  it('a torn log, wherever the torn line is', () => {
    const good = log([user(PROMPT), edit('c1'), done('c1', { success: true })]);
    expect(prove(good + '{"type":"tool.execution_st')).toEqual({ proven: false, reason: 'torn_log' });
    expect(prove('{"type":"user.mes\n' + good)).toEqual({ proven: false, reason: 'torn_log' });
  });

  it('two long prompts sharing their first 200 characters are two prompts', () => {
    // promptKey keeps 200 characters; the proof compares the whole text.
    const head = 'Refactor the payment module so that '.repeat(8);
    expect(head.length).toBeGreaterThan(200);
    const first = `${head}and keep the old API.`;
    const second = `${head}and drop the old API entirely.`;
    const events = [user(first), user(second), edit('c1'), done('c1', { success: true })];
    // State still names the first prompt (the detached submit has not caught up): the second's edit opens nothing.
    expect(prove(events, { runningPrompt: first })).toEqual({ proven: false, reason: 'other_prompt' });
    expect(prove(events, { runningPrompt: second })).toEqual({ proven: true, signal: 'successful_edit' });
    // A stored prompt that was clipped is not the prompt.
    expect(prove(events, { runningPrompt: second.slice(0, 200) })).toEqual({ proven: false, reason: 'other_prompt' });
    // Whitespace alone does not make a prompt different.
    expect(prove(events, { runningPrompt: `  ${second.replace(/ /g, '\n  ')}  ` }).proven).toBe(true);
  });

  it('no prompt in the log, or a last prompt that is not the running one', () => {
    expect(prove([edit('c1'), done('c1', { success: true })])).toEqual({ proven: false, reason: 'no_prompt' });
    expect(prove([user(PROMPT), edit('c1'), done('c1', { success: true }), user('a newer prompt')])).toEqual({ proven: false, reason: 'other_prompt' });
    expect(prove([user(PROMPT), edit('c1'), done('c1', { success: true })], { runningPrompt: '' })).toEqual({ proven: false, reason: 'other_prompt' });
  });
});

describe('copilotRunningTurnMadeCommit — post-commit\'s Copilot-only reader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-copilot-proof-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(events, log([user(PROMPT), edit('c1'), done('c1', { success: true })]));
  const state = (over: Record<string, unknown> = {}) => ({ agentSlug: 'copilot', transcriptPath: events, prompts: ['earlier', PROMPT], ...over });

  it('proves the running turn from a readable log', () => {
    expect(copilotRunningTurnMadeCommit(state(), 1, REPO, ['src/app.py'])).toBe(true);
  });

  it('touches no other agent, and fails closed', () => {
    for (const agentSlug of ['claude-code', 'cursor', 'gemini', 'codex', undefined]) {
      expect(copilotRunningTurnMadeCommit(state({ agentSlug }), 1, REPO, ['src/app.py']), String(agentSlug)).toBe(false);
    }
    expect(copilotRunningTurnMadeCommit(state({ transcriptPath: path.join(dir, 'missing.jsonl') }), 1, REPO, ['src/app.py'])).toBe(false);
    expect(copilotRunningTurnMadeCommit(state({ transcriptPath: dir }), 1, REPO, ['src/app.py'])).toBe(false);
    expect(copilotRunningTurnMadeCommit(state({ transcriptPath: undefined }), 1, REPO, ['src/app.py'])).toBe(false);
    // The log's last prompt is not the running one.
    expect(copilotRunningTurnMadeCommit(state(), 0, REPO, ['src/app.py'])).toBe(false);
    expect(copilotRunningTurnMadeCommit(state(), 1, REPO, ['lib/app.py'])).toBe(false);
  });
});

describe('the open bash call must commit THIS checkout', () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-copilot-target-')));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const initRepo = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  };
  const current = path.join(tmp, 'current');
  const other = path.join(tmp, 'other');
  initRepo(current);
  initRepo(other);
  const commits = (command: string, earlier: string[] = [], shellTree = current) =>
    copilotCommandCommitsCheckout(command, earlier, { shellTree, repoPath: current });

  it('accepts a commit where the shell stands, or through an absolute -C into this checkout', () => {
    expect(commits('git commit -m x')).toBe(true);
    expect(commits('git add -A && git commit -qm x')).toBe(true);
    expect(commits(`git -C ${current} commit -m x`)).toBe(true);
    expect(commits(`git -C "${path.join(current, 'sub')}" commit -m x`)).toBe(true);
    expect(commits(`git -C ${other} -C ${current} commit -m x`)).toBe(true); // the last absolute -C wins
  });

  it('refuses a command that only mentions a commit, or runs some other program', () => {
    for (const command of [
      'echo "git commit -m x"',
      'echo git commit -m x',
      `echo "git -C ${current} commit -m x"`,
      'printf "%s\\n" "git commit -m x"',
      'printf "git commit\\n"',
      'my-git commit -m x',
      `my-git -C ${current} commit -m x`,
      'git status && echo "git commit"',
    ]) {
      expect(commits(command), command).toBe(false);
    }
    // The real ones still count.
    expect(commits('git commit -m x')).toBe(true);
    expect(commits(`git -C ${current} commit -m x`)).toBe(true);
  });

  it('refuses another checkout, by -C or by cd', () => {
    expect(commits(`git -C ${other} commit -m x`)).toBe(false);
    expect(commits(`cd ${other} && git commit -m x`)).toBe(false);
    expect(commits(`git -C ${current} commit -m x && git -C ${other} commit -m y`)).toBe(false);
    expect(commits('git commit -m x', [], other)).toBe(false);
  });

  it('refuses a target the text cannot settle', () => {
    for (const command of [
      `cd ${current} && git commit -m x`,             // narrow: no cd at all
      `(cd ${path.join(current, 'sub')}; git commit -m x)`,
      `pushd ${current} && git commit -m x`,
      'git -C sub commit -m x',                        // relative: from a directory nobody reported
      'git -C $REPO commit -m x',
      'git -C ~/current commit -m x',
      `GIT_DIR=${other}/.git git commit -m x`,
      `git --work-tree=${other} commit -m x`,
      `git --git-dir=${other}/.git commit -m x`,
      `git -C ${path.join(tmp, 'missing')} commit -m x`,
      `git -C ${current} status`,                      // not a commit
    ]) {
      expect(commits(command), command).toBe(false);
    }
    // The shell persists: an earlier cd, in any prompt, leaves its directory unknown.
    expect(commits('git commit -m x', [`cd ${other}`])).toBe(false);
    expect(commits(`git -C ${current} commit -m x`, ['ls', 'cd sub'])).toBe(false);
  });

  it('reads the -C chain of every commit, or none when it cannot', () => {
    expect(gitCommitDirChains('git commit -m x')).toEqual([[]]);
    expect(gitCommitDirChains(`git -C '${current}' commit && git commit`)).toEqual([[current], []]);
    expect(gitCommitDirChains('git status')).toBeNull();
    expect(gitCommitDirChains('cd x && git commit')).toBeNull();
  });

  it('post-commit end to end: an open `git -C <other> commit` proves nothing, `git -C <this> commit` does', () => {
    const events = path.join(tmp, 'events.jsonl');
    const state = { agentSlug: 'copilot', transcriptPath: events, prompts: [PROMPT], repoPath: current };
    fs.writeFileSync(events, log([user(PROMPT), bash('b1', `git -C ${other} commit -m x`)]));
    expect(copilotRunningTurnMadeCommit(state, 0, current, ['a.txt'])).toBe(false);
    fs.writeFileSync(events, log([user(PROMPT), bash('b1', `git -C ${current} commit -m x`)]));
    expect(copilotRunningTurnMadeCommit(state, 0, current, ['a.txt'])).toBe(true);
    fs.writeFileSync(events, log([user(PROMPT), bash('b1', `cd ${other} && git commit -m x`)]));
    expect(copilotRunningTurnMadeCommit(state, 0, current, ['a.txt'])).toBe(false);
  });
});
