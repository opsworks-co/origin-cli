import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDetailed } from '../utils/exec.js';

const cli = path.resolve(__dirname, '../../dist/index.js');
let home: string;
function verify(args: string[]) {
  return runDetailed(process.execPath, [cli, 'verify-capture', ...args], {
    cwd: home, env: { HOME: home, USERPROFILE: home }, timeoutMs: 20_000,
  });
}
beforeEach(() => {
  expect(fs.existsSync(cli), 'Build the CLI before testing its exit codes').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-exit-codes-'));
  fs.mkdirSync(path.join(home, '.origin', 'sessions'), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('verify-capture exit codes through the built CLI', () => {
  it.each(['not-a-date', '', '9'.repeat(400) + 'd'])('invalid --since %j exits 3 before producing a report', since => {
    const result = verify(['--since', since, '--json', '--fail-on-incomplete-evidence']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('--since: cannot read');
    expect(result.stdout).toBe('');
  });

  it('does not produce a waiver for an invalid argument', () => {
    const result = verify(['--since', 'invalid', '--waiver']);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
  });

  it.each(['7d', '2026-01-01T00:00:00Z'])('valid --since %s with missing evidence remains exit 2', since => {
    const result = verify(['--since', since, '--json', '--fail-on-incomplete-evidence']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ sessions: [], totals: null });
  });

  it('an ordinary empty diagnostic remains successful', () => {
    expect(verify(['--json']).status).toBe(0);
  });

  it('contradictions still exit 1', () => {
    fs.writeFileSync(path.join(home, '.origin', 'sessions', 'ended.json'), JSON.stringify({
      sessionId: 'exit-code-fixture', agentSlug: 'claude-code', repoPath: home,
      startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z', status: 'ENDED',
      completedPromptMappings: [{ promptIndex: 0, filesChanged: ['ghost.ts'],
        diff: 'diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1,2 @@\n context\n+added\n', linesAdded: 1, linesRemoved: 0 }],
    }));
    const result = verify(['--json', '--fail-on-contradiction', '--fail-on-incomplete-evidence']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).sessions).toHaveLength(1);
  });
});
