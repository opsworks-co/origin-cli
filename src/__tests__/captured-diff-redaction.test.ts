/**
 * A turn's diff, uncommittedDiff and editsJson leave the machine twice — in
 * the session PATCH to the API and in changes.json on the pushed
 * `origin-sessions` branch. Prompt text was redacted on the way out; this
 * content was not, so an uncommitted `.env` edit shipped verbatim.
 *
 * Line counts and blame are read off these texts, so redaction must leave
 * their line structure exactly as it was.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const { TEST_HOME, config } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp';
  return {
    TEST_HOME: `${base.replace(/\/$/, '')}/origin-diff-redaction-${process.pid}`,
    config: { current: { apiUrl: 'http://api.test', apiKey: 'org_test_key_123456', sessionBackend: 'refs' } as Record<string, unknown> },
  };
});
vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('../config.js', async (orig) => ({
  ...(await orig() as object),
  loadConfig: () => config.current,
  loadRepoConfig: () => null,
}));
const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../fetch-timeout.js', async (orig) => ({ ...(await orig() as object), fetchWithTimeout }));

import { api } from '../api.js';
import { redactSecretsByLine, redactEditsJson, redactSessionPayloadContent } from '../captured-diff-redaction.js';
import { writeSessionFiles } from '../local-entrypoint.js';

afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

// Split so the repo's own secret scanner does not flag this file.
const AWS = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
const GH = 'ghp_' + 'A'.repeat(40);
const BEARER = 'Bearer ' + 'abcdefghij'.repeat(3);

const envDiff = [
  'diff --git a/.env b/.env',
  '--- a/.env',
  '+++ b/.env',
  '@@ -1,2 +1,3 @@',
  ' APP=1',
  `-AWS_ACCESS_KEY_ID=${AWS}`,
  `+GITHUB_TOKEN=${GH}`,
  '+AUTH=Bearer',
  `+${BEARER.slice('Bearer '.length)}`,
  '',
].join('\n');

const lineShape = (s: string) => s.split('\n').map((l) => l.charAt(0));

describe('redactSecretsByLine', () => {
  it('removes the secrets and keeps every line, and each line\'s diff marker', () => {
    const out = redactSecretsByLine(envDiff);
    expect(out).not.toContain(AWS);
    expect(out).not.toContain(GH);
    expect(out.split('\n')).toHaveLength(envDiff.split('\n').length);
    expect(lineShape(out)).toEqual(lineShape(envDiff));
  });

  it('never joins lines, even where the whole-text redactor would (Bearer then newline)', () => {
    const text = `x\nAuthorization: Bearer\n${'Zq9'.repeat(10)}\ny`;
    expect(redactSecretsByLine(text).split('\n')).toHaveLength(4);
  });

  it('returns a secret-free text unchanged', () => {
    const clean = 'diff --git a/a.ts b/a.ts\n+const x = 1;\n';
    expect(redactSecretsByLine(clean)).toBe(clean);
  });
});

describe('redactEditsJson', () => {
  it('redacts string values and stays valid JSON with the same line structure', () => {
    const newContent = `APP=1\nGITHUB_TOKEN=${GH}\n`;
    const raw = JSON.stringify({ edits: [{ file: '.env', op: 'write', oldContent: 'APP=1\n', newContent }] });
    const out = redactEditsJson(raw);
    expect(out).not.toContain(GH);
    const parsed = JSON.parse(out);
    expect(parsed.edits[0].file).toBe('.env');
    expect(parsed.edits[0].oldContent).toBe('APP=1\n');
    expect(parsed.edits[0].newContent.split('\n')).toHaveLength(newContent.split('\n').length);
  });

  it('returns the same string when there is nothing to redact', () => {
    const raw = JSON.stringify({ edits: [{ file: 'a.ts', newContent: 'x\n' }] });
    expect(redactEditsJson(raw)).toBe(raw);
  });
});

describe('redactSessionPayloadContent', () => {
  it('leaves the payload alone when secretRedaction is off', () => {
    config.current = { ...config.current, secretRedaction: false };
    try {
      const data = { promptChanges: [{ promptIndex: 0, diff: envDiff }] };
      expect(redactSessionPayloadContent(data)).toBe(data);
    } finally {
      const { secretRedaction: _off, ...rest } = config.current;
      config.current = rest;
    }
  });
});

describe('on the wire', () => {
  it('api.updateSession sends diff, uncommittedDiff and editsJson redacted', async () => {
    fetchWithTimeout.mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const editsJson = JSON.stringify({ edits: [{ file: '.env', newContent: `K=${GH}\n` }] });
    await api.updateSession('sess', {
      promptChanges: [{ promptIndex: 0, diff: envDiff, uncommittedDiff: envDiff, editsJson, linesAdded: 3, linesRemoved: 1 }],
    });
    const sentRaw = fetchWithTimeout.mock.calls.at(-1)![1].body as string;
    expect(sentRaw).not.toContain(AWS);
    expect(sentRaw).not.toContain(GH);
    const pc = JSON.parse(sentRaw).promptChanges[0];
    expect(lineShape(pc.diff)).toEqual(lineShape(envDiff));
    expect(lineShape(pc.uncommittedDiff)).toEqual(lineShape(envDiff));
    expect(JSON.parse(pc.editsJson).edits[0].file).toBe('.env');
    expect([pc.linesAdded, pc.linesRemoved]).toEqual([3, 1]);
  });

  it('api.endSession sends the turn content redacted', async () => {
    fetchWithTimeout.mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await api.endSession({ sessionId: 'sess', promptChanges: [{ promptIndex: 0, diff: envDiff }] });
    const sentRaw = fetchWithTimeout.mock.calls.at(-1)![1].body as string;
    expect(sentRaw).not.toContain(GH);
    expect(sentRaw).not.toContain(AWS);
  });
});

describe('changes.json on the session branch', () => {
  it('is written with the turn content redacted', () => {
    const repo = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'origin-redact-repo-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
      git('init', '-q', '-b', 'main', '.');
      git('config', 'user.email', 't@t.co');
      git('config', 'user.name', 't');
      git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
      git('add', 'a.txt');
      git('commit', '-qm', 'init');
      const now = new Date().toISOString();
      writeSessionFiles(repo, {
        sessionId: 'sess-redact', model: 'm', startedAt: now, endedAt: now, durationMs: 1, status: 'ended',
        costUsd: 0, tokensUsed: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, linesAdded: 3, linesRemoved: 1,
        prompts: [{ index: 1, text: 'edit env', filesChanged: ['.env'] }], filesChanged: ['.env'],
        git: { branch: 'main', headBefore: '', headAfter: '', commitShas: [] }, summary: '', originUrl: '',
        changes: [{
          promptIndex: 1, promptText: 'edit env', filesChanged: ['.env'], diff: envDiff, uncommittedDiff: envDiff,
          editsJson: JSON.stringify({ edits: [{ file: '.env', newContent: `K=${GH}\n` }] }),
        }],
      } as any);
      const ref = git('for-each-ref', '--format=%(refname)', 'refs/origin/sessions/');
      expect(ref).not.toBe('');
      const files = git('ls-tree', '-r', '--name-only', ref.split('\n')[0]).split('\n');
      const changesPath = files.find((f) => f.endsWith('changes.json'))!;
      const changes = git('show', `${ref.split('\n')[0]}:${changesPath}`);
      expect(changes).not.toContain(GH);
      expect(changes).not.toContain(AWS);
      const pc = JSON.parse(changes).changes[0];
      expect(lineShape(pc.diff)).toEqual(lineShape(envDiff));
      expect(JSON.parse(pc.editsJson).edits[0].file).toBe('.env');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
