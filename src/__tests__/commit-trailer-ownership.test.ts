// Regression: concurrent agents in ONE repo cross-attributed commits. A Codex
// session (129a8660) swept in a commit authored by a Devin session (7bfbac34)
// because the session diff fell back to `git diff session-start..HEAD`, which
// grabs ANY commit in range. commitTrailerBelongsToSession gates that fallback
// on the commit's `Origin-Session` trailer.

import { describe, it, expect } from 'vitest';
import { commitTrailerBelongsToSession } from '../commands/hooks.js';

const devinCommit = `Add sample row

Origin-Session: 7bfbac34-0cd | Devin | 8 prompts
Origin-Snapshot: 58f5c7715137
`;

const codexCommit = `Add row count utility

Origin-Session: 129a8660-a11 | Codex | 2 prompts
`;

const plainCommit = `Fix typo

Some body, no trailer.
`;

describe('commitTrailerBelongsToSession', () => {
  const codexSession = { sessionId: '129a8660-a11c-4e5b-b43c-653d8a6270d8' };

  it("returns 'other' for a commit stamped to a DIFFERENT session (Devin vs Codex)", () => {
    expect(commitTrailerBelongsToSession(devinCommit, codexSession)).toBe('other');
  });

  it("returns 'self' when the (truncated) trailer id prefixes this session", () => {
    expect(commitTrailerBelongsToSession(codexCommit, codexSession)).toBe('self');
  });

  it("returns 'none' when there is no Origin-Session trailer (could be ours)", () => {
    expect(commitTrailerBelongsToSession(plainCommit, codexSession)).toBe('none');
  });

  it('matches a session that chained from a previous one', () => {
    const chained = { sessionId: 'aaaaaaaa-1111', previousSessionId: '7bfbac34-0cd9-...' };
    expect(commitTrailerBelongsToSession(devinCommit, chained)).toBe('self');
  });

  it('is not fooled by a trailer id that merely shares a leading char', () => {
    expect(commitTrailerBelongsToSession(devinCommit, { sessionId: '7000ffff-0000' })).toBe('other');
  });
});
