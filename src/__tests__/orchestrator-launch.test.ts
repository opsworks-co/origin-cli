// The runner's launch of an orchestrator issue: the same CLI, `issue start
// --background --force`, in the checkout; exit 0 = started, with the output.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchArgv, launchOrchestratorRun } from '../commands/orchestrator-launch.js';

const run = { id: 'r1', repoFullName: 'acme/app', shortId: 'ori-7', agent: 'codex' };

describe('orchestrator launch', () => {
  it('runs `issue start <id> --agent <a> --background --force` with this CLI', () => {
    expect(launchArgv(run, ['/usr/bin/node', '/opt/origin/bin/origin'])).toEqual([
      '/usr/bin/node', ['/opt/origin/bin/origin', 'issue', 'start', 'ori-7', '--agent', 'codex', '--background', '--force'],
    ]);
  });

  it("passes the run's repo id, so the issue is read from that repo and not the one the checkout routes to", () => {
    expect(launchArgv({ ...run, repoId: 'repo-9a17' }, ['/usr/bin/node', '/opt/origin/bin/origin'])[1]).toEqual(
      ['/opt/origin/bin/origin', 'issue', 'start', 'ori-7', '--agent', 'codex', '--background', '--force', '--repo-id', 'repo-9a17'],
    );
  });

  it('resolves ok with the output on exit 0, not ok on a non-zero exit, in the given folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-launch-'));
    const script = path.join(dir, 'fake-origin.js');
    fs.writeFileSync(script, "const a = process.argv.slice(2); console.log('cwd=' + process.cwd()); console.log(a.join(' ')); process.exit(a.includes('ori-bad') ? 3 : 0);");
    const ok = await launchOrchestratorRun(run, dir, [process.execPath, script]);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('issue start ori-7 --agent codex --background --force');
    expect(ok.output).toContain(`cwd=${fs.realpathSync(dir)}`);
    const bad = await launchOrchestratorRun({ ...run, shortId: 'ori-bad' }, dir, [process.execPath, script]);
    expect(bad.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives up on a launch that hangs past its time limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-launch-'));
    const script = path.join(dir, 'hang.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const r = await launchOrchestratorRun(run, dir, [process.execPath, script], process.env, 300);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/gave up/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
