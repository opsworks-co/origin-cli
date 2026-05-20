/**
 * Tests for the Codex per-prompt commit-to-prompt mapping. The runtime
 * helpers (getSessionCommitsWithTimes, buildDiffForCommitRange) shell out
 * to git so we don't cover them here — the logic that decides which prompt
 * owns each commit is pure and can be unit-tested with synthetic data.
 *
 * Regression context: before the backfill, Codex sessions only got
 * per-prompt diffs for the 1-2 prompts where user-prompt-submit happened to
 * fire. AGENTS.md and similar files showed AI attribution on the first
 * prompt only, even when later prompts had clearly modified them.
 */

import { describe, it, expect } from 'vitest';
import {
  groupCommitsByPrompt,
  mapCommitsToPromptsFromRollout,
  type CodexPrompt,
  type CodexCommit,
} from '../codex-prompt-mapping.js';

const sec = (s: number) => s * 1000;

describe('groupCommitsByPrompt — time-based attribution', () => {
  it('maps each commit to the latest prompt whose timestamp is at-or-before it', () => {
    const prompts: CodexPrompt[] = [
      { text: 'first', timestamp: sec(100) },
      { text: 'second', timestamp: sec(200) },
      { text: 'third', timestamp: sec(300) },
    ];
    const commits: CodexCommit[] = [
      { sha: 'aaaa', parentSha: 'pa', timestamp: sec(150) },
      { sha: 'bbbb', parentSha: 'aaaa', timestamp: sec(250) },
      { sha: 'cccc', parentSha: 'bbbb', timestamp: sec(350) },
    ];
    const grouped = groupCommitsByPrompt(prompts, commits);
    expect(grouped.get(0)?.map(c => c.sha)).toEqual(['aaaa']);
    expect(grouped.get(1)?.map(c => c.sha)).toEqual(['bbbb']);
    expect(grouped.get(2)?.map(c => c.sha)).toEqual(['cccc']);
  });

  it('puts a commit before all prompts into the last prompt (no orphans)', () => {
    const prompts: CodexPrompt[] = [
      { text: 'first', timestamp: sec(100) },
      { text: 'second', timestamp: sec(200) },
    ];
    const commits: CodexCommit[] = [
      { sha: 'orphan', parentSha: null, timestamp: sec(50) },
    ];
    const grouped = groupCommitsByPrompt(prompts, commits);
    // Falls through to the last prompt rather than being dropped.
    expect(grouped.get(1)?.map(c => c.sha)).toEqual(['orphan']);
  });

  it('groups multiple commits within a single prompt window', () => {
    const prompts: CodexPrompt[] = [
      { text: 'one prompt', timestamp: sec(100) },
      { text: 'next prompt', timestamp: sec(500) },
    ];
    const commits: CodexCommit[] = [
      { sha: 'c1', parentSha: 'p',  timestamp: sec(150) },
      { sha: 'c2', parentSha: 'c1', timestamp: sec(200) },
      { sha: 'c3', parentSha: 'c2', timestamp: sec(450) },
    ];
    const grouped = groupCommitsByPrompt(prompts, commits);
    expect(grouped.get(0)?.map(c => c.sha)).toEqual(['c1', 'c2', 'c3']);
    expect(grouped.get(1)).toBeUndefined();
  });

  it('falls back to the last prompt when timestamps are missing on either side', () => {
    const prompts: CodexPrompt[] = [
      { text: 'a', timestamp: 0 },
      { text: 'b', timestamp: 0 },
    ];
    const commits: CodexCommit[] = [
      { sha: 'x', parentSha: null, timestamp: sec(100) },
    ];
    const grouped = groupCommitsByPrompt(prompts, commits);
    // With every prompt timestamp == 0, every commit falls through to the
    // last index. Better than dropping it; matches the legacy
    // resolvePromptForCommit fallback in hooks.ts.
    expect(grouped.get(1)?.map(c => c.sha)).toEqual(['x']);
  });

  it('returns an empty map when prompts is empty', () => {
    expect(groupCommitsByPrompt([], [{ sha: 'a', parentSha: null, timestamp: 0 }])).toEqual(new Map());
  });

  it('returns an empty map when commits is empty', () => {
    expect(groupCommitsByPrompt([{ text: 'p', timestamp: 100 }], [])).toEqual(new Map());
  });

  it('regression: every prompt that produced a commit gets attribution (not just prompts 0-1)', () => {
    // Mirrors the production bug: 8 prompts, only prompts 0 and 1 were
    // attributed by the live user-prompt-submit capture. Commits from
    // prompts 2-7 must each land in their own prompt window.
    const prompts: CodexPrompt[] = Array.from({ length: 8 }, (_, i) => ({
      text: `prompt ${i}`,
      timestamp: sec(100 * (i + 1)),
    }));
    const commits: CodexCommit[] = Array.from({ length: 8 }, (_, i) => ({
      sha: `sha${i}`,
      parentSha: i === 0 ? 'base' : `sha${i - 1}`,
      timestamp: sec(100 * (i + 1) + 10),
    }));
    const grouped = groupCommitsByPrompt(prompts, commits);
    for (let i = 0; i < 8; i++) {
      expect(grouped.get(i)?.map(c => c.sha), `prompt ${i}`).toEqual([`sha${i}`]);
    }
  });
});

describe('mapCommitsToPromptsFromRollout — turn-scoped commit attribution', () => {
  // Codex's response_item event shape. Each event is one JSONL line.
  const userMsg = (text: string) =>
    JSON.stringify({
      payload: { type: 'message', role: 'user', content: [{ text }] },
    });
  const shellOutput = (text: string) =>
    JSON.stringify({
      payload: {
        type: 'function_call_output',
        output: { content: text },
      },
    });

  it('attributes each commit to the turn whose tool call produced it', () => {
    // Prompt 0: one commit "abc1234". Prompt 1: one commit "def5678".
    // The user types prompt 1 BEFORE prompt 0's commit actually lands —
    // but the commit is recorded inside prompt 0's turn (its function_call
    // output) so it must attribute to prompt 0, not prompt 1.
    const rollout = [
      userMsg('make 1 small change and commit'),
      shellOutput('[main abc1234] First change\n 1 file changed'),
      userMsg('make another change and commit'),
      shellOutput('[main def5678] Second change\n 1 file changed'),
    ].join('\n');

    const m = mapCommitsToPromptsFromRollout(rollout);
    expect(m.get('abc1234')).toBe(0);
    expect(m.get('def5678')).toBe(1);
  });

  it('regression: two consecutive turns with a single tool call each must produce distinct SHAs (no duplicates)', () => {
    // This is the exact bug shape from the production diag: pc[0] and pc[1]
    // ending up byte-identical because both got attributed to the same
    // turn. With turn-scoped mapping, sha→prompt is one-to-one.
    const rollout = [
      userMsg('first'),
      shellOutput('[main aaaaaaa] one'),
      userMsg('second'),
      shellOutput('[main bbbbbbb] two'),
      userMsg('third'),
      shellOutput('[main ccccccc] three'),
    ].join('\n');

    const m = mapCommitsToPromptsFromRollout(rollout);
    expect(m.size).toBe(3);
    expect([...m.values()].sort()).toEqual([0, 1, 2]);
  });

  it('handles multiple commits in the same turn (one prompt produced two commits)', () => {
    const rollout = [
      userMsg('big change'),
      shellOutput('[main aaaaaaa] part 1'),
      shellOutput('[main bbbbbbb] part 2'),
      userMsg('next'),
      shellOutput('[main ccccccc] part 3'),
    ].join('\n');

    const m = mapCommitsToPromptsFromRollout(rollout);
    expect(m.get('aaaaaaa')).toBe(0);
    expect(m.get('bbbbbbb')).toBe(0);
    expect(m.get('ccccccc')).toBe(1);
  });

  it('ignores AGENTS.md / <INSTRUCTIONS> wrappers and does NOT advance turn counter on them', () => {
    // Codex auto-injects an <INSTRUCTIONS>...</INSTRUCTIONS> blob and an
    // AGENTS.md echo as the first "user" events. Treating those as turns
    // would misalign every commit afterward.
    const rollout = [
      userMsg('<INSTRUCTIONS>auto-injected</INSTRUCTIONS>'),
      userMsg('<!-- origin-managed -->\nOrigin: tracking active'),
      userMsg('real user prompt'),
      shellOutput('[main abc1234] commit'),
    ].join('\n');

    const m = mapCommitsToPromptsFromRollout(rollout);
    // Real prompt should be index 0 (the wrappers were skipped).
    expect(m.get('abc1234')).toBe(0);
  });

  it('skips outputs that appear before any user message (avoids -1 promptIndex)', () => {
    const rollout = [
      shellOutput('[main abc1234] commit before any prompt'),
      userMsg('real prompt'),
      shellOutput('[main def5678] real prompt commit'),
    ].join('\n');

    const m = mapCommitsToPromptsFromRollout(rollout);
    expect(m.has('abc1234')).toBe(false);
    expect(m.get('def5678')).toBe(0);
  });

  it('returns empty map for empty / malformed rollouts', () => {
    expect(mapCommitsToPromptsFromRollout('')).toEqual(new Map());
    expect(mapCommitsToPromptsFromRollout('not json\n{also bad}')).toEqual(new Map());
  });
});
