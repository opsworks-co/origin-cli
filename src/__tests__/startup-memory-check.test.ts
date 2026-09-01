// Agents do not read a repo's Origin memory unless something tells them to.
// Asked why it had not, an Antigravity session said it plainly: deeper commands
// "are not executed unless … an explicit workspace or global rule instructs the
// agent to run those startup checks automatically."
//
// Two halves are covered here:
//   1. The DIRECTIVE — assembleRepoContext places the startup check last, and
//      only when the pointer established that a queryable record exists.
//   2. COMPLIANCE detection — isMemoryReadCommand / isMemoryReadToolName decide
//      whether the escalation fires, so a false positive silently disables the
//      whole mechanism for that session. They are biased to match too little.
import { describe, it, expect } from 'vitest';
import { assembleRepoContext } from '../context-injection.js';
import { isMemoryReadCommand, isMemoryReadToolName } from '../memory.js';

const POINTER = 'Repo memory (19 sessions, 163 commit records) is stored in this repo\'s git notes.';
const CHECK = 'Origin startup check — do this BEFORE your first substantive action in this session.';
const MEMORY = 'Prior work in this repo — 2 sessions (claude-code, antigravity):\n- Most recent: fix the thing';

describe('assembleRepoContext — startup check placement', () => {
  it('puts the startup check last, after the blocks it refers to', () => {
    const out = assembleRepoContext({ memory: MEMORY, memoryPointer: POINTER, startupCheck: CHECK })!;
    expect(out.indexOf(CHECK)).toBeGreaterThan(out.indexOf(POINTER));
    expect(out.trimEnd().endsWith(CHECK)).toBe(true);
  });

  it('drops the check when no pointer rendered — nothing to go and read', () => {
    // A repo with no memory must not be told to go read memory: the agent
    // spends a tool call to discover an empty ref and learns to distrust the
    // instruction.
    const out = assembleRepoContext({ attribution: 'Repository AI context: 90%.', startupCheck: CHECK });
    expect(out).not.toContain(CHECK);
  });

  it('still returns null when the check is the only block', () => {
    expect(assembleRepoContext({ startupCheck: CHECK })).toBeNull();
  });
});

describe('isMemoryReadCommand', () => {
  it('matches every route the injected blocks offer', () => {
    expect(isMemoryReadCommand('origin context memory')).toBe(true);
    expect(isMemoryReadCommand('origin memory')).toBe(true);
    expect(isMemoryReadCommand(
      'git notes --ref=origin-memory show $(git rev-list --max-parents=0 HEAD | tail -1)',
    )).toBe(true);
  });

  it('matches the per-file query commands the pointer advertises', () => {
    // An agent that ran `origin why` on the file it is about to edit has
    // consulted the record; nudging it would be noise.
    expect(isMemoryReadCommand('origin why src/memory.ts:42')).toBe(true);
    expect(isMemoryReadCommand('origin prompts src/memory.ts')).toBe(true);
    expect(isMemoryReadCommand('origin ask "who wrote the notes refspec"')).toBe(true);
    expect(isMemoryReadCommand('origin todo list')).toBe(true);
  });

  it('matches through the surrounding shell', () => {
    expect(isMemoryReadCommand('cd /repo && origin context memory | head -40')).toBe(true);
    expect(isMemoryReadCommand('pnpm origin why src/x.ts:1')).toBe(true);
  });

  it('does not match unrelated origin or git commands', () => {
    // A false positive latches memoryChecked for the whole session and silently
    // disables the escalation — the exact failure this guards.
    expect(isMemoryReadCommand('git push origin main')).toBe(false);
    expect(isMemoryReadCommand('git notes --ref=refs/notes/commits show HEAD')).toBe(false);
    expect(isMemoryReadCommand('origin sessions')).toBe(false);
    expect(isMemoryReadCommand('origin status')).toBe(false);
    expect(isMemoryReadCommand('git remote add origin git@github.com:o/r.git')).toBe(false);
    expect(isMemoryReadCommand('')).toBe(false);
    expect(isMemoryReadCommand(undefined)).toBe(false);
  });
});

describe('isMemoryReadToolName', () => {
  it('matches the MCP memory tool under every host namespacing', () => {
    expect(isMemoryReadToolName('get_repo_memory')).toBe(true);
    expect(isMemoryReadToolName('mcp__origin__get_repo_memory')).toBe(true);
    expect(isMemoryReadToolName('origin.get_repo_memory')).toBe(true);
  });

  it('does not match other tools', () => {
    expect(isMemoryReadToolName('Bash')).toBe(false);
    expect(isMemoryReadToolName('mcp__origin__get_session')).toBe(false);
    expect(isMemoryReadToolName(undefined)).toBe(false);
  });
});
