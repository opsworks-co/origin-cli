// The per-agent lists that used to be hard-coded in enable.ts (auto-detect,
// global-capable, the `hooks <agent>` regex), hook-config-health.ts and
// attribution-note.ts are now derived from agents/registry.ts. These tests pin
// the derived values to what the literals were, and fail when a registry agent
// claims hooks that the CLI cannot install or handle.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { AGENTS as REGISTRY, toolIdOf, hookToolIds } from '../agents/registry.js';
import {
  AGENTS as INSTALLERS,
  SUPPORTED_AGENTS,
  GLOBAL_CAPABLE_AGENTS,
  ORIGIN_HOOK_COMMAND_TAIL,
  isOriginHookCommand,
} from '../commands/enable.js';
import { CANONICAL_AGENT_IDS } from '../attribution-note.js';

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('agent lists derived from the registry', () => {
  it('match the lists that used to be hard-coded (no behavior change)', () => {
    const hookAgents = ['claude-code', 'cursor', 'gemini', 'codex', 'antigravity', 'devin', 'copilot'];
    expect(sorted(SUPPORTED_AGENTS)).toEqual(sorted(hookAgents));
    expect(sorted(GLOBAL_CAPABLE_AGENTS)).toEqual(sorted(hookAgents));
    expect(sorted(CANONICAL_AGENT_IDS)).toEqual(sorted([
      'claude-code', 'cursor', 'codex', 'gemini', 'copilot', 'devin', 'antigravity',
      'windsurf', 'aider', 'amp', 'junie', 'opencode', 'droid', 'rovo', 'continue',
    ]));
    for (const id of [...hookAgents, 'aider', 'windsurf']) {
      expect(isOriginHookCommand(`PATH=/x/bin:$PATH origin hooks ${id} stop`), id).toBe(true);
      expect(isOriginHookCommand(`PATH="/x y/bin:$PATH" origin hooks ${id} stop`), id).toBe(true);
    }
    for (const id of ['amp', 'junie', 'opencode', 'droid', 'rovo', 'continue', 'claude']) {
      expect(isOriginHookCommand(`origin hooks ${id} stop`), id).toBe(false);
    }
  });

  it('every registry agent with hooks has an installer and a `hooks <id>` handler', () => {
    const index = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
      'utf-8',
    );
    for (const agent of REGISTRY.filter((a) => a.hooks)) {
      const id = toolIdOf(agent);
      expect(Object.keys(INSTALLERS), `${agent.slug}: no installer in enable.ts AGENTS`).toContain(id);
      expect(index, `${agent.slug}: no \`origin hooks ${id}\` subcommand in index.ts`)
        .toContain(`hooks.command('${id} <event>')`);
    }
  });

  it('every installer in enable.ts is a registry hook agent', () => {
    // The reverse direction: an installer added without a registry entry would
    // be missing from auto-detection and from the hook-command regex.
    expect(sorted(Object.keys(INSTALLERS))).toEqual(sorted(hookToolIds()));
  });

  it('every registry agent is a canonical tool id; the hook regex covers exactly the hook agents', () => {
    for (const agent of REGISTRY) {
      const id = toolIdOf(agent);
      expect(CANONICAL_AGENT_IDS, agent.slug).toContain(id);
      expect(ORIGIN_HOOK_COMMAND_TAIL.test(`hooks ${id} stop`), agent.slug).toBe(!!agent.hooks);
    }
  });
});
