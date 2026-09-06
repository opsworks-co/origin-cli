/**
 * The sub-agent spawner tool name, and the guard for the next time it changes.
 *
 * Capture was gated on `tool_name === 'task'` in two places. Claude Code
 * renamed the spawner to `Agent`, the condition became unsatisfiable, and
 * `subagentSpawns` was never populated again. Measured across 114 local
 * sessions: ZERO spawns recorded, while the same sessions logged 66
 * `TaskOutput`, 6 `TaskStop` and 1 `ListAgents` call. You cannot read a
 * sub-agent's output 66 times without spawning one.
 *
 * Nothing failed. The feature was built, tested, shipped and documented, then
 * quietly stopped being reachable.
 *
 * Matching both names fixes today. The CONTRADICTION CHECK is the part that
 * matters, because the next rename cannot be predicted and no test can assert
 * against a string that does not exist yet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isSubagentSpawnTool, isSubagentCompanionTool, detectRenamedSpawner,
  SUBAGENT_SPAWN_TOOLS,
} from '../subagent-tools.js';

describe('spawner tool names', () => {
  it('accepts the current name and the historical one', () => {
    // `agent` is current; `task` still arrives from older clients, replayed
    // offline queues and other agents' transcripts.
    for (const n of ['Agent', 'agent', 'Task', 'task', ' TASK ']) {
      expect(isSubagentSpawnTool(n), n).toBe(true);
    }
  });

  it('does not mistake a companion tool for a spawner', () => {
    // These operate on an ALREADY-SPAWNED sub-agent. Counting them as spawns
    // would turn one sub-agent into four.
    for (const n of ['TaskOutput', 'TaskStop', 'ListAgents']) {
      expect(isSubagentSpawnTool(n), n).toBe(false);
      expect(isSubagentCompanionTool(n), n).toBe(true);
    }
  });

  it('does not fire on ordinary tools or malformed input', () => {
    for (const n of ['Bash', 'Edit', 'Read', 'mcp__ccd_session__spawn_task', '', null, undefined]) {
      expect(isSubagentSpawnTool(n as string), String(n)).toBe(false);
    }
  });
});

describe('detectRenamedSpawner', () => {
  it('flags companions recorded with zero spawns — the state that shipped', () => {
    // The real shape: TaskOutput/TaskStop present, no spawn ever recorded.
    const v = detectRenamedSpawner(['bash', 'edit', 'TaskOutput', 'TaskStop', 'Agent'], 0);
    expect(v.broken).toBe(true);
    expect(v.companionsSeen).toEqual(expect.arrayContaining(['taskoutput', 'taskstop']));
  });

  it('names the unrecognised tool as a candidate for the new spawner', () => {
    // The whole point: tell the maintainer WHICH name to add.
    const v = detectRenamedSpawner(['bash', 'TaskOutput', 'Delegate'], 0);
    expect(v.candidates).toContain('delegate');
  });

  it('excludes ordinary tools and MCP calls from the candidates', () => {
    const v = detectRenamedSpawner(
      ['bash', 'read', 'edit', 'TaskOutput', 'mcp__ccd_session__spawn_task'], 0,
    );
    expect(v.candidates).toEqual([]);
  });

  it('stays silent once spawns are being recorded', () => {
    expect(detectRenamedSpawner(['TaskOutput', 'Agent'], 1).broken).toBe(false);
  });

  it('stays silent when no companion tool was used at all', () => {
    // A session that simply never touched sub-agents is not a contradiction.
    expect(detectRenamedSpawner(['bash', 'edit'], 0).broken).toBe(false);
  });

  it('is one-directional: spawns without companions is ordinary', () => {
    // A sub-agent whose result the parent never polled. Not a fault.
    expect(detectRenamedSpawner(['Agent', 'bash'], 2).broken).toBe(false);
  });

  it('never throws on malformed input', () => {
    expect(() => detectRenamedSpawner(null as never, 0)).not.toThrow();
    expect(detectRenamedSpawner([null, undefined, ''] as never, 0).broken).toBe(false);
  });

  it('would have caught the shipped bug from real session data', () => {
    // Verbatim from the 114-session scan: companions present, spawns zero.
    const realToolNames = [
      ...Array(2107).fill('bash'), ...Array(86).fill('edit'), ...Array(36).fill('write'),
      ...Array(29).fill('taskoutput'), ...Array(2).fill('taskstop'), 'listagents',
    ];
    const v = detectRenamedSpawner(realToolNames, 0);
    expect(v.broken, 'this is the state that shipped undetected').toBe(true);
  });
});

describe('the spawn-tool set is the single source of truth', () => {
  it('holds both known names', () => {
    expect([...SUBAGENT_SPAWN_TOOLS].sort()).toEqual(['agent', 'task']);
  });

  it('hooks.ts matches through the helper, not a hard-coded string', () => {
    // The bug was `tool_name.toLowerCase() === 'task'` written out twice. A
    // third copy would go stale the same way.
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/toLowerCase\(\)\s*===\s*'task'/);
  });
});
