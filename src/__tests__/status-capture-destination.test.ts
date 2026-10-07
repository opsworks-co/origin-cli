// `origin status` says where a session in this repo goes, not just which org
// the key was minted in. Captures route by repo: a solo key belonging to a
// team ADMIN puts that team's repos in the team, so "Personal workspace"
// alone read as "this key can't contribute to the team".
import { describe, it, expect } from 'vitest';
import { describeCaptureDestination } from '../commands/status.js';

describe('describeCaptureDestination', () => {
  it('names the team for a repo routed to a team', () => {
    expect(describeCaptureDestination({ routed: 'team', orgName: 'Origin HQ', orgId: 'org-1' })).toBe('Origin HQ (assigned repo)');
  });

  it('says private workspace for a repo no team assigned', () => {
    expect(describeCaptureDestination({ routed: 'private', orgName: "Ihor's workspace", orgId: 'org-2' })).toBe('your private workspace');
    // An account with no personal workspace yet: the server answers with no org.
    expect(describeCaptureDestination({ routed: 'private', orgName: null, orgId: null })).toBe('your private workspace');
  });

  it("names the key's org for a key that never routes (service or pinned key)", () => {
    expect(describeCaptureDestination({ routed: 'key', orgName: 'CI', orgId: 'org-3' })).toBe('CI');
  });

  it('says nothing when the server could not answer', () => {
    expect(describeCaptureDestination(null)).toBeNull();
    expect(describeCaptureDestination({})).toBeNull();
    expect(describeCaptureDestination({ routed: 'team', orgName: null, orgId: null })).toBeNull();
  });
});
