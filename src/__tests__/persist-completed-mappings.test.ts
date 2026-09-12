import { describe, expect, it } from 'vitest';
import { persistCompletedMappings } from '../commands/hooks/stop.js';

describe('persistCompletedMappings', () => {
  it('keeps the complete turn record for a later watcher re-send', () => {
    const state: any = {};
    persistCompletedMappings({
      state,
      promptMappings: [{
        promptIndex: 4,
        promptText: 'merge and commit',
        filesChanged: ['README.md'],
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n',
        uncommittedDiff: '',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
      }] as any,
    });

    expect(state.completedPromptMappings).toHaveLength(1);
    expect(state.completedPromptMappings[0]).toMatchObject({
      promptIndex: 4,
      linesAdded: 1,
      linesRemoved: 1,
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
    });
    expect(Date.parse(state.completedPromptMappings[0].capturedAt)).toBeGreaterThan(0);
  });
});
