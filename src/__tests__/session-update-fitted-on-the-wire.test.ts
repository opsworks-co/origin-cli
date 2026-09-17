/**
 * Every producer's session PATCH goes through api.updateSession, which is why
 * the editsJson size fit lives there and not in each producer (Stop,
 * session-end, post-commit, user-prompt-submit, the watchers). This pins that
 * the body on the wire is the fitted one.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-fitted-wire-${process.pid}` };
});
vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('../config.js', () => ({ loadConfig: () => ({ apiUrl: 'http://api.test', apiKey: 'org_test_key_123456' }) }));
const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../fetch-timeout.js', async (orig) => ({ ...(await orig() as object), fetchWithTimeout }));

import { api } from '../api.js';
import { SERVER_EDITS_JSON_MAX_CHARS } from '../session-update-size.js';

afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('api.updateSession', () => {
  it('sends each turn\'s editsJson within the server\'s limit', async () => {
    fetchWithTimeout.mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const whole = 'w'.repeat(SERVER_EDITS_JSON_MAX_CHARS);
    const editsJson = JSON.stringify({
      edits: [
        { file: 'a.ts', op: 'edit', oldContent: 'x', newContent: 'y', source: 'tool_call' },
        { file: 'big.ts', op: 'edit', oldContent: whole, newContent: `${whole}!`, source: 'commit', commitSha: 'b'.repeat(40) },
      ],
    });
    await api.updateSession('sess', { promptChanges: [{ promptIndex: 0, editsJson }] });
    const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
    const sent = body.promptChanges[0].editsJson as string;
    expect(sent.length).toBeLessThanOrEqual(SERVER_EDITS_JSON_MAX_CHARS);
    expect(JSON.parse(sent).edits.map((e: any) => [e.file, e.source, e.commitSha ?? null])).toEqual([
      ['a.ts', 'tool_call', null], ['big.ts', 'commit', 'b'.repeat(40)],
    ]);
  });
});
