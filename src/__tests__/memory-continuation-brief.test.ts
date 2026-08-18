// Regression for the "Origin memory is a solid index, but not a continuation
// brief" review. A reviewing agent reading the memory of a real repo could tell
// what changed and where, but not what the work was FOR, what was left, or how
// to check it. Inspecting the stored notes showed the capture side was mostly
// already there and simply never plumbed through:
//
//   • [Origin: Intent] / [Origin: Open] / [Origin: Verify] were all PARSED and
//     then dropped — only `.decision` was ever read into memory.
//   • `summary` was being used as intent, but it holds the agent's own
//     narration ("I'll wire constellations into the oracle, then commit") —
//     a plan, not the ask.
//   • filesChanged was never deduped, so the digest shipped lines like
//     "wisdom.py, oracle.py, .gitignore, constellations.py, constellations.py,
//     oracle.py, wisdom.py" — 7 entries, 4 unique.

import { describe, expect, it } from 'vitest';
import { buildMemoryEntry } from '../commands/hooks.js';

const state = { sessionId: 's1', startedAt: '2026-08-10T00:00:00.000Z', agentSlug: 'cursor' };
const base = { model: 'm', branch: 'main', linesAdded: 1, linesRemoved: 0 };

describe('buildMemoryEntry — filesChanged dedup', () => {
  it('collapses the repeated paths that bloated the digest', () => {
    const entry = buildMemoryEntry(state, {
      ...base,
      // Verbatim from the oseledec memory note.
      filesChanged: ['wisdom.py', 'oracle.py', '.gitignore', 'constellations.py', 'constellations.py', 'oracle.py', 'wisdom.py'],
      prompts: ['add constellations'],
    });
    expect(entry.filesChanged).toEqual(['wisdom.py', 'oracle.py', '.gitignore', 'constellations.py']);
  });

  it('preserves first-seen order and trims blanks', () => {
    const entry = buildMemoryEntry(state, {
      ...base, filesChanged: ['b.ts', '  ', 'a.ts', ' b.ts '], prompts: ['x'],
    });
    expect(entry.filesChanged).toEqual(['b.ts', 'a.ts']);
  });
});

describe('buildMemoryEntry — intent (what the USER asked for)', () => {
  it('prefers [Origin: Intent] markers over the agent narration in summary', () => {
    const entry = buildMemoryEntry(state, {
      ...base,
      filesChanged: ['oracle.py'],
      prompts: ['make the oracle show star charts'],
      summary: "I'll wire constellations into the oracle, then commit.",
      markers: { intent: ['Give each reading a constellation chart so output feels richer'] },
    });
    expect(entry.intent).toEqual(['Give each reading a constellation chart so output feels richer']);
    // summary is untouched — it still records what the agent DID.
    expect(entry.summary).toBe("I'll wire constellations into the oracle, then commit.");
  });

  it('falls back to the user first prompt VERBATIM when no marker was emitted', () => {
    const entry = buildMemoryEntry(state, {
      ...base,
      filesChanged: ['oracle.py'],
      prompts: ['make the oracle show star charts'],
      summary: "I'll wire constellations into the oracle, then commit.",
    });
    // The ask, not the plan — this is the whole point of the field.
    expect(entry.intent).toEqual(['make the oracle show star charts']);
  });

  it('is omitted entirely when there is neither a marker nor a prompt', () => {
    const entry = buildMemoryEntry({ ...state, prompts: [] }, { ...base, filesChanged: ['a.ts'], prompts: [] });
    expect(entry.intent).toBeUndefined();
  });
});

describe('buildMemoryEntry — open + verify markers', () => {
  it('merges [Origin: Open] into openTodos alongside prompt-mined TODOs', () => {
    const entry = buildMemoryEntry(state, {
      ...base,
      filesChanged: ['a.ts'],
      prompts: ['TODO: add a --json flag'],
      markers: { open: ['Chart alignment is off for 3-char signs'] },
    });
    expect(entry.openTodos).toContain('Chart alignment is off for 3-char signs');
    expect(entry.openTodos.length).toBeGreaterThanOrEqual(1);
  });

  it('carries [Origin: Verify] through as its own field', () => {
    const entry = buildMemoryEntry(state, {
      ...base,
      filesChanged: ['a.ts'],
      prompts: ['x'],
      markers: { verify: ['python oracle.py --mood calm — prints a chart'] },
    });
    expect(entry.verify).toEqual(['python oracle.py --mood calm — prints a chart']);
  });

  it('dedupes markers and omits empty buckets', () => {
    const entry = buildMemoryEntry(state, {
      ...base,
      filesChanged: ['a.ts'],
      prompts: ['x'],
      markers: { verify: ['npm test', 'npm test', '  '], open: [] },
    });
    expect(entry.verify).toEqual(['npm test']);
  });
});
