// Origin injects repo brief + attribution + session memory + handoff at session
// start. Attribution (commit-level) and memory (session-level) each carry a
// "recent work" list and a "hot files" list — two near-duplicates the agent must
// reconcile. assembleRepoContext deduplicates: when memory is present, attribution
// goes entirely — its "X% AI-generated" headline changes no decision.
import { describe, it, expect } from 'vitest';
import { assembleRepoContext } from '../context-injection.js';

const ATTRIBUTION = `Repository AI context: 97% of recent commits (28/29) are AI-generated.
Recent AI activity:
  - gemini-cli wrote bouncing_ball.py on 2026-08-07 (gemini-3.1-pro)
Top AI-modified files:
  - eleven-rows-new.txt (4 AI commits)`;

const MEMORY = `Prior work in this repo — 2 sessions (claude-code, antigravity):
- Most recent: [31m ago] create some small nice script
  Files: nice_script.py
- Frequently touched: nice_script.py, bouncing_ball.py`;

describe('assembleRepoContext', () => {
  it('drops attribution entirely when memory is present (dedup)', () => {
    const out = assembleRepoContext({ attribution: ATTRIBUTION, memory: MEMORY })!;
    expect(out).not.toContain('Repository AI context');
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

  it('orders blocks: brief → attribution → handoff without memory, brief → memory → handoff with it', () => {
    const blocks = {
      brief: 'About this repository: a widget lib.',
      attribution: ATTRIBUTION,
      handoff: 'Previous session context (cursor, 5m ago):\nFiles in progress: auth.ts',
    };
    const bare = assembleRepoContext(blocks)!;
    expect(bare.indexOf('About this repository')).toBeGreaterThanOrEqual(0);
    expect(bare.indexOf('About this repository')).toBeLessThan(bare.indexOf('Repository AI context'));
    expect(bare.indexOf('Repository AI context')).toBeLessThan(bare.indexOf('Previous session context'));

    const withMemory = assembleRepoContext({ ...blocks, memory: MEMORY })!;
    expect(withMemory.indexOf('About this repository')).toBeLessThan(withMemory.indexOf('Prior work in this repo'));
    expect(withMemory.indexOf('Prior work in this repo')).toBeLessThan(withMemory.indexOf('Previous session context'));
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
