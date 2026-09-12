// `attestedCommitShas` feeds the same `fillMissingCommitPatches` that
// `rescuableShas` feeds, so it needs the same two exclusions — added after
// review of #1522, which introduced the helper without them.
//
// The exclusion added: a sha already rescued this session. The server keeps the
// FIRST patch it gets, so re-offering buys nothing and costs
// `patchForCommitSha` + `commitMetaForSha` — two subprocesses per sha — on a
// hook Cursor fires once per generation. `rescuableShas` applies the same rule
// and says so; the new helper did not, and never fed `rescuedCommitShas` either.
//
// Superseded shas deliberately stay IN — see attestedCommitShas. That is
// #1522's call and stop-recapture-shrinkage.test.ts pins it.
import { describe, it, expect } from 'vitest';
import { attestedCommitShas, headIsAttested } from '../commands/hooks/stop.js';

const FULL = 'd30d8c99a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SHORT = 'd30d8c9';
const SURVIVOR = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';
const OTHER = '1234567890abcdef1234567890abcdef12345678';

describe('attestedCommitShas', () => {
  it('offers the shas the session claimed', () => {
    expect(attestedCommitShas({ sessionCommitShas: [FULL] })).toEqual([FULL]);
  });

  it('drops a sha already rescued this session', () => {
    expect(attestedCommitShas({ sessionCommitShas: [FULL], rescuedCommitShas: [FULL] })).toEqual([]);
    // …including across spellings.
    expect(attestedCommitShas({ sessionCommitShas: [FULL], rescuedCommitShas: [SHORT] })).toEqual([]);
  });

  it('still offers a sha nothing has excluded', () => {
    const out = attestedCommitShas({
      sessionCommitShas: [FULL, OTHER],
      rescuedCommitShas: [FULL],
    });
    expect(out).toEqual([OTHER]);
  });

  it('takes shas from commitTurns as well, deduped against sessionCommitShas', () => {
    const out = attestedCommitShas({
      sessionCommitShas: [FULL],
      commitTurns: [{ sha: SHORT }, { sha: OTHER }],
    });
    expect(out).toEqual([FULL, OTHER]);
  });

  it('ignores anything that is not a sha', () => {
    expect(attestedCommitShas({ sessionCommitShas: ['', 'not-a-sha', 'HEAD'] })).toEqual([]);
  });
});

describe('headIsAttested', () => {
  it('matches across spellings', () => {
    expect(headIsAttested(FULL, [SHORT])).toBe(true);
    expect(headIsAttested(SHORT, [FULL])).toBe(true);
  });
  it('does not match an unrelated sha or a non-sha', () => {
    expect(headIsAttested(OTHER, [FULL])).toBe(false);
    expect(headIsAttested('HEAD', [FULL])).toBe(false);
    expect(headIsAttested(null, [FULL])).toBe(false);
  });
});
