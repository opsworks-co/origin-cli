import { describe, it, expect } from 'vitest';
import { recoverCommittedTurnProofs, rehomeGitOnlyCommitStamp } from '../rehome-git-only-commit-stamp.js';

const SHA = '04ad8136fe90dd0c1dc976e411adb84e4d78d5f1';

describe('rehomeGitOnlyCommitStamp', () => {
  it('moves the SHA from an empty "open PR" turn onto the authoring turn', () => {
    const mappings = [
      {
        promptIndex: 2,
        filesChanged: ['apps/api/src/utils/pricing.ts'],
        diff: 'diff --git a/apps/api/src/utils/pricing.ts b/apps/api/src/utils/pricing.ts\n+x\n',
        commitSha: null,
      },
      {
        promptIndex: 3,
        filesChanged: [] as string[],
        diff: '',
        commitSha: SHA,
      },
    ];
    expect(rehomeGitOnlyCommitStamp(mappings, [
      { sha: SHA, filesChanged: ['apps/api/src/utils/pricing.ts'] },
    ])).toBe(true);
    expect(mappings[0].commitSha).toBe(SHA);
    expect(mappings[1].commitSha).toBeNull();
  });

  it('leaves a capture-failure stamp in place when no author overlaps (#1174)', () => {
    const mappings = [
      { promptIndex: 0, filesChanged: ['src/a.ts'], diff: '+x', commitSha: null },
      { promptIndex: 1, filesChanged: [] as string[], diff: '', commitSha: SHA },
    ];
    expect(rehomeGitOnlyCommitStamp(mappings, [
      { sha: SHA, filesChanged: ['src/z.ts'] },
    ])).toBe(false);
    expect(mappings[1].commitSha).toBe(SHA);
    expect(mappings[0].commitSha).toBeNull();
  });
});

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
