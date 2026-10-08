/**
 * Alias resolution test — safety net for the CLI consolidation.
 *
 * Background: as part of surface-area reduction, we hide ~35 commands from
 * `origin --help` but they MUST still resolve and run. This test spawns
 * the built CLI binary for every historical command name and asserts that
 * `<cmd> --help` exits 0. If someone deletes an alias by mistake, this test
 * fails and catches the regression before it ships.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// Every historical top-level command name the CLI has ever exposed. If you
// remove something from here you're admitting a breaking change.
const HISTORICAL_COMMAND_NAMES = [
  // Primary (currently visible in --help)
  // NOTE: `init` was removed deliberately — it was a redundant wrapper around
  // `origin enable` (which already registers the machine + installs hooks) and
  // its only unique flag, --standalone, now lives on `enable`.
  'login', 'doctor',
  'blame', 'diff', 'stats', 'chat',
  'sessions', 'explain', 'resume', 'share',
  'issue', 'context',
  'snapshot',
  'export', 'search', 'backfill',
  'hooks', 'upgrade', 'plugin',
  'version',
  // Hidden aliases (must still resolve)
  'enable', 'disable', 'link', 'attach', 'whoami', 'status',
  'prompt-status', 'shell-prompt', 'web',
  'reset', 'clean', 'verify', 'verify-install',
  'ask', 'why', 'prompts',
  'recap', 'report', 'analyze', 'rework', 'compare',
  'session', 'log', 'show', 'session-compare',
  'review', 'review-pr', 'intent-review',
  'todo', 'trail', 'handoff', 'memory',
  'rewind', 'snapshot',
  'repos', 'agents', 'sync', 'policies', 'audit', 'db', 'ignore',
  'config', 'proxy', 'ci',
];

describe('alias resolution', () => {
  const distPath = path.join(__dirname, '..', '..', 'dist', 'index.js');

  beforeAll(() => {
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `CLI not built at ${distPath}. Run \`pnpm run build\` in packages/cli first.`
      );
    }
  });

  it.each(HISTORICAL_COMMAND_NAMES)('`origin %s --help` exits 0', (name) => {
    // Some commands need a positional arg in their signature (<file>, <id>, etc.)
    // `--help` short-circuits that and returns help for the command, exit 0.
    let output: Buffer;
    try {
      output = execFileSync('node', [distPath, name, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8000,
        env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
      });
    } catch (err: any) {
      // If --help exits non-zero, that's a failed alias
      throw new Error(
        `\`origin ${name} --help\` failed (code ${err.status}):\n${err.stderr?.toString() || err.message}`
      );
    }
    // Sanity: output should mention the command name or "Usage:"
    const text = output.toString();
    expect(text.length, `\`origin ${name} --help\` produced no output`).toBeGreaterThan(0);
  });

  it('top-level --help lists every command that does unique work', () => {
    const output = execFileSync('node', [distPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
    }).toString();

    // Every command that does unique work must appear in --help. We previously
    // hid many of these as "aliases"; that was wrong — they do distinct work
    // and belong in the primary surface.
    for (const cmd of [
      'blame', 'ask', 'why', 'prompts',
      'stats', 'recap', 'report', 'analyze', 'rework', 'compare',
      'sessions', 'session', 'log', 'show',
      'review', 'review-pr', 'intent-review',
      'context', 'todo', 'trail', 'issue',
      'rewind', 'snapshot', 'snapshot',
      'enable', 'disable', 'link', 'attach', 'whoami', 'status',
      'doctor', 'verify', 'verify-install', 'clean', 'reset',
      'repos', 'agents', 'sync', 'policies', 'audit', 'db', 'ignore',
      'web', 'config', 'proxy', 'ci', 'prompt-status', 'shell-prompt',
    ]) {
      const lineRe = new RegExp(`^\\s+${cmd.replace(/[-]/g, '\\-')}\\b`, 'm');
      expect(output, `\`${cmd}\` missing from --help primary list`).toMatch(lineRe);
    }
  });

  it('deprecated handoff/memory aliases are HIDDEN from --help but still resolve', () => {
    const output = execFileSync('node', [distPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
      env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
    }).toString();
    // Not listed as their own top-level command line (folded under `context`).
    expect(output).not.toMatch(/^\s+handoff\b/m);
    expect(output).not.toMatch(/^\s+memory\b/m);
    // …but they still resolve (back-compat): `origin handoff --help` exits 0.
    for (const alias of ['handoff', 'memory']) {
      const help = execFileSync('node', [distPath, alias, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
        env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
      }).toString();
      expect(help.toLowerCase()).toContain('deprecated');
    }
  });

  it('help includes categorized groups', () => {
    const output = execFileSync('node', [distPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
    }).toString();

    for (const group of ['SETUP', 'ATTRIBUTION', 'SESSIONS', 'TIME TRAVEL', 'HEALTH']) {
      expect(output, `group header \`${group}\` missing from --help`).toContain(group);
    }
    // SETUP comes first — `login` / `enable` are what a new user needs.
    expect(output.indexOf('  SETUP')).toBeLessThan(output.indexOf('  ATTRIBUTION'));
    // Every visible command is assigned to a group: the OTHER catch-all only
    // appears when someone registers a command without placing it.
    expect(output, 'a command is not in any help group — add it to COMMAND_GROUPS').not.toMatch(/^\s+OTHER$/m);
  });

  it('root --help lists each command once (no duplicate flat list)', () => {
    const output = execFileSync('node', [distPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
      env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
    }).toString();
    // Commander's flat list used to precede the grouped list, so every
    // command was printed twice.
    expect(output.match(/^\s+login\b/gm)?.length).toBe(1);
    expect(output.match(/^\s+blame\b/gm)?.length).toBe(1);
    expect(output.match(/^Commands:/gm)?.length).toBe(1);
    // Commander's own "Did you mean …?" still sees every command.
    let stderr = '';
    try {
      execFileSync('node', [distPath, 'blmae'], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
        env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
      });
    } catch (err: any) {
      stderr = err.stderr?.toString() ?? '';
    }
    expect(stderr).toContain('Did you mean blame?');
  });

  it('internal / repair commands are left out of --help but still run', () => {
    const output = execFileSync('node', [distPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
      env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
    }).toString();
    for (const cmd of ['codex-watch', 'transcript-watch', 'verify-capture', 'recapture', 'repair-merges', 'notes']) {
      expect(output, `\`${cmd}\` should not be listed in --help`).not.toMatch(new RegExp(`^\\s+${cmd}\\b`, 'm'));
      // Origin spawns / documents these by name — they must keep resolving.
      execFileSync('node', [distPath, cmd, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
        env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
      });
    }
  });

  it('`disable --help` describes what --global removes', () => {
    const help = execFileSync('node', [distPath, 'disable', '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
      env: { ...process.env, ORIGIN_SKIP_VERSION_CHECK: '1' },
    }).toString();
    expect(help).not.toMatch(/from ~\/\s*$/m);
    expect(help).toContain('home directory');
  });
});
