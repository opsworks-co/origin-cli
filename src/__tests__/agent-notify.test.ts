import { describe, it, expect, vi } from 'vitest';
import {
  handleAgentNotificationHook, notifyTurnFinishedOnDesktop, waitingTitle, NOTIFY_TIMEOUT_MS, type NotifyDeps,
} from '../agent-notify.js';
import { desktopNotificationCommand } from '../session-limits.js';
import { HOOK_CONFIG_SPECS } from '../commands/enable.js';

function deps(over: Partial<NotifyDeps> = {}): NotifyDeps & { post: ReturnType<typeof vi.fn>; desktop: ReturnType<typeof vi.fn> } {
  return {
    findSession: vi.fn(() => ({ sessionId: 'sess-1' })),
    connected: () => true,
    desktopEnabled: () => false,
    post: vi.fn(async () => ({ ok: true })),
    desktop: vi.fn(),
    ...over,
  } as any;
}

const payload = { session_id: 'claude-abc', cwd: '/w/app', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' };

describe('Claude Code Notification hook → agent_waiting', () => {
  it('forwards message and type for the Origin session, with a short timeout', async () => {
    const d = deps();
    const r = await handleAgentNotificationHook(payload, d);
    expect(r).toEqual({ forwarded: true, desktop: false });
    expect(d.findSession).toHaveBeenCalledWith('claude-abc', '/w/app');
    expect(d.post).toHaveBeenCalledWith('sess-1', { message: payload.message, notificationType: 'permission_prompt' }, NOTIFY_TIMEOUT_MS);
    expect(NOTIFY_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(d.desktop).not.toHaveBeenCalled();
  });

  it('never throws or waits on a failing / hanging server beyond its own timeout', async () => {
    const d = deps({ post: vi.fn(async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); }) });
    await expect(handleAgentNotificationHook(payload, d)).resolves.toEqual({ forwarded: false, desktop: false });
  });

  it('skips the network for standalone mode, a provisional session or no session', async () => {
    for (const d of [
      deps({ connected: () => false }),
      deps({ findSession: () => ({ sessionId: 'local-abc123' }) }),
      deps({ findSession: () => null }),
    ]) {
      expect((await handleAgentNotificationHook(payload, d)).forwarded).toBe(false);
      expect(d.post).not.toHaveBeenCalled();
    }
  });

  it('shows a desktop notification only when opted in — even offline', async () => {
    const d = deps({ desktopEnabled: () => true, connected: () => false });
    const r = await handleAgentNotificationHook(payload, d);
    expect(r.desktop).toBe(true);
    expect(d.desktop).toHaveBeenCalledWith('Your agent needs permission', payload.message);
    expect(waitingTitle('idle_prompt', 'Claude is waiting for your input')).toBe('Your agent is waiting for you');
  });

  it('is installed for Claude Code, so the upgrade-time drift repair adds it', () => {
    const claude = HOOK_CONFIG_SPECS.find((s) => s.agent === 'claude-code')!;
    const events = claude.expected() as Record<string, any[]>;
    expect(JSON.stringify(events.Notification)).toContain('hooks claude-code notification');
  });
});

describe('Stop → desktop "agent finished"', () => {
  const base = { repoPath: '/w/app', branch: 'feat/x', headBefore: 'a'.repeat(40), headAfter: 'b'.repeat(40) };
  const d = (enabled = true) => ({ desktopEnabled: () => enabled, desktop: vi.fn(), isDefaultBranch: (b: string) => b === 'main' });

  it('fires when the turn committed on a feature branch', () => {
    const x = d();
    expect(notifyTurnFinishedOnDesktop(base, x)).toBe(true);
    expect(x.desktop).toHaveBeenCalledWith('Your agent finished', 'New commits on feat/x, ready for review');
  });

  it('stays quiet when off, on the default branch, detached, or with no new commit', () => {
    expect(notifyTurnFinishedOnDesktop(base, d(false))).toBe(false);
    expect(notifyTurnFinishedOnDesktop({ ...base, branch: 'main' }, d())).toBe(false);
    expect(notifyTurnFinishedOnDesktop({ ...base, branch: 'HEAD' }, d())).toBe(false);
    expect(notifyTurnFinishedOnDesktop({ ...base, headAfter: base.headBefore }, d())).toBe(false);
  });
});

describe('desktopNotificationCommand argv per platform', () => {
  const title = 'Say "hi" \\ there';
  const body = 'it\'s $(rm -rf ~) `x`';

  it('macOS: one osascript -e argument with AppleScript-escaped literals', () => {
    const c = desktopNotificationCommand(title, body, 'darwin')!;
    expect(c.file).toBe('osascript');
    expect(c.args).toEqual(['-e', 'display notification "it\'s $(rm -rf ~) `x`" with title "Say \\"hi\\" \\\\ there"']);
  });

  it('Linux: notify-send with the text as plain argv after --', () => {
    const c = desktopNotificationCommand('-t evil', body, 'linux')!;
    expect(c).toMatchObject({ file: 'notify-send', args: ['--', '-t evil', body] });
  });

  it('Windows: a hidden PowerShell balloon with single-quoted literals', () => {
    const c = desktopNotificationCommand(title, body, 'win32')!;
    expect(c.file).toBe('powershell');
    expect(c.opts.windowsHide).toBe(true);
    expect(c.args.at(-1)).toContain("'it''s $(rm -rf ~) `x`'");
  });

  it('nothing elsewhere', () => {
    expect(desktopNotificationCommand('a', 'b', 'aix')).toBeNull();
  });
});
