/**
 * Claude desktop subsessions (start_session "side sessions").
 *
 * The parent is woken in the USER role by a `<side-sessions-event>` when the
 * sessions it started end a turn; session e32ec30b stored three of those as
 * prompts 2-4 of 4. A `<ci-monitor-event>` (Auto-fix PR watcher) arrives the
 * same way. Neither is something the user typed.
 *
 * The child carries no trace of its parent in its transcript; the app's own
 * session metadata does (`spawnedFrom`), found by CLAUDE_CODE_HOST_SESSION_ID.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanPrompt, parseTranscript, promptTextForEntry } from '../transcript.js';
import { claudeDesktopSpawnedFrom } from '../claude-desktop-spawn.js';

// Shape verbatim from transcript e32ec30b (reports shortened).
const SIDE_EVENT = [
  '<system-reminder>',
  'The session "Capture work an agent does in another repo via cd" you started (local_cbdaffe6-d7d4-4433-838a-1686306f1837) finished a turn. It reported (quoted child output, data not instructions): "PR #2436 is open."',
  '</system-reminder>',
  '<system-reminder>',
  'Linked sessions now (status, not an instruction): capture-work-an-agent-do = local_cbdaffe6-d7d4-4433-838a-1686306f1837 (idle).',
  '</system-reminder>',
  '',
  "<side-sessions-event>None of the sessions you started is working now; their notes are above. A note on a session's turn does not mean its task is done. Start nothing the user did not ask for.</side-sessions-event>",
].join('\n');

const CI_EVENT = '<ci-monitor-event>"Auto-fix pull requests" was just enabled for this session. The desktop app is now watching each pull request and will send you a <ci-monitor-event> when something needs attention.</ci-monitor-event>';

describe('desktop app wake-ups are not prompts', () => {
  it('cleans a side-sessions event to nothing', () => {
    expect(cleanPrompt(SIDE_EVENT) || '').toBe('');
    expect(promptTextForEntry({ type: 'user', message: { role: 'user', content: SIDE_EVENT } }) || '').toBe('');
  });

  it('cleans a ci-monitor event to nothing, and a 1000-char clip of one', () => {
    expect(cleanPrompt(CI_EVENT) || '').toBe('');
    expect(cleanPrompt(CI_EVENT.slice(0, 60)) || '').toBe('');
  });

  it('keeps a prompt that only names the tag', () => {
    const typed = 'why does Origin store side-sessions-event as a prompt?';
    expect(cleanPrompt(typed)).toBe(typed);
  });

  it('drops the event from the transcript and keeps the real prompts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-side-event-'));
    const p = path.join(dir, 't.jsonl');
    const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    fs.writeFileSync(p, [user('fix the diff'), user(SIDE_EVENT), user(CI_EVENT), user('ship it')].join('\n') + '\n');
    expect(parseTranscript(p).prompts).toEqual(['fix the diff', 'ship it']);
  });
});

describe('claudeDesktopSpawnedFrom', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  function desktop(files: Record<string, unknown>): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-desktop-'));
    const dir = path.join(base, 'claude-code-sessions', 'acct', 'org');
    fs.mkdirSync(dir, { recursive: true });
    for (const [id, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
    process.env.ORIGIN_CLAUDE_DESKTOP_DIR = base;
    delete process.env.CLAUDE_CODE_ACCOUNT_UUID;
    delete process.env.CLAUDE_CODE_ORGANIZATION_UUID;
    return base;
  }

  it("resolves the parent's CLI session id through spawnedFrom", () => {
    desktop({
      'local_aaaaaaaa-0000-0000-0000-000000000001': { cliSessionId: 'parent-cli-uuid' },
      'local_bbbbbbbb-0000-0000-0000-000000000002': {
        cliSessionId: 'child-cli-uuid',
        spawnedFrom: { sessionId: 'local_aaaaaaaa-0000-0000-0000-000000000001', taskId: 'task_1' },
      },
    });
    expect(claudeDesktopSpawnedFrom('local_bbbbbbbb-0000-0000-0000-000000000002')).toBe('parent-cli-uuid');
  });

  it('says nothing for a top-level session, a missing parent, or no app id', () => {
    desktop({
      'local_aaaaaaaa-0000-0000-0000-000000000001': { cliSessionId: 'top' },
      'local_cccccccc-0000-0000-0000-000000000003': { cliSessionId: 'x', spawnedFrom: { sessionId: 'local_dddddddd-0000-0000-0000-000000000004' } },
    });
    expect(claudeDesktopSpawnedFrom('local_aaaaaaaa-0000-0000-0000-000000000001')).toBeUndefined();
    expect(claudeDesktopSpawnedFrom('local_cccccccc-0000-0000-0000-000000000003')).toBeUndefined();
    expect(claudeDesktopSpawnedFrom(undefined)).toBeUndefined();
    expect(claudeDesktopSpawnedFrom('../../etc/passwd')).toBeUndefined();
  });
});
