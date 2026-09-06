// Three producers never stamped their rows, so the server's ordering rule —
// which engages only when BOTH sides carry a timestamp — treated them as
// EXEMPT: they outranked every stamped producer regardless of age. Found when
// the split of hooks.ts made the stamp guard judge each handler on its own.
//
//   • the Cursor afterFileEdit live PATCH: stamps NOW, so Stop's later
//     capture of the same turn wins, as it should;
//   • session-start's re-send of STORED rows on reattach: stamped at the
//     session's start, so it can only fill a row the server lacks;
//   • Antigravity: the real hook stamps NOW and remembers it; the watcher
//     sync, which re-reads the same baselines, borrows that time and can
//     never replace what the hook wrote.
import { describe, it, expect, vi } from 'vitest';
import { buildLiveEditPromptChanges } from '../commands/hooks/after-file-edit.js';

describe('the afterFileEdit live PATCH', () => {
  it('stamps every row with one capture id and a fresh time', () => {
    const before = Date.now();
    const rows = buildLiveEditPromptChanges([
      { promptIndex: 0, promptText: 'a', diff: 'diff --git a/x b/x\n+1\n', filesChanged: ['x'] },
      { promptIndex: 1, promptText: 'b', diff: '', filesChanged: [] },
    ]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(String(r.captureId)).toMatch(/^afe_/);
      expect(r.capturedAt).toBeGreaterThanOrEqual(before);
    }
    expect(rows[0].captureId).toBe(rows[1].captureId);
  });

  it('never lets a stored row\'s stale stamp override the send\'s', () => {
    const rows = buildLiveEditPromptChanges([{ promptIndex: 0, captureId: 'old_1', capturedAt: 1, diff: '' }]);
    expect(rows[0].captureId).toBe('old_1');   // a row that names its capture keeps it …
    expect(rows[0].capturedAt).toBe(1);        // … the spread order is stamp first, row second
  });
});

// The reattach re-send is a payload built inside handleSessionStart; its rule
// is pinned by reading the source, the way the stamp guard reads producers.
describe('session-start\'s reattach re-send', () => {
  it('stamps stored rows at the SESSION START, never now', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks', 'session-start.ts'), 'utf-8');
    const at = src.indexOf('promptChanges: existing.completedPromptMappings.map(');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 1200);
    expect(block).toContain("newCaptureStamp('ss')");
    expect(block).toMatch(/capturedAt: Number\.isFinite\(startedAtMs\)/);
    expect(block).toContain('...reattachStamp,');
  });
});
