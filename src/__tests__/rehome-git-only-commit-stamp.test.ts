import { describe, it, expect } from 'vitest';
import { recoverCommittedTurnProofs } from '../rehome-git-only-commit-stamp.js';

const SHA = '04ad8136fe90dd0c1dc976e411adb84e4d78d5f1';

describe('recoverCommittedTurnProofs', () => {
  it('recovers a missed commit attestation only from an exact file-set match', () => {
    const mappings = [{
      promptIndex: 4, filesChanged: ['src/a.ts', 'src/b.ts'], diff: '', commitSha: SHA,
    }];
    expect(recoverCommittedTurnProofs(mappings, [{
      sha: SHA, filesChanged: ['src/b.ts', 'src/a.ts'], patch: 'diff --git a/src/a.ts b/src/a.ts\n+x',
    }])).toEqual([{ promptIndex: 4, sha: SHA }]);
  });

  it('repairs a clean divergent-baseline file leak from the commit patch before proving ownership', () => {
    const mappings = [{
      promptIndex: 7,
      filesChanged: ['old.ts', 'src/a.ts', 'src/b.ts'],
      diff: '', uncommittedDiff: '', commitSha: SHA,
    }];
    const proofs = recoverCommittedTurnProofs(mappings, [{
      sha: SHA,
      filesChanged: ['src/a.ts', 'src/b.ts'],
      patch: 'diff --git a/src/a.ts b/src/a.ts\n+x',
      linesAdded: 1,
      linesRemoved: 0,
    }]);
    expect(proofs).toEqual([{ promptIndex: 7, sha: SHA }]);
    expect(mappings[0]).toMatchObject({
      filesChanged: ['src/a.ts', 'src/b.ts'],
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+x',
      linesAdded: 1,
    });
  });

  it('does not trim a mapping that has retained uncommitted or diff content', () => {
    const mappings = [{
      promptIndex: 7, filesChanged: ['old.ts', 'src/a.ts'], diff: 'real turn bytes', commitSha: SHA,
    }];
    expect(recoverCommittedTurnProofs(mappings, [{
      sha: SHA, filesChanged: ['src/a.ts'], patch: 'commit patch',
    }])).toEqual([]);
    expect(mappings[0].filesChanged).toEqual(['old.ts', 'src/a.ts']);
  });
});
