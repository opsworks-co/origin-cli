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

  it('does not read talk ABOUT the TODO list, or a lowercase word, as a TODO', () => {
    // 2026-10-03: "give me todo list short" became the TODO "list short".
    expect(extractTodosFromPrompts(['give me todo list short'])).toEqual([]);
    expect(extractTodosFromPrompts(['give me TODO list short'])).toEqual([]);
    expect(extractTodosFromPrompts(['what is next on the todo list?'])).toEqual([]);
    expect(extractTodosFromPrompts(['note that the server restarts at 3am'])).toEqual([]);
    // Naming an existing item would mint a duplicate of it.
    expect(extractTodosFromPrompts(['TODO `87ec29e1`: repoLine still says the old thing'])).toEqual([]);
    expect(extractTodosFromPrompts(['take TODO 8865b51a next'])).toEqual([]);
  });

  it('still reads a marker: a colon in any case, or the word in capitals', () => {
    expect(extractTodosFromPrompts(['todo: rename the flag to --strict'])).toEqual(['rename the flag to --strict']);
    expect(extractTodosFromPrompts(['TODO add retries to the uploader'])).toEqual(['add retries to the uploader']);
    expect(extractTodosFromPrompts(['Note: the cache key must include the org'])).toEqual(['the cache key must include the org']);
  });
});
