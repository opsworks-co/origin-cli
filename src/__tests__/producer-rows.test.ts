// OR-11/A5, Codex review №6: the Cursor E2E's turn 5 took the FIRST new PATCH
// row of its promptIndex as after-file-edit's own send. Under the full suite's
// load a fire-and-forget user-prompt-submit PATCH (or a heartbeat) landed in
// the same window with the whole dirty tree, and the assertion checked the
// wrong producer. The harness now selects by provenance: the `afe_` captureId.
import { describe, it, expect } from 'vitest';
import { rowsFromProducer, type RecordedHit } from './helpers/producer-rows.js';

const patch = (...rows: Record<string, unknown>[]): RecordedHit => ({ method: 'PATCH', url: '/api/mcp/session/s', body: { promptChanges: rows } });
const afeRow = { promptIndex: 4, captureId: 'afe_0123456789abcdef', filesChanged: ['app.py'] };
const racing = { promptIndex: 4, captureId: 'hb_fedcba9876543210', filesChanged: ['app.py', 'notes.md'] };
const unstamped = { promptIndex: 4, filesChanged: ['app.py', 'notes.md'] };

describe('rowsFromProducer', () => {
  it('a non-AFE PATCH of the same promptIndex racing into the window, before or after the AFE send, is never picked', () => {
    const earlier = [patch({ promptIndex: 3, captureId: 'afe_aaaaaaaaaaaaaaaa' })];
    for (const window of [
      [patch(racing), patch(afeRow)],          // the racer landed first: the old harness took it
      [patch(afeRow), patch(racing)],          // the racer landed last
      [patch(unstamped), patch({ promptIndex: 3, captureId: 'afe_bbbbbbbbbbbbbbbb' }, afeRow)],
    ]) {
      const hits = [...earlier, ...window];
      const rows = rowsFromProducer(hits, earlier.length, 4, 'afe');
      expect(rows).toEqual([afeRow]);
      // What the old selection (first new row of the promptIndex) would have returned.
      const first = hits.slice(earlier.length).flatMap((h) => h.body.promptChanges).find((r: any) => r.promptIndex === 4);
      if (window[0].body.promptChanges[0] !== afeRow) expect(first).not.toBe(afeRow);
    }
  });

  it('the window starts at an index into ALL hits: POST/GET before it shift it, and only the new AFE row is returned', () => {
    const oldAfe = { promptIndex: 4, captureId: 'afe_0000000000000000', filesChanged: ['old.py'] };
    const newAfe = { promptIndex: 4, captureId: 'afe_ffffffffffffffff', filesChanged: ['app.py'] };
    const beforeBoundary: RecordedHit[] = [
      { method: 'POST', url: '/api/mcp/session/start', body: { agent: 'cursor' } },
      { method: 'GET', url: '/api/pricing', body: null },
      patch(oldAfe),
      { method: 'POST', url: '/api/mcp/session/s/prompt', body: { prompt: 'x' } },
    ];
    const hits: RecordedHit[] = [...beforeBoundary, patch(racing), patch(newAfe)];
    const boundary = beforeBoundary.length;
    expect(rowsFromProducer(hits, boundary, 4, 'afe')).toEqual([newAfe]);
    // Counting PATCHes instead (1 here) would open the window before the boundary and let the old row in.
    const patchCount = beforeBoundary.filter((h) => h.method === 'PATCH').length;
    expect(rowsFromProducer(hits, patchCount, 4, 'afe')).toEqual([oldAfe, newAfe]);
  });

  it('rows before the window, other methods, other prompt indexes and look-alike prefixes do not count', () => {
    const hits: RecordedHit[] = [
      patch(afeRow),
      { method: 'POST', body: { promptChanges: [afeRow] } },
      patch({ promptIndex: 5, captureId: 'afe_1111111111111111' }),
      patch({ promptIndex: 4, captureId: 'afex_2222222222222222' }),
      patch({ promptIndex: 4, captureId: 42 }),
    ];
    expect(rowsFromProducer(hits, 1, 4, 'afe')).toEqual([]);
    expect(rowsFromProducer(hits, 0, 4, 'afe')).toEqual([afeRow]);
  });
});
