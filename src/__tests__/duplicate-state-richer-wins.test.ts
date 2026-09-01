// Two state files, one server session — and the reader has to choose.
//
// #817 closed the duplicate minted by session-start. Cursor mints its second
// file from the OTHER door: `user-prompt-submit`'s auto-create path, which
// calls startSession itself, gets handed the same sessionId by the server's
// dedup ladder, and writes its own conversation-derived tag next to the minted
// one session-start just saved.
//
// Session eebcce84 (baton, 2026-08-26):
//   [session-start]      state saved {tag:"smta56mxu"}         prompts: []
//   [user-prompt-submit] auto-created {tag:"0e340a60-bc0"}     prompts: [1]
//   [findStateForHook]   tags:["0e340a60-bc0","smta56mxu"]
//   [after-file-edit]    ABORT: no current prompt              ← picked the empty one
//
// 23 of 23 edit hooks aborted; the session's entire live capture was lost. The
// finished session still looked correct because Stop rebuilt it from the
// transcript, which is exactly why nobody noticed.
//
// The merge guard on the auto-create path closes this at the source, but the
// two writers race, so the reader needs a tiebreak that isn't `startedAt`.

import { describe, it, expect } from 'vitest';
import { preferRicherSameSessionState, findDuplicateStateForSession } from '../session-dedup.js';

const ID = 'eebcce84-d185-4a82-a82a-01607b836e63';

describe('preferRicherSameSessionState', () => {
  it('drops the empty twin of a session and keeps the one holding the turns', () => {
    const empty = { sessionId: ID, sessionTag: 'smta56mxu', prompts: [] };
    const real = { sessionId: ID, sessionTag: '0e340a60-bc0', prompts: ['add a --strike transform'] };
    // Order as findStateForHook would hand them over — empty first, which is
    // what made this arbitrary.
    expect(preferRicherSameSessionState([empty, real])).toEqual([real]);
    expect(preferRicherSameSessionState([real, empty])).toEqual([real]);
  });

  it('breaks a prompts tie on recorded work, not on order', () => {
    const bare = { sessionId: ID, sessionTag: 'a', prompts: ['p'], completedPromptMappings: [] };
    const withWork = { sessionId: ID, sessionTag: 'b', prompts: ['p'], completedPromptMappings: [{}] };
    expect(preferRicherSameSessionState([bare, withWork])).toEqual([withWork]);
  });

  it('never promotes a different session over the agent/cwd match that selected the list', () => {
    const other = { sessionId: 'other', sessionTag: 'x', prompts: ['a', 'b', 'c'] };
    const mine = { sessionId: ID, sessionTag: 'y', prompts: ['p'] };
    // Both survive — they are different sessions, so this function has no
    // opinion, and the caller's existing ordering still decides.
    expect(preferRicherSameSessionState([mine, other])).toEqual([mine, other]);
  });

  it('leaves a single candidate and untagged entries alone', () => {
    const one = [{ sessionId: ID, prompts: [] }];
    expect(preferRicherSameSessionState(one)).toEqual(one);
    const noId = [{ prompts: [] }, { prompts: ['p'] }];
    expect(preferRicherSameSessionState(noId)).toEqual(noId);
  });
});

describe('findDuplicateStateForSession — the auto-create side of the race', () => {
  it("finds session-start's file when the auto-create path is about to add a second", () => {
    const onDisk = [{ sessionId: ID, sessionTag: 'smta56mxu', prompts: [] }];
    const dup = findDuplicateStateForSession(onDisk, ID, '0e340a60-bc0');
    expect(dup?.sessionTag).toBe('smta56mxu');
  });

  it('stays quiet in the normal case where only our own tag exists', () => {
    const onDisk = [{ sessionId: ID, sessionTag: '0e340a60-bc0', prompts: ['p'] }];
    expect(findDuplicateStateForSession(onDisk, ID, '0e340a60-bc0')).toBeNull();
  });
});
