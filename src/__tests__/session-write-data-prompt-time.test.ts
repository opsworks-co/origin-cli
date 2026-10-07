// changes.json is what another org imports from the origin-sessions branch.
// Without a per-prompt time the importer dated every turn on import day, so a
// May session's turns showed today's clock time. The time is the one the
// submit hook recorded (`state.promptSubmittedAt`, by LOCAL prompt index — the
// same index the live wire reads it by).
import { describe, it, expect } from 'vitest';
import { buildSessionWriteData } from '../commands/hooks';

function opts(promptSubmittedAt?: string[]) {
  return {
    state: { repoPath: '/nonexistent', startedAt: '2026-05-01T10:00:00.000Z', prompts: [], model: 'claude', branch: 'main', promptSubmittedAt } as any,
    parsed: { prompts: ['first', 'second'], model: 'claude', filesChanged: [] } as any,
    gitCapture: { headBefore: '', headAfter: '', commitShas: [], linesAdded: 0, linesRemoved: 0 },
    status: 'ended' as const,
    apiUrl: 'http://localhost',
    promptMappings: [
      { promptIndex: 0, promptText: 'first', filesChanged: [], diff: '' } as any,
      { promptIndex: 1, promptText: 'second', filesChanged: [], diff: '' } as any,
    ],
  };
}

describe('buildSessionWriteData — per-prompt time', () => {
  it('carries each prompt\'s submit time by its local index', () => {
    const out = buildSessionWriteData(opts(['2026-05-01T10:00:05.000Z', '2026-05-01T10:03:00.000Z']));
    expect(out.changes.map((c) => c.createdAt)).toEqual(['2026-05-01T10:00:05.000Z', '2026-05-01T10:03:00.000Z']);
  });

  it('null when the submit hook never recorded one', () => {
    const out = buildSessionWriteData(opts(undefined));
    expect(out.changes.map((c) => c.createdAt)).toEqual([null, null]);
  });
});
