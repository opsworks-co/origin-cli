/**
 * OR-9/A3: new Origin notes carry the canonical v1 attribution record next to
 * the legacy payload.
 *
 *   { "origin": { …legacy, unchanged… }, "attribution_record": { …v1… } }
 *
 * What is pinned here:
 *   - every agent `origin enable --agent` accepts gets a valid record through
 *     the real writer (`writeGitNotes`) on a real commit, with its captured
 *     agent id and never a model-derived one;
 *   - one record per annotated commit, naming that commit;
 *   - unknown telemetry is absent, never zero, and no prompt text crosses over;
 *   - no observed session / no tool identity → legacy note only;
 *   - legacy readers keep reading the note; scrub and rewrite copy behave.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const importGitNote = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../api.js', () => ({ api: { importGitNote } }));

const { writeGitNotes, scrubNoteObject } = await import('../git-notes.js');
const {
  buildAttributionRecordForCommit,
  attributionSourceFromState,
  iterationIndexByShaFromState,
  ATTRIBUTION_RECORD_NOTE_KEY,
} = await import('../attribution-note.js');
const { readRecord, validateFull, canonicalPromptHash } = await import('../attribution-record.js');
const { getSessionContextForCommit, isAiCommit } = await import('../attribution.js');
const { preserveAttributionOnRewrite } = await import('../history-preservation.js');
const { cliVersion } = await import('../cli-version.js');

/** Exactly the values `origin enable --agent` accepts (AgentType in enable.ts). */
const SUPPORTED_AGENTS = ['claude-code', 'cursor', 'gemini', 'devin', 'codex', 'aider', 'antigravity', 'copilot'] as const;

const SECRET_PROMPT = 'Refactor the billing module; token=sk-live-abcdef0123456789 please';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();

function commit(name: string): string {
  fs.writeFileSync(path.join(repo, name), `${name} ${Math.random()}\n`);
  git('add', '.');
  git('commit', '-q', '-m', `add ${name}`);
  return git('rev-parse', 'HEAD');
}

function readNote(sha: string): any {
  return JSON.parse(git('notes', '--ref=origin', 'show', sha));
}

function noteData(overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-0f3c2a',
    model: 'claude-opus-5-5',
    agentSlug: 'claude-code',
    promptCount: 3,
    promptSummary: SECRET_PROMPT,
    fullPrompt: SECRET_PROMPT,
    prompts: [{ index: 0, text: SECRET_PROMPT, files: ['a.txt'] }],
    markers: { intent: ['keep the invoice API stable'] },
    originUrl: 'https://origin.example.com/sessions/sess-0f3c2a',
    tokensUsed: 1234,
    linesAdded: 10,
    linesRemoved: 2,
    ...overrides,
  };
}

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-v1-writer-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  importGitNote.mockClear();
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('supported-agent write matrix (real writer, real commit)', () => {
  for (const agent of SUPPORTED_AGENTS) {
    it(`${agent}: legacy envelope + a valid v1 record for exactly the annotated commit`, () => {
      commit('base.txt');
      const sha = commit(`${agent}.txt`);
      // The model string deliberately names ANOTHER vendor: agent identity
      // must come from the captured slug, never from the model.
      writeGitNotes(repo, [sha], noteData({
        agentSlug: agent,
        model: 'gpt-5.5',
        attribution: { sessionId: `sess-${agent}`, agentId: agent, modelId: 'gpt-5.5' },
      }));

      const note = readNote(sha);
      // Legacy envelope untouched: readers find what they always found.
      expect(note.origin.version).toBe(1);
      expect(note.origin.sessionId).toBe('sess-0f3c2a');
      expect(note.origin.agent).toBe(agent);
      expect(getSessionContextForCommit(repo, sha)?.sessionId).toBe('sess-0f3c2a');
      expect(isAiCommit(repo, sha)).toBe(true);

      const record = note[ATTRIBUTION_RECORD_NOTE_KEY];
      expect(validateFull(record).ok).toBe(true);
      expect(readRecord(record).status).toBe('exact');
      expect(record.revision).toEqual({ vcs: 'git', id: sha });
      expect(record.contributions).toHaveLength(1);
      expect(record.contributions[0].agent).toEqual({ id: agent });
      expect(record.contributions[0].model).toEqual({ id: 'gpt-5.5' });
      expect(record.contributions[0].evidence).toBe('session_capture');
      expect(record.contributions[0].session.id).toBe(`sess-${agent}`);
      expect(record.producer).toEqual({ name: 'origin-cli', version: cliVersion() });

      // Unknown telemetry is absent, not zero.
      const session = record.contributions[0].session;
      expect(session).not.toHaveProperty('usage');
      expect(session).not.toHaveProperty('prompt_count');
      expect(session).not.toHaveProperty('iterations');
      expect(record.revision).not.toHaveProperty('diff_stats');
      expect(record.contributions[0]).not.toHaveProperty('actor');

      // No prompt text, summary, markers or their fragments in the record.
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('sk-live');
      expect(serialized).not.toContain('billing');
      expect(serialized).not.toContain('invoice');
    });
  }
});

describe('one record per annotated commit', () => {
  it('two commits in one call get two records, each naming its own revision', () => {
    const a = commit('a.txt');
    const b = commit('b.txt');
    writeGitNotes(repo, [a, b], noteData({ attribution: { sessionId: 'sess-1', agentId: 'codex' } }));
    expect(readNote(a).attribution_record.revision.id).toBe(a);
    expect(readNote(b).attribution_record.revision.id).toBe(b);
    // The mirrored payload is the exact note written for that sha.
    const mirrored = importGitNote.mock.calls.map((c: any[]) => [c[1], c[2].attribution_record.revision.id]);
    expect(mirrored).toEqual([[a, a], [b, b]]);
  });

  it('an abbreviated sha is resolved to the full revision id', () => {
    const a = commit('a.txt');
    writeGitNotes(repo, [a.slice(0, 10)], noteData({ attribution: { sessionId: 'sess-1', agentId: 'codex' } }));
    expect(readNote(a).attribution_record.revision.id).toBe(a);
  });

  it('rewriting the same commit (stop, then session end) keeps a valid record for the same revision', () => {
    const a = commit('a.txt');
    writeGitNotes(repo, [a], noteData({ attribution: { sessionId: 'sess-1', agentId: 'cursor' } }));
    const first = readNote(a).attribution_record;
    writeGitNotes(repo, [a], noteData({ attribution: { sessionId: 'sess-1', agentId: 'cursor', costUsd: 0.42 } }));
    const second = readNote(a).attribution_record;
    expect(second.revision.id).toBe(first.revision.id);
    expect(readRecord(second).status).toBe('exact');
    expect(second.contributions[0].session.usage.cost).toEqual({ amount: '0.42', currency: 'USD', basis: 'estimated' });
  });
});

describe('no honest record → legacy note only', () => {
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ['no record source at all', undefined],
    ['legacy "unknown" session', { sessionId: 'unknown', agentId: 'claude-code' }],
    ['pgrep receipt, not a session', { sessionId: 'detected-codex-lx9a', agentId: 'codex' }],
    ['Devin Desktop recency guess', { sessionId: 'devin-7f3e', agentId: 'devin' }],
    ['no captured tool', { sessionId: 'sess-1' }],
    ['org agent-slug override, not a tool', { sessionId: 'sess-1', agentId: 'cursor-frontend' }],
    ['literal unknown agent', { sessionId: 'sess-1', agentId: 'unknown' }],
  ];
  for (const [label, attribution] of cases) {
    it(label, () => {
      const a = commit('a.txt');
      writeGitNotes(repo, [a], noteData({ attribution }));
      const note = readNote(a);
      expect(note.origin.sessionId).toBe('sess-0f3c2a');
      expect(note).not.toHaveProperty(ATTRIBUTION_RECORD_NOTE_KEY);
    });
  }

  it('an invalid optional value is dropped, not written and not fatal', () => {
    const a = commit('a.txt');
    writeGitNotes(repo, [a], noteData({
      attribution: {
        sessionId: 'sess-1', agentId: 'gemini',
        modelId: 'unknown',
        sessionReferenceUri: 'https://origin.example.com/sessions/sess-1?token=secret',
        sessionStartedAt: 'not a date',
        costUsd: 0,
      },
    }));
    const record = readNote(a).attribution_record;
    expect(readRecord(record).status).toBe('exact');
    expect(record.contributions[0]).not.toHaveProperty('model');
    expect(record.contributions[0].session).toEqual({ id: 'sess-1' });
  });
});

describe('buildAttributionRecordForCommit field sources', () => {
  const SHA = 'a'.repeat(40);
  const at = new Date('2026-09-25T12:00:00.000Z');
  const opts = { recordedAt: at, producerVersion: '0.20260925.1' };

  it('bare agent-brand model strings are not model ids', () => {
    for (const bare of ['claude', 'codex', 'cursor', 'default', '']) {
      const { record } = buildAttributionRecordForCommit(SHA, { sessionId: 's1', agentId: 'cursor', modelId: bare }, opts);
      expect(record!.contributions[0]).not.toHaveProperty('model');
    }
  });

  it('started_at and duration_ms come from the captured start, measured to recorded_at', () => {
    const { record } = buildAttributionRecordForCommit(SHA, {
      sessionId: 's1', agentId: 'claude-code', sessionStartedAt: '2026-09-25T11:59:00.000Z',
    }, opts);
    expect(record!.recorded_at).toBe('2026-09-25T12:00:00.000Z');
    expect(record!.contributions[0].session.started_at).toBe('2026-09-25T11:59:00.000Z');
    expect(record!.contributions[0].session.duration_ms).toBe(60_000);
  });

  it('cost is a decimal string; a value that rounds to zero is absent', () => {
    const amount = (costUsd: number) => buildAttributionRecordForCommit(SHA, { sessionId: 's1', agentId: 'codex', costUsd }, opts)
      .record!.contributions[0].session.usage?.cost.amount;
    expect(amount(1.23456789)).toBe('1.234568');
    expect(amount(12)).toBe('12');
    expect(amount(0.0000001)).toBeUndefined();
    expect(amount(Number.NaN)).toBeUndefined();
  });

  it('an iteration link is the canonical ?prompt=N of the session reference', () => {
    const { record } = buildAttributionRecordForCommit(SHA, {
      sessionId: 's1', agentId: 'claude-code',
      sessionReferenceUri: 'https://origin.example.com/sessions/s1',
      iterationIndexBySha: { [SHA]: 23 },
    }, opts);
    expect(record!.contributions[0].session.iterations).toEqual([
      { index: 23, reference_uri: 'https://origin.example.com/sessions/s1?prompt=23' },
    ]);
    expect(readRecord(record).status).toBe('exact');
  });

  it('a proven iteration carries the prompt hash next to its ?prompt=N link (OR-48)', () => {
    const hash = canonicalPromptHash('Add a retry to the upload client.');
    const { record } = buildAttributionRecordForCommit(SHA, {
      sessionId: 's1', agentId: 'claude-code',
      sessionReferenceUri: 'https://origin.example.com/sessions/s1',
      iterationIndexBySha: { [SHA]: 23 },
      // A hash for another iteration is not this commit's claim.
      promptHashByIndex: { 23: hash, 22: canonicalPromptHash('an earlier turn') },
    }, opts);
    expect(record!.revision.id).toBe(SHA);
    expect(record!.contributions[0].session.iterations).toEqual([
      { index: 23, prompt_hash: hash, reference_uri: 'https://origin.example.com/sessions/s1?prompt=23' },
    ]);
    expect(validateFull(record).ok).toBe(true);
  });

  it('a hash without a session reference stays a hash: no link is invented', () => {
    const hash = canonicalPromptHash('Add a retry to the upload client.');
    const { record } = buildAttributionRecordForCommit(SHA, {
      sessionId: 'local-s1', agentId: 'codex',
      iterationIndexBySha: { [SHA]: 0 }, promptHashByIndex: { 0: hash },
    }, opts);
    expect(record!.contributions[0].session).toEqual({ id: 'local-s1', iterations: [{ index: 0, prompt_hash: hash }] });
    expect(validateFull(record).ok).toBe(true);
  });

  it('no iteration, or a value that is not a canonical hash, gives no prompt_hash', () => {
    const hash = canonicalPromptHash('x');
    const noIteration = buildAttributionRecordForCommit(SHA, { sessionId: 's1', agentId: 'codex', promptHashByIndex: { 0: hash } }, opts);
    expect(noIteration.record!.contributions[0].session).not.toHaveProperty('iterations');
    const bad = buildAttributionRecordForCommit(SHA, {
      sessionId: 's1', agentId: 'codex', iterationIndexBySha: { [SHA]: 0 }, promptHashByIndex: { 0: 'sha256:ABC' },
    }, opts);
    expect(bad.record!.contributions[0].session.iterations).toEqual([{ index: 0 }]);
  });

  it('never writes a record for a non-sha revision', () => {
    expect(buildAttributionRecordForCommit('HEAD', { sessionId: 's1', agentId: 'codex' }, opts).record).toBeUndefined();
  });
});

describe('record source from session state', () => {
  const base: any = {
    sessionId: 'sess-42',
    agentSlug: 'claude-code',
    model: 'claude-opus-5-5',
    startedAt: '2026-09-25T10:00:00.000Z',
    promptTurnIds: ['t0', 't1', 't2'],
    commitTurns: [
      { sha: 'A'.repeat(40), turnId: 't1', at: '2026-09-25T10:05:00Z', via: 'post-commit' },
      { sha: 'b'.repeat(40), turnId: 't2', at: '2026-09-25T10:06:00Z', via: 'transcript' },
      { sha: 'c'.repeat(40), turnId: 't1', at: '2026-09-25T10:07:00Z', via: 'post-commit' },
      { sha: 'c'.repeat(40), turnId: 't2', at: '2026-09-25T10:08:00Z', via: 'post-commit' },
      { sha: 'd'.repeat(40), turnId: 'gone', at: '2026-09-25T10:09:00Z', via: 'post-commit' },
    ],
  };

  it('only a post-commit attestation of exactly one known turn names an iteration', () => {
    expect(iterationIndexByShaFromState(base)).toEqual({ ['a'.repeat(40)]: 1 });
  });

  it('a resumed session numbers the turn cumulatively and drops the relaunch start', () => {
    const resumed = { ...base, promptIndexBase: 21 };
    expect(iterationIndexByShaFromState(resumed)).toEqual({ ['a'.repeat(40)]: 22 });
    expect(attributionSourceFromState(resumed, { connected: false }).sessionStartedAt).toBeUndefined();
  });

  it('a session reference only for a session the server knows', () => {
    const connected = attributionSourceFromState(base, { connected: true, apiUrl: 'https://origin.example.com/' });
    expect(connected.sessionReferenceUri).toBe('https://origin.example.com/sessions/sess-42');
    expect(attributionSourceFromState(base, { connected: false, apiUrl: 'https://origin.example.com' }).sessionReferenceUri).toBeUndefined();
    expect(attributionSourceFromState({ ...base, sessionId: 'local-1234' }, { connected: true, apiUrl: 'https://x.example' }).sessionReferenceUri).toBeUndefined();
    expect(attributionSourceFromState({ ...base, pendingRegistration: true }, { connected: true, apiUrl: 'https://x.example' }).sessionReferenceUri).toBeUndefined();
  });

  it('hashes the attested turn\'s whole prompt only, and only when it is provably the served text', () => {
    const prompts = ['first turn', 'Add a retry to the upload client.', 'third turn'];
    const src = attributionSourceFromState({ ...base, prompts }, { connected: false });
    expect(src.promptHashByIndex).toEqual({ 1: canonicalPromptHash(prompts[1]) });
    // A prompt the server would clip, redact, strip or re-link gets none.
    for (const text of ['x'.repeat(1001), 'deploy with ghp_' + 'a'.repeat(36), ' padded', '<system_reminder>x</system_reminder> go', 'see [image] here']) {
      const s = attributionSourceFromState({ ...base, prompts: ['a', text, 'c'] }, { connected: false });
      expect(s.promptHashByIndex).toEqual({});
    }
  });

  it('a resumed session hashes the local turn behind the cumulative index', () => {
    const resumed = { ...base, promptIndexBase: 21, prompts: ['first turn', 'Add a retry to the upload client.'] };
    expect(attributionSourceFromState(resumed, { connected: false }).promptHashByIndex)
      .toEqual({ 22: canonicalPromptHash('Add a retry to the upload client.') });
    // A turn this launch did not capture has no text to hash.
    expect(attributionSourceFromState({ ...base, prompts: ['only one'] }, { connected: false }).promptHashByIndex).toEqual({});
  });

  it('the calling hook\'s resolved agent wins over the stored slug', () => {
    expect(attributionSourceFromState({ ...base, agentSlug: 'cursor-frontend' }, { agentSlug: 'cursor', connected: false }).agentId).toBe('cursor');
  });
});

describe('the record survives the tools that rewrite notes', () => {
  it('scrub-notes removes prompt text and keeps the record intact', () => {
    const a = commit('a.txt');
    // A prompt-bearing note: written with the opt-in, as older notes were by default.
    fs.writeFileSync(path.join(repo, '.origin.json'), JSON.stringify({ notesIncludePrompts: true }));
    writeGitNotes(repo, [a], noteData({ attribution: { sessionId: 'sess-1', agentId: 'copilot' } }));
    const before = readNote(a);
    const { changed, scrubbed } = scrubNoteObject(before);
    expect(changed).toBe(true);
    expect(JSON.stringify(scrubbed.origin)).not.toContain('sk-live');
    expect(scrubbed.attribution_record).toEqual(before.attribution_record);
  });

  it('a rewrite carries the legacy note and a commit-level record for the NEW commit, never the old one\'s (OR-11)', () => {
    const a = commit('a.txt');
    writeGitNotes(repo, [a], noteData({ attribution: { sessionId: 'sess-1', agentId: 'aider' } }));
    git('commit', '-q', '--amend', '-m', 'amended');
    const amended = git('rev-parse', 'HEAD');
    preserveAttributionOnRewrite(repo, a, amended);
    const copied = readNote(amended);
    expect(copied.origin).toEqual(readNote(a).origin);
    expect(copied.attribution_record.revision.id).toBe(amended);
    expect(copied.attribution_record.attribution_level).toBe('commit');
    expect(copied.attribution_record.contributions.map((c: any) => [c.session.id, c.agent.id])).toEqual([['sess-1', 'aider']]);
    expect(copied.attribution_record.contributions[0].session).not.toHaveProperty('iterations');
    expect(readRecord(copied.attribution_record).status).toBe('exact');
    // The original commit's note is untouched.
    expect(readNote(a).attribution_record.revision.id).toBe(a);
  });
});

// Review: the auto-push after a note write runs inside the agent's Stop hook,
// so it makes ONE attempt; a rejected push is merged and retried by pre-push.
describe('auto-push after a note write', () => {
  it('a rejected push is not fetched, merged or retried from the writer', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-autopush-')));
    try {
      const bare = path.join(base, 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
      const a = commit('a.txt');
      git('remote', 'add', 'origin', bare);
      git('push', '-q', 'origin', 'main');
      // Someone else's notes on the remote, unrelated to ours: our push is non-fast-forward.
      const other = path.join(base, 'other');
      execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
      execFileSync('git', ['notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"theirs"}}', a], { cwd: other, stdio: 'pipe' });
      execFileSync('git', ['push', '-q', 'origin', 'refs/notes/origin'], { cwd: other, stdio: 'pipe' });

      writeGitNotes(repo, [a], noteData({ attribution: { sessionId: 'sess-1', agentId: 'codex' } }));

      // Local note written; nothing fetched into staging and nothing merged.
      expect(readNote(a).origin.sessionId).toBe('sess-0f3c2a');
      expect(() => git('rev-parse', '--verify', 'refs/notes/origin-remote')).toThrow();
      expect(git('log', '--format=%s', 'refs/notes/origin')).not.toMatch(/Merge/i);
      expect(execFileSync('git', ['notes', '--ref=origin', 'show', a], { cwd: bare, encoding: 'utf-8' })).toContain('theirs');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// PR review blocker 2: the auto-push after a note write goes to `origin` only.
// The old resolver fell back to the first remote, so a repo whose only remote
// is a public `upstream` got the prompt-bearing ref straight from post-commit,
// Stop or SessionEnd.
describe('auto-push destination', () => {
  it('a repo with only `upstream`: the note is written locally and nothing is published', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-autopush-upstream-')));
    try {
      const upstream = path.join(base, 'upstream.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', upstream], { stdio: 'pipe' });
      const a = commit('a.txt');
      git('remote', 'add', 'upstream', upstream);
      git('push', '-q', 'upstream', 'main');

      // The prompt opt-in, so the ref that must stay off `upstream` carries prompt text.
      fs.writeFileSync(path.join(repo, '.origin.json'), JSON.stringify({ notesIncludePrompts: true }));
      writeGitNotes(repo, [a], noteData({ attribution: { sessionId: 'sess-1', agentId: 'cursor' } }));

      expect(readNote(a).origin.fullPrompt).toContain('billing');     // the local note carries prompt text
      expect(() => execFileSync('git', ['rev-parse', '--verify', 'refs/notes/origin'], { cwd: upstream, stdio: 'pipe' })).toThrow();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
