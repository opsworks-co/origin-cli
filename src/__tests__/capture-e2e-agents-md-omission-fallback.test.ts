// The built CLI, a Claude Code session in a repo whose AGENTS.md carries
// Origin's framework and no CLAUDE.md. Session start leaves the framework out
// of the hook on the PREDICTION that Claude reads AGENTS.md (#2050). Claude Code
// can switch that loading off remotely, and then the session had the framework
// from neither place (TODO 1c996240).
//
// The transcript says what was loaded: an `instructions` attachment before the
// first reply. When the reply came without AGENTS.md in it, the second prompt's
// hook delivers what was left out, and the answer is kept so the next session
// start does not leave it out again.
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFiles, createHarness, haveDist, type Harness } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const M = '<!-- origin-managed -->';
const FRAMEWORK = 'Origin authoring framework —';
const T = 90_000 * WINDOWS_SLOWDOWN;
const CLAUDE_286 = '/Applications/Claude.app/claude-code/2.1.286/abc/claude';
const observation = () => path.join(os.homedir(), '.origin', 'claude-agents-md.json');

const setup = async (id: string): Promise<Harness> => {
  const h = await createHarness(`agents-md-omission-${id}`, `agents-md-omission-server-${id}`);
  commitFiles(h, { 'AGENTS.md': `# Use pnpm\n\n${M}\n${FRAMEWORK} emit markers.\n${M}\n` }, 'base');
  return h;
};
const firstTurn = async (h: Harness, loaded: boolean) => {
  const s = await h.run('session-start', { source: 'startup' });
  expect(s.code, s.stderr).toBe(0);
  expect(s.stdout, 'session start predicted AGENTS.md is read and left the framework out').not.toContain(FRAMEWORK);
  h.say('first');
  const first = await h.run('user-prompt-submit', { prompt: 'first' });
  expect(first.code, first.stderr).toBe(0);
  if (loaded) {
    h.transcriptEntry({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: path.join(h.repo, 'AGENTS.md'), type: 'Project', content: '# Use pnpm' }] } });
  }
  h.reply('Done.');
  const stop = await h.run('stop', { stop_hook_active: false });
  expect(stop.code, stop.stderr).toBe(0);
  h.say('second');
  const second = await h.run('user-prompt-submit', { prompt: 'second' });
  expect(second.code, second.stderr).toBe(0);
  return second.stdout;
};

describe.skipIf(!haveDist)('context left out for AGENTS.md', () => {
  beforeEach(() => {
    process.env.CLAUDE_CODE_EXECPATH = CLAUDE_286;
    fs.rmSync(observation(), { force: true });
  });

  it('is delivered on the next prompt when Claude did not load AGENTS.md, and the next start stops leaving it out', async () => {
    const h = await setup('0001');
    try {
      expect(await firstTurn(h, false)).toContain(FRAMEWORK);
      expect(JSON.parse(fs.readFileSync(observation(), 'utf-8')).loaded).toBe(false);
      // The next conversation in this checkout gets the framework over the hook.
      expect((await h.sibling('agents-md-omission-0001-next')).startStdout).toContain(FRAMEWORK);
    } finally {
      await h.close();
    }
  }, T);

  it('stays out when the transcript shows Claude loaded AGENTS.md', async () => {
    const h = await setup('0002');
    try {
      expect(await firstTurn(h, true)).not.toContain(FRAMEWORK);
      expect(JSON.parse(fs.readFileSync(observation(), 'utf-8')).loaded).toBe(true);
    } finally {
      await h.close();
    }
  }, T);
});
