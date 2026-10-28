// An Antigravity background run gets a project of its own, granting file
// access in its worktree, git and read-only commands, and no network — instead
// of `--dangerously-skip-permissions`. Headless agy refuses anything else and
// exits 0 having done nothing, which the supervisor reports as a failed run.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ANTIGRAVITY_BACKGROUND_COMMANDS, ANTIGRAVITY_BACKGROUND_MCP_TOOLS, antigravityProjectsDir, createBackgroundProject, removeBackgroundProject,
} from '../antigravity-scope.js';
import { superviseRun } from '../background-supervisor.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-home-'));

describe('an Antigravity background project', () => {
  it('grants files in the worktree, git and read-only commands — nothing else, no network', () => {
    const h = home();
    const { id, file } = createBackgroundProject('/w/repo-worktrees/ISS-1', 'ISS-1', h);
    expect(path.dirname(file)).toBe(antigravityProjectsDir(h));
    const p = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(p.id).toBe(id);
    expect(p.projectResources.resources[0].gitFolder.folderUri).toBe('file:///w/repo-worktrees/ISS-1');
    expect(p.permissionGrants.permissionGrants.allow).toEqual([
      ...ANTIGRAVITY_BACKGROUND_COMMANDS.map((c) => `command(${c})`),
      ...ANTIGRAVITY_BACKGROUND_MCP_TOOLS.map((t) => `mcp(origin/${t})`),
      'read_file(/w/repo-worktrees/ISS-1)', 'write_file(/w/repo-worktrees/ISS-1)',
    ]);
    // Origin's startup check makes repo memory the first call — refused, it ended the run.
    expect(p.permissionGrants.permissionGrants.allow).toContain('mcp(origin/get_repo_memory)');
    // Per tool, never a wildcard; no session control or admin tools.
    for (const t of ['*', 'end_session', 'start_session', 'update_session', 'report_violation', 'list_users', 'get_audit_log']) {
      expect(ANTIGRAVITY_BACKGROUND_MCP_TOOLS as readonly string[]).not.toContain(t);
    }
    expect(p.settings.internetPolicy).toBe('AGENT_SETTING_POLICY_DENY');
    expect(p.settings.fileAccessPolicy).toBe('AGENT_SETTING_POLICY_ASK');
    // No command that writes, deletes or reaches the network by itself.
    expect(ANTIGRAVITY_BACKGROUND_COMMANDS).not.toEqual(expect.arrayContaining(['rm']));
    for (const c of ['rm', 'mv', 'cp', 'curl', 'wget', 'sh', 'bash', 'node', 'npm', 'find', 'echo', 'tee', 'sed']) {
      expect(ANTIGRAVITY_BACKGROUND_COMMANDS as readonly string[]).not.toContain(c);
    }
  });

  it('is removed afterwards — and only a project Origin wrote, in the projects dir', () => {
    const h = home();
    const { file } = createBackgroundProject('/w/x', 'x', h);
    const theirs = path.join(antigravityProjectsDir(h), 'user-project.json');
    fs.writeFileSync(theirs, JSON.stringify({ id: 'u', name: 'sardina' }));
    const elsewhere = path.join(h, 'origin-looking.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ name: 'origin background x' }));
    removeBackgroundProject(theirs, h);
    removeBackgroundProject(elsewhere, h);
    removeBackgroundProject(file, h);
    expect(fs.existsSync(theirs)).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('the supervisor and a refused Antigravity run', () => {
  // The fake agy is a node script run by this node — native Windows has no /bin/sh.
  function run(script: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-run-'));
    const agent = path.join(dir, 'agy.cjs');
    fs.writeFileSync(agent, script);
    const proj = createBackgroundProject(dir, 'test');
    const record = path.join(dir, 'run.json');
    const log = path.join(dir, 'run.log');
    fs.writeFileSync(record, JSON.stringify({ argv: [process.execPath, agent], worktree: dir, log, timeoutMin: 0, antigravityProjectFile: proj.file }));
    return { record, log, project: proj.file };
  }

  it('reports a run agy ended on a refusal as failed, not done, and removes its project', async () => {
    // agy's own words, then exit 0 having done nothing (2026-10-13).
    const t = run('console.log(\'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\');\nprocess.exit(0);\n');
    expect(await superviseRun(t.record)).toBe(3);
    expect(fs.readFileSync(t.log, 'utf-8')).toMatch(/\[origin\] agent stopped: it needed a permission this run does not grant\n\[origin\] agent exited with code 3\n$/);
    expect(fs.existsSync(t.project)).toBe(false);
  });

  it('a run that finished is done, and its project is removed too', async () => {
    const t = run("console.log('committed');\nprocess.exit(0);\n");
    expect(await superviseRun(t.record)).toBe(0);
    expect(fs.existsSync(t.project)).toBe(false);
  });
});
