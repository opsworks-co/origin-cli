/**
 * Session d74b8927 (2026-09-21), the shape this exists for:
 *
 *   16:02:28Z  commit da8b404f  -> [post-commit] no session state for this commit
 *   16:03:37Z  [user-prompt-submit] auto-created session d74b8927
 *   17:14:28Z  rebase rewrites da8b404f->eccd48cc and c191cfd0->01f0edc0
 *              -> [post-rewrite] recorded pairs: ["c191cfd0->01f0edc0"]   (ONE of two)
 *
 * The first pair was refused because `owns()` asks whether the session holds
 * the OLD sha, and it never did — the commit predates registration by 69s.
 * The rewritten copy then landed on whatever turn was running, which is how
 * turn 3 came to hold three commits and +722 lines for the +351 it wrote.
 */
import { describe, it, expect } from 'vitest';
import {
  commitsToClaimOnLateRegistration,
  DEFAULT_CLAIM_MAX_AGE_MS,
  buildClaimCandidates,
  streamClaimCandidates,
  CLAIM_WALK_LIMIT,
  trailerNamesSession,
  type CommitClaimCandidate,
  type ClaimProbeDeps,
} from '../claim-commits-made-before-registration.js';

const REGISTERED = Date.parse('2026-09-21T16:03:37Z');
const CHAT_START = Date.parse('2026-09-21T15:40:00Z');
const at = (iso: string) => Date.parse(iso);

const US = 'agent@example.com';
const OUR_FILE = 'src/thing.ts';

/** An unowned commit — clean on every signal, including the two that ask
 *  whether it is OURS rather than whether anyone has recorded it. */
function unowned(sha: string, iso: string): CommitClaimCandidate {
  return {
    sha,
    committedAtMs: at(iso),
    hasOriginNote: false,
    trailerSessionId: null,
    ownedByAnotherLiveSession: false,
    committerEmail: US,
    authorEmail: US,
    touchedFiles: [OUR_FILE],
  };
}

const claim = (candidates: CommitClaimCandidate[], over: Partial<Parameters<typeof commitsToClaimOnLateRegistration>[0]> = {}) =>
  commitsToClaimOnLateRegistration({
    candidates,
    conversationStartedAtMs: CHAT_START,
    registeredAtMs: REGISTERED,
    sessionId: 'd74b8927-38a2-4e84-96af-f6605c94599f',
    editedFiles: [OUR_FILE],
    localCommitterEmails: [US],
    ...over,
  });

describe('claiming the commit made while Origin was still blind', () => {
  it('claims the commit made 69s before the session registered', () => {
    expect(claim([unowned('da8b404f', '2026-09-21T16:02:28Z')])).toEqual(['da8b404f']);
  });

  it('returns oldest first, so shas land in the order they were made', () => {
    const got = claim([
      unowned('newest', '2026-09-21T16:02:28Z'),
      unowned('middle', '2026-09-21T16:01:00Z'),
      unowned('oldest', '2026-09-21T15:59:00Z'),
    ]);
    expect(got).toEqual(['oldest', 'middle', 'newest']);
  });

  it('claims nothing when the conversation start is unknown', () => {
    // No lower bound means the walk could reach into the repo's own history.
    expect(claim([unowned('da8b404f', '2026-09-21T16:02:28Z')], { conversationStartedAtMs: null })).toEqual([]);
  });

  it('will not reach back before the conversation began', () => {
    expect(claim([unowned('beforeChat', '2026-09-21T15:00:00Z')])).toEqual([]);
  });

  it('will not reach past its own max age even inside a long conversation', () => {
    const longAgo = REGISTERED - DEFAULT_CLAIM_MAX_AGE_MS - 60_000;
    expect(
      claim([unowned('ancient', new Date(longAgo).toISOString())], {
        conversationStartedAtMs: longAgo - 60_000,
      }),
    ).toEqual([]);
  });

  it('ignores commits made AFTER registration — post-commit owns those', () => {
    expect(claim([unowned('later', '2026-09-21T16:05:00Z')])).toEqual([]);
  });
});

describe('every signal that says "not yours" stops the walk', () => {
  // Each of these is an independent reason to believe a commit is accounted
  // for. Any one of them must be enough on its own.
  it('an Origin note stops it', () => {
    expect(claim([{ ...unowned('noted', '2026-09-21T16:02:28Z'), hasOriginNote: true }])).toEqual([]);
  });

  it('another live session owning the sha stops it', () => {
    expect(claim([{ ...unowned('theirs', '2026-09-21T16:02:28Z'), ownedByAnotherLiveSession: true }])).toEqual([]);
  });

  it("a trailer naming someone else stops it", () => {
    expect(claim([{ ...unowned('trailered', '2026-09-21T16:02:28Z'), trailerSessionId: 'another-session' }])).toEqual([]);
  });

  it('a trailer naming US is claimable — a re-register after a crash', () => {
    expect(
      claim([{ ...unowned('ours', '2026-09-21T16:02:28Z'), trailerSessionId: 'd74b8927-38a2-4e84-96af-f6605c94599f' }]),
    ).toEqual(['ours']);
  });

  it('an unreadable commit date stops it', () => {
    expect(claim([{ ...unowned('undated', '2026-09-21T16:02:28Z'), committedAtMs: null }])).toEqual([]);
  });
});

describe('the walk STOPS at a foreign commit — it does not step over it', () => {
  // This is the property that keeps the claim honest. A commit that is
  // demonstrably someone else's is a floor: whatever sits below it belongs to
  // whatever produced it. Skipping would make the claim greediest exactly
  // where it is least sure.
  it('does not claim an older unowned commit hiding under a foreign one', () => {
    const got = claim([
      unowned('ours', '2026-09-21T16:02:28Z'),
      { ...unowned('stranger', '2026-09-21T16:01:00Z'), ownedByAnotherLiveSession: true },
      unowned('oldUnowned', '2026-09-21T16:00:00Z'),
    ]);
    expect(got).toEqual(['ours']);
    expect(got).not.toContain('oldUnowned');
  });

  it('stops at a NOTED commit rather than hopping it', () => {
    const got = claim([
      unowned('ours', '2026-09-21T16:02:28Z'),
      { ...unowned('noted', '2026-09-21T16:01:00Z'), hasOriginNote: true },
      unowned('oldUnowned', '2026-09-21T16:00:00Z'),
    ]);
    expect(got).toEqual(['ours']);
  });

  it('claims the whole unowned prefix when nothing interrupts it', () => {
    const got = claim([
      unowned('c', '2026-09-21T16:02:28Z'),
      unowned('b', '2026-09-21T16:01:00Z'),
      unowned('a', '2026-09-21T16:00:00Z'),
    ]);
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('claims nothing at all from an empty walk', () => {
    expect(claim([])).toEqual([]);
  });
});

describe('probing git into candidates', () => {
  const SESSION = 'd74b8927-38a2-4e84-96af-f6605c94599f';
  // The real trailer from 01f0edc0, truncated id and all.
  const REAL_TRAILER =
    'fix(web): act on the review\n\nbody\n\nOrigin-Session: d74b8927-38a | Claude Code | 2 prompts | turn 2 | 2 sub-agents\n';

  function deps(over: Partial<ClaimProbeDeps> = {}): ClaimProbeDeps {
    return {
      listRecentShas: () => ['aaa1'],
      commitDateIso: () => '2026-09-21T16:02:28Z',
      hasOriginNote: () => false,
      commitBody: () => 'no trailer here',
      shasOwnedByOtherLiveSessions: () => [],
      committerEmail: () => US,
      authorEmail: () => US,
      filesInCommit: () => [OUR_FILE],
      ...over,
    };
  }

  it('reads a clean unowned commit', () => {
    expect(buildClaimCandidates(deps(), SESSION)).toEqual([
      {
        sha: 'aaa1',
        committedAtMs: at('2026-09-21T16:02:28Z'),
        hasOriginNote: false,
        trailerSessionId: null,
        ownedByAnotherLiveSession: false,
        committerEmail: US,
        authorEmail: US,
        touchedFiles: [OUR_FILE],
      },
    ]);
  });

  it('lowercases the committer email it reads', () => {
    const [c] = buildClaimCandidates(deps({ committerEmail: () => '  Agent@Example.COM ' }), SESSION);
    expect(c.committerEmail).toBe(US);
  });

  it('reports an unreadable file list as null, not as an empty commit', () => {
    const [c] = buildClaimCandidates(deps({ filesInCommit: () => null }), SESSION);
    expect(c.touchedFiles).toBeNull();
  });

  it('treats a TRUNCATED trailer naming us as ours, not as a stranger', () => {
    // `Origin-Session: d74b8927-38a` against the full uuid. A plain equality
    // check fails here, which would make every trailered commit of our own
    // read as foreign and stop the walk on our first commit.
    const [c] = buildClaimCandidates(deps({ commitBody: () => REAL_TRAILER }), SESSION);
    expect(c.trailerSessionId).toBeNull();
    expect(trailerNamesSession(REAL_TRAILER, SESSION)).toBe(true);
  });

  it('records a trailer naming someone else', () => {
    const body = 'x\n\nOrigin-Session: 99999999-aaa | Claude Code | 1 prompts\n';
    const [c] = buildClaimCandidates(deps({ commitBody: () => body }), SESSION);
    expect(c.trailerSessionId).toBe('99999999-aaa');
    expect(trailerNamesSession(body, SESSION)).toBe(false);
  });

  it('matches another live session on an ABBREVIATED sha', () => {
    const [c] = buildClaimCandidates(
      deps({
        listRecentShas: () => ['da8b404f64f541afc7bf71233abc5a38ca154030'],
        shasOwnedByOtherLiveSessions: () => ['da8b404f'],
      }),
      SESSION,
    );
    expect(c.ownedByAnotherLiveSession).toBe(true);
  });

  it('reports an unreadable date as null rather than NaN', () => {
    const [c] = buildClaimCandidates(deps({ commitDateIso: () => null }), SESSION);
    expect(c.committedAtMs).toBeNull();
  });

  it('survives a commit body git could not produce', () => {
    const [c] = buildClaimCandidates(deps({ commitBody: () => '' }), SESSION);
    expect(c.trailerSessionId).toBeNull();
  });

  it('end to end: the d74b8927 walk claims exactly the orphan', () => {
    const candidates = buildClaimCandidates(
      deps({
        // HEAD-first: the orphan, then main's tip which is plainly not ours.
        listRecentShas: () => ['da8b404f', 'ba575da8'],
        commitDateIso: (sha) =>
          sha === 'da8b404f' ? '2026-09-21T16:02:28Z' : '2026-09-20T09:00:00Z',
      }),
      SESSION,
    );
    expect(
      commitsToClaimOnLateRegistration({
        candidates,
        conversationStartedAtMs: CHAT_START,
        registeredAtMs: REGISTERED,
        sessionId: SESSION,
        editedFiles: [OUR_FILE],
        localCommitterEmails: [US],
      }),
    ).toEqual(['da8b404f']);
  });

  it('probes LAZILY — the walk stops at the first commit, the rest are never read', () => {
    // Eagerly probing all twenty candidates cost four git spawns each for
    // nineteen answers nobody reads, on the prompt-submit hook's critical
    // path. The stream must not run ahead of the walk.
    const probed: string[] = [];
    const d = deps({
      listRecentShas: () => ['head', 'older', 'oldest'],
      // `head` is plainly a stranger's, so the walk must stop on it.
      hasOriginNote: (sha) => sha === 'head',
      commitDateIso: (sha) => { probed.push(sha); return '2026-09-21T16:02:28Z'; },
    });
    const claimed = commitsToClaimOnLateRegistration({
      candidates: streamClaimCandidates(d, SESSION),
      conversationStartedAtMs: CHAT_START,
      registeredAtMs: REGISTERED,
      sessionId: SESSION,
      editedFiles: [OUR_FILE],
      localCommitterEmails: [US],
    });
    expect(claimed).toEqual([]);
    expect(probed).toEqual(['head']);
  });
});

describe('the gates that ask whether the commit is OURS, not whether it is recorded', () => {
  const SESSION = 'd74b8927-38a2-4e84-96af-f6605c94599f';
  it('declines a commit we REPLAYED but did not write', () => {
    // A rebase or cherry-pick of somebody else's commit makes us the
    // committer and leaves them the author, so the committer check passes by
    // construction — this is the one case it exists to catch.
    const replayed = { ...unowned('aaa1', '2026-09-21T16:02:28Z'), authorEmail: 'teammate@example.com' };
    expect(claim([replayed])).toEqual([]);
  });

  it('declines when the author email could not be read', () => {
    expect(claim([{ ...unowned('aaa1', '2026-09-21T16:02:28Z'), authorEmail: null }])).toEqual([]);
  });

  it('declines a commit somebody else committed', () => {
    // The pulled-teammate case: unrecorded, untrailered, unowned, in window,
    // over a file we edited — every signal the walk had before said take it.
    const theirs = { ...unowned('aaa1', '2026-09-21T16:02:28Z'), committerEmail: 'teammate@example.com' };
    expect(claim([theirs])).toEqual([]);
  });

  it('declines a commit over files this conversation never touched', () => {
    // The human's own `git commit -m wip` in the same window.
    const elsewhere = { ...unowned('aaa1', '2026-09-21T16:02:28Z'), touchedFiles: ['docs/THEIRS.md'] };
    expect(claim([elsewhere])).toEqual([]);
  });

  it('claims a commit that touches ANY file we edited, not all of them', () => {
    const mixed = { ...unowned('aaa1', '2026-09-21T16:02:28Z'), touchedFiles: ['docs/THEIRS.md', OUR_FILE] };
    expect(claim([mixed])).toEqual(['aaa1']);
  });

  it('declines when the file list or the committer could not be read', () => {
    expect(claim([{ ...unowned('aaa1', '2026-09-21T16:02:28Z'), touchedFiles: null }])).toEqual([]);
    expect(claim([{ ...unowned('aaa1', '2026-09-21T16:02:28Z'), committerEmail: null }])).toEqual([]);
    expect(claim([{ ...unowned('aaa1', '2026-09-21T16:02:28Z'), touchedFiles: [] }])).toEqual([]);
  });

  it('claims NOTHING when the transcript recorded no edits', () => {
    // No file evidence is not a reason to fall back on the time window: the
    // window can be six hours wide when the transcript reaches back into a
    // resumed conversation.
    expect(claim([unowned('aaa1', '2026-09-21T16:02:28Z')], { editedFiles: [] })).toEqual([]);
  });

  it('claims NOTHING when our own committer identity is unknown', () => {
    expect(claim([unowned('aaa1', '2026-09-21T16:02:28Z')], { localCommitterEmails: null })).toEqual([]);
    expect(claim([unowned('aaa1', '2026-09-21T16:02:28Z')], { localCommitterEmails: [] })).toEqual([]);
  });

  // The two checks above are also enforced per candidate, so removing either
  // up-front return leaves the ANSWER unchanged — the walk just discovers it
  // one candidate later. What changes is the cost: the candidate stream is
  // lazy and each probe is four git processes on the prompt-submit hook's
  // critical path. These pin that a claim we already know is impossible costs
  // no git at all.
  const countingProbes = () => {
    const probed: string[] = [];
    return {
      probed,
      deps: {
        listRecentShas: () => ['head'],
        commitDateIso: (sha: string) => { probed.push(sha); return '2026-09-21T16:02:28Z'; },
        hasOriginNote: () => false,
        commitBody: () => 'no trailer here',
        shasOwnedByOtherLiveSessions: () => [],
        committerEmail: () => US,
        authorEmail: () => US,
        filesInCommit: () => [OUR_FILE],
      } as ClaimProbeDeps,
    };
  };

  it('checks the budget between candidates, not only on entry', () => {
    // A check hoisted out of the loop passes any test whose budget was
    // already spent before the first probe. Here the clock crosses the
    // deadline only AFTER the first candidate has been probed.
    const probed: string[] = [];
    let ticks = 0;
    const d = {
      listRecentShas: () => ['first', 'second', 'third'],
      commitDateIso: (sha: string) => { probed.push(sha); return '2026-09-21T16:02:28Z'; },
      hasOriginNote: () => false,
      commitBody: () => 'no trailer here',
      shasOwnedByOtherLiveSessions: () => [],
      committerEmail: () => US,
      authorEmail: () => US,
      // Everything is claimable, so only the budget can end this walk.
      filesInCommit: () => [OUR_FILE],
    } as ClaimProbeDeps;
    // now() = 100 on the first check, 200 thereafter; deadline 150.
    const now = () => (ticks++ === 0 ? 100 : 200);
    const claimed = commitsToClaimOnLateRegistration({
      candidates: streamClaimCandidates(d, SESSION, CLAIM_WALK_LIMIT, 150, now),
      conversationStartedAtMs: CHAT_START,
      registeredAtMs: REGISTERED,
      sessionId: SESSION,
      editedFiles: [OUR_FILE],
      localCommitterEmails: [US],
    });
    expect(probed).toEqual(['first']);
    expect(claimed).toEqual(['first']);
  });

  it('probes nothing at all when there are no edited files to match', () => {
    const { probed, deps: d } = countingProbes();
    const claimed = commitsToClaimOnLateRegistration({
      candidates: streamClaimCandidates(d, SESSION),
      conversationStartedAtMs: CHAT_START,
      registeredAtMs: REGISTERED,
      sessionId: SESSION,
      editedFiles: [],
      localCommitterEmails: [US],
    });
    expect(claimed).toEqual([]);
    expect(probed).toEqual([]);
  });

  it('probes nothing at all when we do not know who we commit as', () => {
    const { probed, deps: d } = countingProbes();
    const claimed = commitsToClaimOnLateRegistration({
      candidates: streamClaimCandidates(d, SESSION),
      conversationStartedAtMs: CHAT_START,
      registeredAtMs: REGISTERED,
      sessionId: SESSION,
      editedFiles: [OUR_FILE],
      localCommitterEmails: [],
    });
    expect(claimed).toEqual([]);
    expect(probed).toEqual([]);
  });

  it('compares paths exactly — a basename or suffix match is not a match', () => {
    // A hot file like `index.ts` is how a stranger's commit gets to look like
    // ours. Missing a claim costs a repair; a loose match costs attribution.
    const nested = { ...unowned('aaa1', '2026-09-21T16:02:28Z'), touchedFiles: ['vendor/src/thing.ts'] };
    expect(claim([nested])).toEqual([]);
    const dotted = { ...unowned('bbb1', '2026-09-21T16:02:28Z'), touchedFiles: [`./${OUR_FILE}`] };
    expect(claim([dotted])).toEqual(['bbb1']);
  });

  it('a stranger\'s commit is a FLOOR — the walk does not hop over it', () => {
    const ours = unowned('ours', '2026-09-21T16:02:28Z');
    const theirs = { ...unowned('theirs', '2026-09-21T16:01:00Z'), committerEmail: 'teammate@example.com' };
    const older = unowned('older', '2026-09-21T16:00:00Z');
    expect(claim([ours, theirs, older])).toEqual(['ours']);
  });
});
