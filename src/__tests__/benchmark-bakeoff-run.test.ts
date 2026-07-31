// Auto-run bake-off arms. The skip paths (no runner for a slug, binary missing)
// are deterministic and checked directly. The run+commit path is driven against
// a real temp git repo with an injected "agent" (plain `node` that writes a
// file), proving that whatever the agent leaves uncommitted gets committed onto
// the arm so Origin can correlate the branch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runArm, runBakeOffArms, AGENT_RUNNERS } from '../commands/benchmark-bakeoff-run.js';

describe('runArm — skip paths', () => {
  it('skips a slug with no headless runner', () => {
    const r = runArm('some-gui-only-agent', '/nonexistent', 'do a thing');
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toMatch(/no headless runner/i);
    expect(r.committed).toBe(false);
  });

  it('skips a known agent whose binary is not installed', () => {
    // Point a temp runner at a binary that cannot exist on PATH.
    AGENT_RUNNERS['__missingbin__'] = { bin: 'definitely-not-a-real-binary-xyz', buildArgs: (p) => [p] };
    try {
      const r = runArm('__missingbin__', '/tmp', 'x');
      expect(r.outcome).toBe('skipped');
      expect(r.reason).toMatch(/not found/i);
    } finally {
      delete AGENT_RUNNERS['__missingbin__'];
    }
  });
});

describe('runArm — run + commit-leftovers, against a real repo', () => {
  let dir: string;
  const g = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakeoff-run-'));
    g('init', '-q');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@x');
    g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    g('add', '.');
    g('-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs the agent and commits what it leaves', () => {
    // Inject an "agent" that just writes a file via node (guaranteed on PATH).
    AGENT_RUNNERS['__fake__'] = {
      bin: 'node',
      buildArgs: () => ['-e', "require('fs').writeFileSync('agent-output.txt','from the agent\\n')"],
    };
    try {
      const before = g('rev-list', '--count', 'HEAD');
      const r = runArm('__fake__', dir, 'write a file');
      expect(r.outcome).toBe('ran');
      expect(r.committed).toBe(true);
      // The agent's file exists and a new commit landed.
      expect(fs.existsSync(path.join(dir, 'agent-output.txt'))).toBe(true);
      const after = g('rev-list', '--count', 'HEAD');
      expect(Number(after)).toBe(Number(before) + 1);
      expect(g('log', '-1', '--pretty=%s')).toMatch(/^bake-off\(__fake__\)/);
    } finally {
      delete AGENT_RUNNERS['__fake__'];
    }
  });

  it('reports committed:false when the agent leaves the tree clean', () => {
    AGENT_RUNNERS['__noop__'] = { bin: 'node', buildArgs: () => ['-e', '0'] };
    try {
      const before = g('rev-list', '--count', 'HEAD');
      const r = runArm('__noop__', dir, 'do nothing');
      expect(r.outcome).toBe('ran');
      expect(r.committed).toBe(false);
      expect(g('rev-list', '--count', 'HEAD')).toBe(before); // no new commit
    } finally {
      delete AGENT_RUNNERS['__noop__'];
    }
  });

  it('does NOT commit when the agent errored, even if it left files', () => {
    // Agent writes a file then exits non-zero → errored arms must not mint a
    // commit (no false "completed" session).
    AGENT_RUNNERS['__err__'] = {
      bin: 'node',
      buildArgs: () => ['-e', "require('fs').writeFileSync('half.txt','partial\\n');process.exit(1)"],
    };
    try {
      const before = g('rev-list', '--count', 'HEAD');
      const r = runArm('__err__', dir, 'fail midway');
      expect(r.outcome).toBe('error');
      expect(r.committed).toBe(false);
      expect(g('rev-list', '--count', 'HEAD')).toBe(before); // no new commit
    } finally {
      delete AGENT_RUNNERS['__err__'];
    }
  });

  it('does NOT commit when only Origin scaffolding is left (prompt file + injected managed doc)', () => {
    // Simulate an agent that produced no real work: the worktree is dirty only
    // with the runner's BAKEOFF_PROMPT.md and Origin's injected AGENTS.md block.
    AGENT_RUNNERS['__scaffold__'] = {
      bin: 'node',
      buildArgs: () => ['-e',
        "const fs=require('fs');" +
        "fs.writeFileSync('BAKEOFF_PROMPT.md','# Bake-off prompt\\n');" +
        "fs.writeFileSync('AGENTS.md','Origin: Session tracking active — prompts captured.\\n')"],
    };
    try {
      const before = g('rev-list', '--count', 'HEAD');
      const r = runArm('__scaffold__', dir, 'no real work');
      expect(r.outcome).toBe('ran');
      expect(r.committed).toBe(false);           // scaffolding is not "work"
      expect(g('rev-list', '--count', 'HEAD')).toBe(before); // no new commit
    } finally {
      delete AGENT_RUNNERS['__scaffold__'];
    }
  });

  it('commits real work but strips the scaffolding riding alongside it', () => {
    AGENT_RUNNERS['__mixed__'] = {
      bin: 'node',
      buildArgs: () => ['-e',
        "const fs=require('fs');" +
        "fs.writeFileSync('feature.js','export const x=1;\\n');" +   // real work
        "fs.writeFileSync('BAKEOFF_PROMPT.md','# Bake-off prompt\\n');" + // runner noise
        "fs.writeFileSync('AGENTS.md','Origin: Session tracking active\\n')"], // injected (untracked)
    };
    try {
      const r = runArm('__mixed__', dir, 'add feature');
      expect(r.outcome).toBe('ran');
      expect(r.committed).toBe(true);
      // The commit has the real file but NOT the scaffolding.
      const files = g('show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean);
      expect(files).toContain('feature.js');
      expect(files).not.toContain('BAKEOFF_PROMPT.md');
      expect(files).not.toContain('AGENTS.md');
    } finally {
      delete AGENT_RUNNERS['__mixed__'];
    }
  });

  it('runBakeOffArms returns one result per arm', () => {
    const results = runBakeOffArms(
      [{ agentSlug: 'no-runner-a', worktree: dir }, { agentSlug: 'no-runner-b', worktree: dir }],
      'x',
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === 'skipped')).toBe(true);
  });
});
