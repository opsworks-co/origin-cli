// Origin injects repo brief + attribution + session memory + handoff at session
// start. Attribution (commit-level) and memory (session-level) each carry a
// "recent work" list and a "hot files" list — two near-duplicates the agent must
// reconcile. assembleRepoContext deduplicates: when memory is present, attribution
// collapses to just its AI-authorship headline.
import { describe, it, expect } from 'vitest';
import { assembleRepoContext, attributionHeadline } from '../context-injection.js';

const ATTRIBUTION = `Repository AI context: 97% of recent commits (28/29) are AI-generated.
Recent AI activity:
  - gemini-cli wrote bouncing_ball.py on 2026-08-07 (gemini-3.1-pro)
Top AI-modified files:
  - eleven-rows-new.txt (4 AI commits)`;

const MEMORY = `Prior work in this repo — 2 sessions (claude-code, antigravity):
- Most recent: [31m ago] create some small nice script
  Files: nice_script.py
- Frequently touched: nice_script.py, bouncing_ball.py`;

describe('attributionHeadline', () => {
  it('returns just the AI-authorship headline line', () => {
    expect(attributionHeadline(ATTRIBUTION)).toBe('Repository AI context: 97% of recent commits (28/29) are AI-generated.');
  });
});

describe('assembleRepoContext', () => {
  it('collapses attribution to its headline when memory is present (dedup)', () => {
    const out = assembleRepoContext({ attribution: ATTRIBUTION, memory: MEMORY })!;
    expect(out).toContain('Repository AI context: 97%');
    // attribution's duplicate lists are dropped...
    expect(out).not.toContain('Recent AI activity');
    expect(out).not.toContain('Top AI-modified files');
    // ...and memory's richer lists remain
    expect(out).toContain('Prior work in this repo');
    expect(out).toContain('Frequently touched');
  });

  it('keeps the FULL attribution block when there is no memory (fresh repo)', () => {
    const out = assembleRepoContext({ attribution: ATTRIBUTION })!;
    expect(out).toContain('Recent AI activity');
    expect(out).toContain('Top AI-modified files');
  });

  it('orders blocks: brief → attribution → memory → handoff', () => {
    const out = assembleRepoContext({
      brief: 'About this repository: a widget lib.',
      attribution: ATTRIBUTION,
      memory: MEMORY,
      handoff: 'Previous session context (cursor, 5m ago):\nFiles in progress: auth.ts',
    })!;
    const iBrief = out.indexOf('About this repository');
    const iAttr = out.indexOf('Repository AI context');
    const iMem = out.indexOf('Prior work in this repo');
    const iHand = out.indexOf('Previous session context');
    expect(iBrief).toBeGreaterThanOrEqual(0);
    expect(iBrief).toBeLessThan(iAttr);
    expect(iAttr).toBeLessThan(iMem);
    expect(iMem).toBeLessThan(iHand);
  });

  it('returns null when every block is empty', () => {
    expect(assembleRepoContext({})).toBeNull();
    expect(assembleRepoContext({ brief: '', attribution: null, memory: '  ', handoff: undefined })).toBeNull();
  });

  it('joins only the non-empty blocks', () => {
    const out = assembleRepoContext({ memory: MEMORY, handoff: null })!;
    expect(out).toBe(MEMORY);
  });
});
