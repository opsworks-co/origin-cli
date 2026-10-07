import { describe, it, expect } from 'vitest';
import { rowLineCounts } from '../turn-row-counts.js';

const twoLines = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n-old\n+one\n+two\n';

describe('rowLineCounts — a re-sent row keeps the counts it was measured with', () => {
  it("keeps stored counts that exceed the text's — the text is cut, the counts are not", () => {
    // prod c085f0af turn 2: git's +729/-175 beside a 2-of-4-file text
    expect(rowLineCounts({ diff: twoLines, linesAdded: 729, linesRemoved: 175 })).toEqual({ linesAdded: 729, linesRemoved: 175 });
  });
  it('keeps a stored zero pair — a chat-only turn is not recounted into its neighbours', () => {
    expect(rowLineCounts({ diff: twoLines, linesAdded: 0, linesRemoved: 0 })).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });
  it('recounts only a mapping that never carried counts', () => {
    expect(rowLineCounts({ diff: twoLines })).toEqual({ linesAdded: 2, linesRemoved: 1 });
    expect(rowLineCounts({ diff: twoLines, linesAdded: null, linesRemoved: undefined })).toEqual({ linesAdded: 2, linesRemoved: 1 });
  });
});
