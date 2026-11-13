// `origin benchmark sync`: nothing is measured in a shallow clone; a session
// whose landing commit HEAD cannot reach waits for a later sync; and the
// upload, sent after minutes of blame on a socket that is dead by then, is
// sent once more on a fresh connection (an HTTP error is not retried).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ getSurvivalTargets: vi.fn(), postSurvival: vi.fn() }));
vi.mock('../api.js', () => ({ api }));
const git = vi.hoisted(() => ({ shallow: false, reachable: true }));
vi.mock('../benchmark-survival.js', () => ({
  anyShaReachable: () => git.reachable,
  computeSessionSurvival: () => ({ linesSurviving: 3, resolvable: true, filesBlamed: 1 }),
}));
vi.mock('../utils/exec.js', () => ({
  runDetailed: (_cmd: string, args: string[]) => ({
    status: 0,
    stdout: args[1] === '--is-shallow-repository' ? `${git.shallow}\n`
      : args[0] === 'rev-parse' ? '/work/origin\n' : 'https://github.com/acme/origin.git\n',
  }),
}));

import { benchmarkSyncCommand } from '../commands/benchmark.js';

const target = { sessionId: 's1', horizonDays: 7, ageDays: 8, commitShas: ['a'.repeat(40)], landedShas: [], files: ['f.ts'], linesAuthored: 5 };

describe('benchmark sync upload', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    api.getSurvivalTargets.mockReset().mockResolvedValue({ repoId: 'r1', targets: [target] });
    api.postSurvival.mockReset();
    git.shallow = false;
    git.reachable = true;
  });

  it('measures nothing in a shallow clone', async () => {
    git.shallow = true;
    await benchmarkSyncCommand();
    expect(api.getSurvivalTargets).not.toHaveBeenCalled();
    expect(api.postSurvival).not.toHaveBeenCalled();
  });

  it('leaves a session whose landing commit HEAD cannot reach for a later sync', async () => {
    api.getSurvivalTargets.mockResolvedValue({
      repoId: 'r1',
      targets: [target, { ...target, sessionId: 's2', landedShas: ['b'.repeat(40)] }],
    });
    git.reachable = false;
    api.postSurvival.mockResolvedValue({ upserted: 1 });
    await benchmarkSyncCommand();
    expect(api.postSurvival.mock.calls[0][0].results.map((r: any) => r.sessionId)).toEqual(['s1']);
  });

  it('sends the results again when the first send dies on a stale connection', async () => {
    api.postSurvival.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce({ upserted: 1 });
    await benchmarkSyncCommand();
    expect(api.postSurvival).toHaveBeenCalledTimes(2);
    expect(api.postSurvival.mock.calls[1][0].results[0]).toMatchObject({ sessionId: 's1', linesSurviving: 3 });
  });

  it('does not resend after the server answered with an error', async () => {
    api.postSurvival.mockRejectedValueOnce(new Error('API error 403: Access denied'));
    await benchmarkSyncCommand();
    expect(api.postSurvival).toHaveBeenCalledTimes(1);
  });
});
