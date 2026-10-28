// OR-17 rollout contract, the wire half: every MCP request declares what this
// binary can do (X-Origin-Capabilities), and a queue replay additionally says
// what its PAYLOAD was built with (X-Origin-Payload-Capabilities) so a payload
// an older CLI queued is not vouched for by the binary that replays it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../fetch-timeout.js', async (orig) => ({ ...(await orig() as object), fetchWithTimeout }));
vi.mock('../config.js', () => ({ loadConfig: () => ({ apiUrl: 'http://origin.test', apiKey: 'org_test_key' }) }));

import { api } from '../api.js';

const ok = () => ({ ok: true, status: 200, json: async () => ({ ok: true, ingested: 0 }) });
const sentHeaders = () => fetchWithTimeout.mock.calls[0][1].headers as Record<string, string>;

beforeEach(() => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockResolvedValue(ok());
});

describe('capability headers on MCP writes', () => {
  it('a fresh send declares the capability and no payload provenance', async () => {
    await api.updateSession('s1', { tag: 'fresh' });
    expect(sentHeaders()['X-Origin-Capabilities']).toBe('rhodecode-remote-identity-1');
    expect(sentHeaders()['X-Origin-Payload-Capabilities']).toBeUndefined();
  });

  it.each([
    ['updateSession', () => api.updateSession('s1', {}, { payloadCapabilities: [] })],
    ['endSession', () => api.endSession({ sessionId: 's1' }, { payloadCapabilities: [] })],
    ['ingestCommits', () => api.ingestCommits({ repoPath: '/r', commits: [] }, { payloadCapabilities: [] })],
  ])('%s replaying a legacy payload says it was built with none', async (_name, send) => {
    await send();
    expect(sentHeaders()['X-Origin-Capabilities']).toBe('rhodecode-remote-identity-1');
    expect(sentHeaders()['X-Origin-Payload-Capabilities']).toBe('none');
  });

  it('a replay of a payload this CLI built carries its capabilities', async () => {
    await api.updateSession('s1', {}, { payloadCapabilities: ['rhodecode-remote-identity-1'] });
    expect(sentHeaders()['X-Origin-Payload-Capabilities']).toBe('rhodecode-remote-identity-1');
  });
});
