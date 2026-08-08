// The TODO extractor feeds "Open TODOs from previous sessions" into injected
// context. The unanchored "we need to <anything>" pattern used to capture
// conversational instructions as durable TODOs (observed: "swithc gh user I
// believe but switch it back after" leaked in). It's now dev-verb-anchored and
// rejects hedged phrasing.
import { describe, it, expect } from 'vitest';
import { extractTodosFromPrompts } from '../handoff.js';

describe('extractTodosFromPrompts precision', () => {
  it('does NOT capture conversational instructions as TODOs', () => {
    expect(extractTodosFromPrompts(['we need to swithc gh user I believe but switch it back after'])).toEqual([]);
    expect(extractTodosFromPrompts(['push the shit to remote'])).toEqual([]);
    expect(extractTodosFromPrompts(['can you merge it into main'])).toEqual([]);
    // hedged intent is a passing thought, not a firm TODO
    expect(extractTodosFromPrompts(['we should probably refactor the auth flow'])).toEqual([]);
  });

  it('still captures explicit markers and dev-verb-anchored intent', () => {
    expect(extractTodosFromPrompts(['TODO: wire refresh-token rotation'])).toEqual(['wire refresh-token rotation']);
    expect(extractTodosFromPrompts(['FIXME: handle the null case in parseDate'])).toContain('handle the null case in parseDate');
    // dev-verb-anchored, verb kept in the text
    expect(extractTodosFromPrompts(['we need to add pagination to the results list'])).toEqual(['add pagination to the results list']);
    expect(extractTodosFromPrompts(['still need to implement the retry backoff'])).toEqual(['implement the retry backoff']);
  });

  it('dedupes and caps', () => {
    const many = Array.from({ length: 15 }, (_, i) => `TODO: task number ${i}`);
    expect(extractTodosFromPrompts([...many, 'TODO: task number 0'])).toHaveLength(10);
  });
});
