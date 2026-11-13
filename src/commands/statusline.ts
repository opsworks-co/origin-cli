// Claude Code's plan limits — how much of the 5-hour and weekly windows a
// Pro/Max subscription has used. Claude Code hands them to exactly one place:
// the status line command's stdin (`rate_limits`, documented at
// code.claude.com/docs/en/statusline). Hooks and transcripts don't carry them.
//
// So `origin enable` (and `origin upgrade`, for machines already enabled) makes
// Claude Code run `origin statusline` as its status line. Each run saves the
// windows to a small file and then runs the status line the user already had,
// if any, printing its output — the line on screen doesn't change.
// `origin statusline --uninstall` puts theirs back and keeps it that way. The Stop hook sends the saved windows up with
// the turn (see planLimitsForStop), the same way Codex's are sent.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';

// Resolved at call time, like the hook installers, so a test's HOME holds.
const originDir = () => path.join(os.homedir(), '.origin');
const limitsFile = () => path.join(originDir(), 'plan-limits', 'claude-code.json');
// The status line that was configured before ours, run after ours.
const chainedFile = () => path.join(originDir(), 'claude-statusline-chain.json');
// Present once the user has uninstalled ours: enable and upgrade leave it off.
const optOutFile = () => path.join(originDir(), 'claude-statusline-off');
const settingsFile = () => path.join(os.homedir(), '.claude', 'settings.json');
const STATUSLINE_CMD = 'origin statusline';

export interface PlanLimits {
  planType?: string;
  capturedAt: string;
  windows: Array<{ usedPercent: number; windowMinutes?: number; resetsAt?: string }>;
}

const WINDOWS: Array<[string, number]> = [['five_hour', 300], ['seven_day', 10080]];

/** The windows in a status line payload, or undefined (API-key login, no reply yet). */
export function claudePlanLimits(input: unknown, now: Date = new Date()): PlanLimits | undefined {
  const rl = (input as any)?.rate_limits;
  if (!rl || typeof rl !== 'object') return undefined;
  const windows: PlanLimits['windows'] = [];
  for (const [name, minutes] of WINDOWS) {
    const w = rl[name];
    const used = Number(w?.used_percentage);
    if (!w || !Number.isFinite(used)) continue;
    const resets = Number(w.resets_at);
    windows.push({
      usedPercent: used,
      windowMinutes: minutes,
      ...(Number.isFinite(resets) && resets > 0 && { resetsAt: new Date(resets * 1000).toISOString() }),
    });
  }
  return windows.length > 0 ? { capturedAt: now.toISOString(), windows } : undefined;
}

/**
 * The plan tier, from Claude Code's account record in ~/.claude.json
 * (`oauthAccount.organizationRateLimitTier`, e.g. "default_claude_max_20x").
 * Not a documented field, so best effort: anything unexpected is no tier.
 */
export function claudePlanType(account: unknown): string | undefined {
  const a = (account as any)?.oauthAccount;
  const tier = typeof a?.organizationRateLimitTier === 'string' ? a.organizationRateLimitTier : '';
  const max = tier.match(/max_(\d+x)/);
  if (max) return `max_${max[1]}`;
  const org = typeof a?.organizationType === 'string' ? a.organizationType.replace(/^claude_/, '') : '';
  return /^[a-z_]{1,20}$/.test(org) ? org : undefined;
}

/** The saved windows plus the plan tier, for the Stop hook's upload. */
export function planLimitsForStop(): (PlanLimits & { agent: string }) | undefined {
  let saved: PlanLimits;
  try { saved = JSON.parse(fs.readFileSync(limitsFile(), 'utf-8')); } catch { return undefined; }
  if (!saved?.capturedAt || !Array.isArray(saved.windows)) return undefined;
  let planType: string | undefined;
  try { planType = claudePlanType(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'))); } catch { /* no tier */ }
  return { agent: 'claude-code', ...saved, ...(planType && { planType }) };
}

function readStdin(): string {
  try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
}

/** What Claude Code runs on every status line refresh. Never fails loudly. */
export function statuslineCommand(): void {
  const raw = readStdin();
  try {
    const limits = claudePlanLimits(JSON.parse(raw));
    if (limits) {
      fs.mkdirSync(path.dirname(limitsFile()), { recursive: true });
      fs.writeFileSync(limitsFile(), JSON.stringify(limits));
    }
  } catch { /* not JSON, or no limits: nothing to save */ }

  let chained: { command?: string } | undefined;
  try { chained = JSON.parse(fs.readFileSync(chainedFile(), 'utf-8')); } catch { return; }
  if (!chained?.command) return;
  const out = spawnSync(chained.command, { shell: true, input: raw, encoding: 'utf-8', timeout: 5000 });
  if (out.stdout) process.stdout.write(out.stdout);
}

// null when the file is there but isn't JSON: rewriting it would wipe it.
function readSettings(): Record<string, any> | null {
  let raw: string;
  try { raw = fs.readFileSync(settingsFile(), 'utf-8'); } catch { return {}; }
  try { return JSON.parse(raw); } catch { return null; }
}

function writeSettings(settings: Record<string, any>): void {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2) + '\n');
}

// The whole command must be one of the shapes originCmd('origin statusline') writes, anchored at both ends:
//   - POSIX: `origin statusline`, or the `PATH="<binDir>:$PATH" origin statusline` shim (old unquoted too);
//   - Windows shim: `[<dir>\]origin[.cmd|.exe] statusline`, the path bare or in double quotes;
//   - Windows node: `<node[.exe]> <…\dist\index.js> statusline` — the CLI's own entry (package.json `bin`).
// A substring test claimed `my-origin statusline`, `echo origin statusline` or
// `node /opt/foreign-origin-helper.js statusline`, and `disable --global` then removed a status line that
// was not Origin's. The hook matcher (ORIGIN_HOOK_COMMAND_TAIL) is not reused: it is unanchored and accepts
// any `.js` script, which is exactly the false positive this has to refuse.
const WIN_DIR = String.raw`(?:"[^"]*[\\/]|[^\s"]*[\\/])`;
const ORIGIN_STATUSLINE_COMMAND = new RegExp(
  '^(?:'
    + String.raw`(?:PATH=(?:"(?:[^"\\]|\\.)*"|\S+)\s+)?origin`
    + '|' + String.raw`(?:"[^"]*[\\/]origin(?:\.cmd|\.exe)?"|${WIN_DIR}?origin(?:\.cmd|\.exe)?)`
    + '|' + String.raw`(?:"[^"]*[\\/]node(?:\.exe)?"|${WIN_DIR}?node(?:\.exe)?)\s+`
    + String.raw`(?:"[^"]*[\\/]dist[\\/]index\.js"|[^\s"]*[\\/]dist[\\/]index\.js)`
    + String.raw`)\s+statusline\s*$`,
  'i',
);

export const isOriginStatusLineCommand = (command: unknown): boolean =>
  typeof command === 'string' && ORIGIN_STATUSLINE_COMMAND.test(command);

const isOurs = (sl: any) => isOriginStatusLineCommand(sl?.command);

/**
 * Make `command` (originCmd('origin statusline')) Claude Code's status line,
 * keeping the user's own to run after it. Does nothing when it is already
 * ours, when the user turned it off, or when settings.json is unreadable.
 * Returns whether it changed anything.
 */
export function ensureStatusLine(command: string, opts: { force?: boolean } = {}): boolean {
  if (opts.force) fs.rmSync(optOutFile(), { force: true });
  else if (fs.existsSync(optOutFile())) return false;
  const settings = readSettings();
  if (!settings || isOurs(settings.statusLine)) return false;
  fs.mkdirSync(originDir(), { recursive: true });
  if (settings.statusLine?.command) fs.writeFileSync(chainedFile(), JSON.stringify(settings.statusLine));
  else fs.rmSync(chainedFile(), { force: true });
  settings.statusLine = { ...(settings.statusLine || {}), type: 'command', command };
  writeSettings(settings);
  return true;
}

export async function installStatusLine(): Promise<void> {
  // enable.js is heavy; only the install needs it, not every status line run.
  const { originCmd } = await import('./enable.js');
  if (readSettings() === null) {
    console.log(chalk.yellow('  ~/.claude/settings.json is not valid JSON; fix it and run this again.'));
    return;
  }
  if (!ensureStatusLine(originCmd(STATUSLINE_CMD), { force: true })) {
    console.log(chalk.gray('  Origin already reads Claude Code plan limits.'));
    return;
  }
  console.log(chalk.green('  ✓ Origin now reads Claude Code plan limits (via the status line)'));
  if (fs.existsSync(chainedFile())) console.log(chalk.gray('    Your status line still shows; Origin runs it after saving the limits.'));
}

/**
 * Take Origin off Claude Code's status line, putting back the one it chained
 * (if any). A status line that isn't Origin's is left alone. Records no
 * opt-out — that is uninstallStatusLine's choice; `disable --global` uses this
 * so a later `enable` installs it again. Returns what it did.
 */
export function removeOriginStatusLine(): 'restored' | 'removed' | 'none' {
  const settings = readSettings();
  if (!settings || !isOurs(settings.statusLine)) return 'none';
  let chained: Record<string, any> | undefined;
  try { chained = JSON.parse(fs.readFileSync(chainedFile(), 'utf-8')); } catch { /* none */ }
  if (chained?.command) settings.statusLine = chained;
  else delete settings.statusLine;
  writeSettings(settings);
  fs.rmSync(chainedFile(), { force: true });
  return chained?.command ? 'restored' : 'removed';
}

export function uninstallStatusLine(): void {
  // Remember the choice first, so enable and upgrade don't put it back.
  fs.mkdirSync(originDir(), { recursive: true });
  fs.writeFileSync(optOutFile(), '');
  const result = removeOriginStatusLine();
  if (result === 'none') {
    console.log(chalk.gray('  Origin is not the Claude Code status line; it will stay off.'));
    return;
  }
  console.log(chalk.green(`  ✓ Removed; ${result === 'restored' ? 'your previous status line is back' : 'no status line configured'}`));
}
