/**
 * A turn's diff must land on that turn's row.
 *
 * `promptIndex` is a turn's POSITION in `state.prompts`, and the server keys
 * PromptChange rows on it — so an index that is off by one doesn't lose a
 * diff, it hands that diff to a DIFFERENT turn. Two prod sessions:
 *
 *   • 3bfa24e6 — stored 4 prompts against a 6-prompt transcript (the state
 *     file was created after turn 1). `reconcilePromptHistory` fell through to
 *     its concatenation fallback, producing a 10-entry list with every prompt
 *     twice and reporting the current turn as index 9 when it was index 5. The
 *     dashboard showed a read-only investigation turn owning +665 lines and a
 *     commit from a different session's branch.
 *
 *   • c5c94af7 (upplabs.com) — turn 1 ran eight read-only commands (`which`,
 *     `ls`, `cat`, `flyctl`) and held turn 5's 81KB article-editor diff plus a
 *     commit made 88 minutes later.
 *
 * The shared shape: the stored list starts LATE, so it is neither a prefix of
 * the transcript nor an overlap of its tail — the two cases the old rules
 * handled.
 */
import { describe, it, expect } from 'vitest';
import { reconcilePromptHistory, homePromptIndexByText, clipMappingsToPromptHistory } from '../session-state.js';

describe('reconcilePromptHistory — a late-starting stored list', () => {
  // Verbatim from prod session 3bfa24e6: the state file missed turn 1, and the
  // transcript also carries an interrupt marker the hook never recorded.
  const TRANSCRIPT = [
    'Why AI blame in this session wasnt captured for all prompts with changes',
    'now fix the capture side so shell writes get recorded',
    'merge it and cut the CLI release',
    'now fix the turn-1 mis-stamp',
    '[Request interrupted by user]',
    'Watcher-only agents remain uncovered — Gemini, Antigravity, hookless Cursor.',
  ];
  const STORED = [
    'now fix the capture side so shell writes get recorded',
    'merge it and cut the CLI release',
    'now fix the turn-1 mis-stamp',
    'Watcher-only agents remain uncovered — Gemini, Antigravity, hookless Cursor.',
  ];

  it('adopts the transcript numbering instead of concatenating', () => {
    const out = reconcilePromptHistory(STORED, TRANSCRIPT);
    expect(out).toEqual(TRANSCRIPT);
    // The number that actually mattered: this reported 9 before the fix.
    expect(out.length - 1).toBe(5);
    // …and index 0 stops meaning "turn 2".
    expect(out[0]).toBe(TRANSCRIPT[0]);
  });

  it('keeps a newest prompt the transcript has not flushed yet at the END', () => {
    const pending = 'a brand new prompt';
    const out = reconcilePromptHistory([...STORED, pending], TRANSCRIPT);
    expect(out).toEqual([...TRANSCRIPT, pending]);
    // It must take the NEXT index, never overwrite the last known turn.
    expect(out.length - 1).toBe(6);
  });

  it('still takes the transcript when stored is a plain prefix (ordinary growth)', () => {
    const stored = TRANSCRIPT.slice(0, 3);
    expect(reconcilePromptHistory(stored, TRANSCRIPT)).toEqual(TRANSCRIPT);
  });

  it('still refuses to renumber when the transcript ROLLED and lost its head', () => {
    // The 0a8e2164 case the original rules were written for: the transcript can
    // only see the tail, and adopting it would renumber rows already written.
    const stored = ['p0', 'p1', 'p2', 'p3', 'p4'];
    const rolled = ['p3', 'p4', 'p5'];
    expect(reconcilePromptHistory(stored, rolled)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('never shrinks the index space, whatever the inputs', () => {
    const cases: Array<[string[], string[]]> = [
      [STORED, TRANSCRIPT],
      [['p0', 'p1'], ['p0', 'p1', 'p2']],
      [['p2', 'p3'], ['p0', 'p1', 'p2', 'p3']],
      [['p0', 'p1', 'p2'], ['x', 'y']],
      [['only'], []],
      [[], ['a', 'b']],
    ];
    for (const [stored, parsed] of cases) {
      const out = reconcilePromptHistory(stored, parsed);
      expect(out.length).toBeGreaterThanOrEqual(stored.length);
    }
  });

  it('handles repeated prompt text without duplicating history', () => {
    const transcript = ['start', 'Try again', 'Try again', 'done'];
    const stored = ['Try again', 'Try again', 'done'];
    expect(reconcilePromptHistory(stored, transcript)).toEqual(transcript);
  });
});

describe('homePromptIndexByText — the write-site guard', () => {
  const mappings = [
    { promptIndex: 0, promptText: 'Why AI blame in this session wasnt captured' },
    { promptIndex: 1, promptText: 'now fix the capture side so shell writes get recorded' },
    { promptIndex: 2, promptText: 'merge it and cut the CLI release' },
  ];

  it('keeps the index when the transcript agrees', () => {
    expect(homePromptIndexByText(1, 'now fix the capture side so shell writes get recorded', mappings)).toBe(1);
  });

  it('re-homes to the row whose text matches when the counter is off by one', () => {
    // The exact prod shape: counter says 0, but that row is another turn.
    expect(homePromptIndexByText(0, 'merge it and cut the CLI release', mappings)).toBe(2);
  });

  it('refuses to write when the index belongs to a different turn and nothing matches', () => {
    expect(homePromptIndexByText(0, 'a prompt the transcript never saw', mappings)).toBeNull();
  });

  it('allows the safety net: no mapping at this index means a genuinely new turn', () => {
    expect(homePromptIndexByText(3, 'a brand new prompt', mappings)).toBe(3);
    expect(homePromptIndexByText(0, 'anything', [])).toBe(0);
  });

  it('tolerates truncation and whitespace differences between the two records', () => {
    const truncated = [{ promptIndex: 0, promptText: 'now fix the capture side so shell' }];
    expect(homePromptIndexByText(0, 'now fix the capture side so shell writes get recorded', truncated)).toBe(0);
    const spaced = [{ promptIndex: 0, promptText: 'now fix   the capture\nside' }];
    expect(homePromptIndexByText(0, 'now fix the capture side', spaced)).toBe(0);
  });

  it('prefers the LAST match when the same prompt text repeats', () => {
    const repeated = [
      { promptIndex: 0, promptText: 'Try again' },
      { promptIndex: 1, promptText: 'something else' },
      { promptIndex: 2, promptText: 'Try again' },
    ];
    expect(homePromptIndexByText(1, 'Try again', repeated)).toBe(2);
  });
});

describe('reconcilePromptHistory — the two producers do not agree byte for byte', () => {
  // Verbatim shapes from session 2a93541b (7 dashboard turns for 5 prompts).
  // The hook stores Claude Code's payload, which renders each attached image
  // as a trailing `[image]`; the Stop-time parser rebuilds the prompt from the
  // JSONL text block (no placeholder) and cuts anything over 1000 chars.
  const AGY = 'I resumed work in old agy session, but instead of keeping working in that session it spawned a new session';
  const HOOK_IMAGE = `${AGY}\n[image] [image]`;
  const PARSED_IMAGE = AGY;
  const LONG = ('`origin why <file>:<line>` and `origin prompts <file>` return nothing when run from inside a linked git worktree, because ' + 'the path they look up is prefixed with the worktree location. '.repeat(30)).slice(0, 1398);
  const PARSED_LONG = LONG.slice(0, 1000) + '...';
  expect(LONG.length).toBe(1398);

  it('an image prompt is one prompt, whichever side rendered the placeholder', () => {
    const out = reconcilePromptHistory([HOOK_IMAGE], [PARSED_IMAGE]);
    expect(out).toHaveLength(1);
    // …and the record kept is the hook's fuller one.
    expect(out[0]).toBe(HOOK_IMAGE);
  });

  it('a prompt the transcript truncated at 1000 chars is one prompt', () => {
    const out = reconcilePromptHistory([LONG], [PARSED_LONG]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(LONG);
  });

  it('replays session 2a93541b: five prompts stay five across every Stop', () => {
    // Stop of turn 1 — this is where index 1 used to appear.
    let stored = reconcilePromptHistory([HOOK_IMAGE], [PARSED_IMAGE]);
    expect(stored).toHaveLength(1);
    // Prompt 2 arrives via the hook; Stop of turn 2 reconciles again.
    stored = reconcilePromptHistory([...stored, LONG], [PARSED_IMAGE, PARSED_LONG]);
    expect(stored).toHaveLength(2);
    // Three short plain prompts, exact on both sides.
    for (const p of ['fix blame and ask too, then open the PR', 'merge it and tag the release', 'go ahead and merge once CI is green']) {
      stored = reconcilePromptHistory([...stored, p], [PARSED_IMAGE, PARSED_LONG, ...stored.slice(2), p]);
    }
    expect(stored).toHaveLength(5);
    expect(stored[0]).toBe(HOOK_IMAGE);
    expect(stored[1]).toBe(LONG);
  });

  it('two distinct prompts that share their first 200 chars are still two prompts', () => {
    const base = 'x'.repeat(250);
    const a = base + ' first'; const b = base + ' second';
    expect(reconcilePromptHistory([a], [a, b])).toEqual([a, b]);
    expect(reconcilePromptHistory([a, b], [a, b])).toEqual([a, b]);
  });

  it('a genuinely re-sent prompt still lands as a second row', () => {
    expect(reconcilePromptHistory(['try again'], ['try again', 'try again'])).toEqual(['try again', 'try again']);
  });

  it('Cursor collapseTrailingRepeat drops a transcript echo of the last prompt', () => {
    expect(reconcilePromptHistory(
      ['do 1 and 2', 'open PR'],
      ['do 1 and 2', 'open PR', 'open PR'],
      { collapseTrailingRepeat: true },
    )).toEqual(['do 1 and 2', 'open PR']);
    // Off by default — Claude/Codex may really send the same sentence twice.
    expect(reconcilePromptHistory(
      ['open PR'],
      ['open PR', 'open PR'],
    )).toEqual(['open PR', 'open PR']);
  });

  it('Cursor timestamp / image envelope is the same prompt as the inner text', () => {
    // Session 562314d8: the hook stored Cursor's payload (timestamp + [Image]
    // + image_files + user_query), Stop parsed the inner sentence. Before
    // promptKey peeled those envelopes they were two turns.
    const inner = "why the PR doesn't have this session linked";
    const hook = [
      '[Image]',
      '<image_files>',
      'The following images were provided by the user and saved to disk for future use:',
      '1. /Users/me/.cursor/projects/origin/assets/shot.png',
      '</image_files>',
      '<timestamp>Monday, Sep 7, 2026, 7:57 PM (UTC-4)</timestamp>',
      `<user_query>\n${inner}\n</user_query>`,
    ].join('\n');
    expect(reconcilePromptHistory([hook], [inner])).toEqual([hook]);
    expect(reconcilePromptHistory([hook], [`${inner}\n[image]`])).toHaveLength(1);
    const stamped = `<timestamp>Monday, Sep 7, 2026, 9:08 PM (UTC-4)</timestamp>\n\nDid you opened PR or what? I deploy from claude. Who's gonan bump the cli?`;
    const plain = "Did you opened PR or what? I deploy from claude. Who's gonan bump the cli?";
    expect(reconcilePromptHistory([stamped], [plain])).toEqual([stamped]);
  });
});

describe('clipMappingsToPromptHistory', () => {
  it('drops a transcript echo past the reconciled prompt list', () => {
    // 17:25 Stop on c7cc460f: four stored prompts, five transcript mappings.
    const mappings = [
      { promptIndex: 3, promptText: 'open PR', filesChanged: [] as string[] },
      { promptIndex: 4, promptText: 'open PR', filesChanged: [] as string[] },
    ];
    expect(clipMappingsToPromptHistory(mappings, ['a', 'b', 'c', 'open PR'])).toEqual([
      { promptIndex: 3, promptText: 'open PR', filesChanged: [] },
    ]);
  });

  it('does not rewrite a mapping whose text disagrees with the hook (numbering may have drifted)', () => {
    const mappings = [
      { promptIndex: 4, promptText: 'open PR', filesChanged: ['sessions.ts'] },
    ];
    expect(clipMappingsToPromptHistory(
      mappings,
      ['a', 'b', 'c', 'open PR', 'capture for this session has a lot of bugs'],
    )).toEqual(mappings);
  });

  it('keeps the [image] placeholder when hook and transcript describe the same prompt', () => {
    const hook = 'capture for this session has a lot of bugs';
    const mapped = `${hook}\n[image]`;
    const out = clipMappingsToPromptHistory(
      [{ promptIndex: 0, promptText: mapped }],
      [hook],
    );
    expect(out[0].promptText).toBe(mapped);
  });
});
