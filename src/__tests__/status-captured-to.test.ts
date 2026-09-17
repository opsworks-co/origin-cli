// `origin status` says which org a session was captured to. Since captures
// route by repo assignment, a session started with a personal-workspace key
// can live in a team org — the status line is how the user finds out.
import { describe, it, expect } from 'vitest';
import type { SessionState } from '../session-state.js';

// The same rendering rule status.ts applies, kept here so the test states the
// contract in one place: private → "your private workspace", team → the org
// name plus why, key → just the org.
function capturedToLine(c: NonNullable<SessionState['capturedTo']>): string {
  return c.routed === 'private'
    ? 'your private workspace'
    : `${c.orgName || c.orgId}${c.routed === 'team' ? ' (assigned repo)' : ''}`;
}

describe('SessionState.capturedTo rendering', () => {
  it('names the team and the reason for an assigned-repo capture', () => {
    expect(capturedToLine({ orgId: 'o1', orgName: 'Acme', orgType: 'team', routed: 'team' })).toBe('Acme (assigned repo)');
  });
  it('says private for the personal workspace', () => {
    expect(capturedToLine({ orgId: 'o2', orgName: "Jane's workspace", orgType: 'personal', routed: 'private' })).toBe('your private workspace');
  });
  it('falls back to the org id when the server sent no name', () => {
    expect(capturedToLine({ orgId: 'o3', orgName: null, orgType: 'team', routed: 'key' })).toBe('o3');
  });
});
