/**
 * Pins the git-notes content contract (OR-48/A8). refs/notes/origin is read by
 * anyone with read access to the repository, with no Origin permission check,
 * so a note is metadata only unless the repo or machine explicitly opts in
 * with a literal `notesIncludePrompts: true`. The metadata-only payload keeps
 * attribution (model, agent, files, counts, code edits, originUrl) and a
 * prompt hash where one is provable, and carries zero prompt-text bytes.
 * scrubNoteObject covers the retroactive cleanup of older notes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const importGitNote = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../api.js', () => ({ api: { importGitNote } }));

const { buildNotePayload, scrubNoteObject, shouldIncludePromptText, writeGitNotes } = await import('../git-notes.js');
const { scrubNoteBody, verifyScrubbedNote, EDITS_TRUNCATED_MARKER } = await import('../note-scrub.js');
const { sessionBranchPushTarget } = await import('../prompt-privacy.js');
const { clearConfigCache } = await import('../config.js');
const { canonicalPromptHash } = await import('../attribution-record.js');
const { attributionSourceFromState } = await import('../attribution-note.js');
const { buildPromptNoteEntries } = await import('../commands/hooks/session-end.js');
type GitNoteData = import('../git-notes.js').GitNoteData;

// One unique marker in every prompt-text carrier: a default note must not
// contain it anywhere, nested or serialized.
const LEAK = 'OR48_DO_NOT_LEAK_prompt_7f3a';
const SECRET_PROMPT = `${LEAK} rewrite the billing engine before the acquisition call`;
const SECRET_SUMMARY = `${LEAK} billing engine rewrite for acquisition`;
const SECRET_DECISION = `${LEAK} kept the acquisition pricing table hardcoded for now`;

function noteData(): GitNoteData {
  return {
    sessionId: 'sess-1',
    model: 'claude-fable-5',
    agentSlug: 'claude',
    promptCount: 2,
    promptSummary: SECRET_SUMMARY,
    fullPrompt: SECRET_PROMPT,
    prompts: [
      {
        index: 0,
        text: SECRET_PROMPT,
        promptHash: canonicalPromptHash(SECRET_PROMPT),
        model: 'claude-fable-5',
        files: ['src/billing.ts'],
        editsJson: JSON.stringify({
          promptIndex: 0,
          promptText: SECRET_PROMPT,
          agent: 'claude',
          commits: [],
          edits: [{ file: 'src/billing.ts', oldContent: 'a', newContent: 'b' }],
        }),
        treeSha: 'tree123',
        commitSha: 'head456',
      },
    ],
    markers: {
      intent: [`${LEAK} ship billing rewrite`],
      decision: [SECRET_DECISION],
    },
    originUrl: 'https://getorigin.io/sessions/sess-1',
    tokensUsed: 1000,
    costUsd: 1.23,
    durationMs: 60000,
    linesAdded: 10,
    linesRemoved: 2,
  };
}

// ── config precedence ──────────────────────────────────────────────────────
// The vitest setup gives every worker its own HOME, so the machine config
// written here is never the developer's real ~/.origin/config.json.
const machineConfig = path.join(os.homedir(), '.origin', 'config.json');
let repo: string;

function setMachine(value: unknown | undefined) {
  if (value === undefined) fs.rmSync(machineConfig, { force: true });
  else {
    fs.mkdirSync(path.dirname(machineConfig), { recursive: true });
    fs.writeFileSync(machineConfig, typeof value === 'string' ? value : JSON.stringify(value));
  }
  clearConfigCache();
}
function setRepo(value: unknown | undefined) {
  const p = path.join(repo, '.origin.json');
  fs.rmSync(p, { recursive: true, force: true });
  if (value !== undefined) fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-notes-privacy-')));
  setMachine(undefined);
  importGitNote.mockClear();
});
afterEach(() => {
  setMachine(undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('shouldIncludePromptText: metadata only unless a literal true opts in', () => {
  it('no repo or machine config → metadata only', () => {
    expect(shouldIncludePromptText(repo)).toBe(false);
  });

  it('the repo value wins over the machine value, both ways', () => {
    setRepo({ notesIncludePrompts: true }); setMachine({ notesIncludePrompts: false });
    expect(shouldIncludePromptText(repo)).toBe(true);
    setRepo({ notesIncludePrompts: false }); setMachine({ notesIncludePrompts: true });
    expect(shouldIncludePromptText(repo)).toBe(false);
  });

  it('a machine opt-in applies when the repo says nothing', () => {
    setMachine({ notesIncludePrompts: true });
    expect(shouldIncludePromptText(repo)).toBe(true);
  });

  it('a broken repo config is metadata only even when the machine opts in', () => {
    // Each case with machine `true`: a broken .origin.json must not fall
    // through to it.
    setMachine({ notesIncludePrompts: true });
    const broken: Array<[string, () => void]> = [
      ...(['true', 1, 'yes', null, { on: true }, []] as unknown[]).map((v): [string, () => void] =>
        [`notesIncludePrompts: ${JSON.stringify(v)}`, () => setRepo({ notesIncludePrompts: v })]),
      ['corrupt JSON', () => setRepo('{ not json')],
      ['a JSON array', () => setRepo('[]')],
      ['a JSON string', () => setRepo('"notesIncludePrompts"')],
      ['JSON null', () => setRepo('null')],
      ['unreadable (a directory)', () => { setRepo(undefined); fs.mkdirSync(path.join(repo, '.origin.json')); }],
    ];
    for (const [name, apply] of broken) {
      apply();
      expect(shouldIncludePromptText(repo), name).toBe(false);
    }
  });

  // Found checking sealed prompts on prod (2026-10-03): a repo that set
  // notesEncryptPrompts got CLEAR TEXT notes from a machine with the global
  // opt-in. One person's machine setting must not undo a repo's encryption.
  it('a repo that asks for sealing ignores the machine opt-in; only its own key chooses clear text', () => {
    setMachine({ notesIncludePrompts: true });
    setRepo({ notesEncryptPrompts: true });
    expect(shouldIncludePromptText(repo)).toBe(false);
    setRepo({ notesEncryptPrompts: true, notesIncludePrompts: true });
    expect(shouldIncludePromptText(repo)).toBe(true);
    setRepo({ notesEncryptPrompts: 'true' });
    expect(shouldIncludePromptText(repo), 'only a literal true seals').toBe(true);
  });

  it('a valid repo config without the key inherits the machine opt-in', () => {
    setMachine({ notesIncludePrompts: true });
    setRepo({ agent: 'claude-code' });
    expect(shouldIncludePromptText(repo)).toBe(true);
    setRepo({});
    expect(shouldIncludePromptText(repo)).toBe(true);
  });

  it('a broken or non-boolean machine config never opts in', () => {
    for (const v of ['true', 1, null]) {
      setMachine({ notesIncludePrompts: v });
      expect(shouldIncludePromptText(repo)).toBe(false);
    }
    setMachine('{ not json');
    expect(shouldIncludePromptText(repo)).toBe(false);
  });

  it('one origin-sessions decision: strategy, trigger and destination', () => {
    const snap = 'git@example.com:snap.git';
    const at = (cfg: any, trigger: 'publish-moment' | 'pre-push' = 'publish-moment') => sessionBranchPushTarget(repo, cfg, trigger);
    // Default: nowhere.
    expect(at({ pushStrategy: 'auto' })).toBeNull();
    expect(at(null, 'pre-push')).toBeNull();
    // 'always' publishes to origin; a snapshotRepo goes only there, opt-in or not.
    expect(at({ pushStrategy: 'always' })).toEqual({ kind: 'origin' });
    expect(at({ snapshotRepo: snap })).toEqual({ kind: 'snapshot', remote: snap });
    expect(at({ snapshotRepo: '--upload-pack=x' })).toBeNull();
    setRepo({ notesIncludePrompts: true });
    expect(at({ pushStrategy: 'auto' })).toEqual({ kind: 'origin' });
    expect(at({ snapshotRepo: snap }, 'pre-push')).toEqual({ kind: 'snapshot', remote: snap });
    // 'false' wins over everything; 'prompt' waits for the user's own push.
    expect(at({ pushStrategy: 'false', snapshotRepo: snap }, 'pre-push')).toBeNull();
    expect(at({ pushStrategy: 'false' }, 'pre-push')).toBeNull();
    expect(at({ pushStrategy: 'prompt' })).toBeNull();
    expect(at({ pushStrategy: 'prompt' }, 'pre-push')).toEqual({ kind: 'origin' });
  });
});

// ── payload ────────────────────────────────────────────────────────────────

describe('buildNotePayload, metadata only (the default)', () => {
  it('carries zero prompt-text bytes in any carrier', () => {
    const payload = buildNotePayload(noteData(), false);
    expect(payload).not.toContain(LEAK);
    expect(payload).not.toContain('billing engine');
    expect(payload).not.toContain('acquisition');
    const o = JSON.parse(payload).origin;
    expect(o.promptSummary).toBeUndefined();
    expect(o.fullPrompt).toBeUndefined();
    expect(o.markers).toBeUndefined();
    expect(o.prompts[0].text).toBeUndefined();
    expect(JSON.parse(o.prompts[0].editsJson).promptText).toBe('');
  });

  it('keeps attribution, the permissioned link and the prompt identity', () => {
    const o = JSON.parse(buildNotePayload(noteData(), false)).origin;
    expect(o.promptTextWithheld).toBe(true);
    expect(o.originUrl).toBe('https://getorigin.io/sessions/sess-1');
    expect(o.sessionId).toBe('sess-1');
    expect(o.model).toBe('claude-fable-5');
    expect(o.promptCount).toBe(2);
    expect(o.linesAdded).toBe(10);
    expect(o.costUsd).toBe(1.23);
    expect(o.promptHash).toBe(canonicalPromptHash(SECRET_PROMPT));
    const p0 = o.prompts[0];
    expect(p0.promptHash).toBe(canonicalPromptHash(SECRET_PROMPT));
    expect(p0.files).toEqual(['src/billing.ts']);
    expect(p0.treeSha).toBe('tree123');
    expect(p0.commitSha).toBe('head456');
    // Code edits still travel; only the embedded prompt is blanked.
    expect(JSON.parse(p0.editsJson).edits[0].newContent).toBe('b');
  });

  it('no provable prompt → no hash, never a hash of something else', () => {
    const data = noteData();
    data.fullPrompt = 'x'.repeat(5000);              // clipped by the server
    data.prompts![0].promptHash = 'not-a-hash';
    const o = JSON.parse(buildNotePayload(data, false)).origin;
    expect(o).not.toHaveProperty('promptHash');
    expect(o.prompts[0]).not.toHaveProperty('promptHash');
    // Not the summary's hash either.
    expect(JSON.stringify(o)).not.toContain(canonicalPromptHash(SECRET_SUMMARY));
  });

  it('carries real sub-agent spawns (metadata only)', () => {
    const data = noteData();
    data.subagents = [{ type: 'code-reviewer', promptIndex: 0 }, { type: null, promptIndex: 1 }];
    expect(JSON.parse(buildNotePayload(data, false)).origin.subagents).toEqual([
      { type: 'code-reviewer', promptIndex: 0 },
      { type: null, promptIndex: 1 },
    ]);
    expect(JSON.parse(buildNotePayload(noteData(), true)).origin.subagents).toBeUndefined();
  });
});

describe('buildNotePayload with the explicit opt-in', () => {
  it('keeps the legacy prompt fields and the hashes next to them', () => {
    const o = JSON.parse(buildNotePayload(noteData(), true)).origin;
    expect(o.promptSummary).toContain('billing engine');
    expect(o.fullPrompt).toBe(SECRET_PROMPT);
    expect(o.promptTextWithheld).toBeUndefined();
    expect(o.prompts[0].text).toBe(SECRET_PROMPT);
    expect(JSON.parse(o.prompts[0].editsJson).promptText).toBe(SECRET_PROMPT);
    expect(o.markers.decision).toEqual([SECRET_DECISION]);
    expect(o.promptHash).toBe(canonicalPromptHash(SECRET_PROMPT));
    expect(o.prompts[0].promptHash).toBe(canonicalPromptHash(SECRET_PROMPT));
    expect(o.originUrl).toBe('https://getorigin.io/sessions/sess-1');
  });
});

// ── per-prompt hash source, shared by post-commit, Stop and SessionEnd ─────

describe('buildPromptNoteEntries prompt hashes', () => {
  const state = (over: Record<string, unknown> = {}): any => ({
    sessionId: 'sess-1',
    agentSlug: 'claude-code',
    prompts: ['Add a retry to the upload client.', 'deploy with ghp_' + 'a'.repeat(36), 'look at [image]'],
    completedPromptMappings: [{ promptIndex: 0, promptText: 'Add a retry to the upload client.', filesChanged: ['a.ts'] }],
    ...over,
  });

  it('hashes each whole captured prompt that is provably its served record', () => {
    const entries = buildPromptNoteEntries(state(), 'claude-code', 'm');
    expect(entries.map((e) => [e.index, e.promptHash])).toEqual([
      [0, canonicalPromptHash('Add a retry to the upload client.')],
      [1, undefined],   // redaction would change it
      [2, undefined],   // an image placeholder is relinked after upload
    ]);
  });

  it('a mapping whose text differs from the captured prompt (a clipped copy) gets no hash', () => {
    const entries = buildPromptNoteEntries(state({
      completedPromptMappings: [{ promptIndex: 0, promptText: 'Add a retry', filesChanged: ['a.ts'] }],
    }), 'claude-code', 'm');
    expect(entries[0].promptHash).toBeUndefined();
  });

  it('after a resume the entries mix index spaces, so none is hashed', () => {
    const entries = buildPromptNoteEntries(state({ promptIndexBase: 4 }), 'claude-code', 'm');
    expect(entries.every((e) => e.promptHash === undefined)).toBe(true);
  });
});

// ── the real writer on a real commit ───────────────────────────────────────

describe('writeGitNotes under the default policy', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();

  function commit(): string {
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
    git('config', 'user.email', 'dev@example.com');
    git('config', 'user.name', 'Dev');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'a');
    return git('rev-parse', 'HEAD');
  }

  function sessionState(sha: string, prompt: string): any {
    return {
      sessionId: 'sess-77', agentSlug: 'claude-code', model: 'claude-opus-5-5',
      prompts: ['first', prompt], promptTurnIds: ['t0', 't1'],
      commitTurns: [{ sha, turnId: 't1', at: '2026-10-02T10:00:00Z', via: 'post-commit' }],
    };
  }

  function write(sha: string, prompt: string) {
    const st = sessionState(sha, `${prompt}`);
    writeGitNotes(repo, [sha], {
      ...noteData(),
      sessionId: 'sess-77',
      agentSlug: 'claude-code',
      fullPrompt: st.prompts[1],
      promptSummary: st.prompts[1],
      prompts: buildPromptNoteEntries(st, 'claude-code', 'claude-opus-5-5'),
      originUrl: 'https://origin.example.com/sessions/sess-77',
      attribution: attributionSourceFromState(st, { connected: true, apiUrl: 'https://origin.example.com' }),
    });
    return JSON.parse(git('notes', '--ref=origin', 'show', sha));
  }

  it('the note holds no prompt text but the hash and link of the commit\'s own prompt', () => {
    const sha = commit();
    const prompt = `${LEAK} add a retry to the upload client`;
    const note = write(sha, prompt);
    expect(JSON.stringify(note)).not.toContain(LEAK);
    expect(note.origin.promptTextWithheld).toBe(true);
    expect(note.origin.promptHash).toBe(canonicalPromptHash(prompt));
    expect(note.origin.prompts.find((p: any) => p.index === 1).promptHash).toBe(canonicalPromptHash(prompt));
    const iteration = note.attribution_record.contributions[0].session.iterations;
    expect(note.attribution_record.revision.id).toBe(sha);
    expect(iteration).toEqual([{
      index: 1,
      prompt_hash: canonicalPromptHash(prompt),
      reference_uri: 'https://origin.example.com/sessions/sess-77?prompt=1',
    }]);
  });

  it('an unprovable prompt keeps the link and drops only the hash', () => {
    const sha = commit();
    const note = write(sha, `${LEAK} <user_query>add a retry</user_query>`);
    expect(JSON.stringify(note)).not.toContain(LEAK);
    expect(note.origin).not.toHaveProperty('promptHash');
    expect(note.origin.originUrl).toBe('https://origin.example.com/sessions/sess-77');
    expect(note.attribution_record.contributions[0].session.iterations).toEqual([
      { index: 1, reference_uri: 'https://origin.example.com/sessions/sess-77?prompt=1' },
    ]);
  });

  it('a sealing repo writes no clear text from a machine with the global opt-in', () => {
    const sha = commit();
    setMachine({ notesIncludePrompts: true });
    setRepo({ notesEncryptPrompts: true });
    const note = write(sha, `${LEAK} add a retry to the upload client`);
    expect(JSON.stringify(note)).not.toContain(LEAK);
    expect(note.origin.promptTextWithheld).toBe(true);
  });

  it('the repo opt-in brings the prompt text back, hash included', () => {
    const sha = commit();
    setRepo({ notesIncludePrompts: true });
    const prompt = `${LEAK} add a retry to the upload client`;
    const note = write(sha, prompt);
    expect(note.origin.fullPrompt).toBe(prompt);
    expect(note.origin.promptHash).toBe(canonicalPromptHash(prompt));
  });
});

describe('scrubNoteObject (retroactive cleanup)', () => {
  const TRUNCATED = '\n/* [origin: editsJson truncated for note portability] */';

  it('strips all prompt-text carriers from a legacy note and keeps the hashes', () => {
    const legacy = JSON.parse(buildNotePayload(noteData(), true));
    const result = scrubNoteObject(legacy);
    expect(result.status).toBe('rewritten');
    const { changed, scrubbed } = result as any;
    expect(changed).toBe(true);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(LEAK);
    expect(serialized).not.toContain('acquisition');
    expect(scrubbed.origin.markers).toBeUndefined();
    expect(scrubbed.origin.promptTextWithheld).toBe(true);
    expect(scrubbed.origin.promptHash).toBe(canonicalPromptHash(SECRET_PROMPT));
    expect(scrubbed.origin.prompts[0].promptHash).toBe(legacy.origin.prompts[0].promptHash);
    expect(scrubbed.origin.model).toBe('claude-fable-5');
    expect(scrubbed.origin.prompts[0].files).toEqual(['src/billing.ts']);
    expect(JSON.parse(scrubbed.origin.prompts[0].editsJson).edits).toHaveLength(1);
    expect(verifyScrubbedNote(legacy, scrubbed)).toBeNull();
    // The input is not mutated.
    expect(JSON.stringify(legacy)).toContain(LEAK);
  });

  it('names and counts every carrier it removes', () => {
    const legacy = JSON.parse(buildNotePayload(noteData(), true));
    const result = scrubNoteObject(legacy);
    expect(result.status === 'rewritten' && result.removed).toEqual({
      'origin.promptSummary': 1,
      'origin.fullPrompt': 1,
      'origin.markers': 1,
      'origin.prompts[].text': 1,
      'origin.prompts[].editsJson.promptText': 1,
    });
  });

  it('removes a carrier by its key, empty values included', () => {
    const note = {
      origin: {
        version: 1, promptSummary: '', fullPrompt: '', markers: {},
        prompts: [{ index: 0, text: '', files: ['a.ts'] }],
      },
    };
    const result = scrubNoteObject(note);
    expect(result.status).toBe('rewritten');
    const origin = (result as any).scrubbed.origin;
    expect(Object.keys(origin)).not.toContain('promptSummary');
    expect(Object.keys(origin)).not.toContain('fullPrompt');
    expect(Object.keys(origin)).not.toContain('markers');
    expect(Object.keys(origin.prompts[0])).toEqual(['index', 'files']);
  });

  it('removes only promptText from a valid editsJson and keeps every other key and type', () => {
    const edits = { promptIndex: 3, promptText: SECRET_PROMPT, nullable: null, flag: false, nested: { list: [1, 'two', { three: 3 }] } };
    const note = { origin: { version: 1, prompts: [{ index: 3, editsJson: JSON.stringify(edits) }] } };
    const result = scrubNoteObject(note);
    expect(result.status).toBe('rewritten');
    const { promptText, ...rest } = edits;
    expect(JSON.parse((result as any).scrubbed.origin.prompts[0].editsJson)).toStrictEqual(rest);
  });

  it('is a no-op on an already-clean note, including the writer\'s blanked editsJson', () => {
    const clean = JSON.parse(buildNotePayload(noteData(), false));
    expect(JSON.parse(clean.origin.prompts[0].editsJson).promptText).toBe('');
    const result = scrubNoteObject(clean);
    expect(result.status).toBe('clean');
    expect(result.changed).toBe(false);
    expect(result.scrubbed).toBe(clean);
  });

  it('is idempotent: a scrubbed note is clean', () => {
    const once = scrubNoteObject(JSON.parse(buildNotePayload(noteData(), true)));
    expect(scrubNoteObject(once.scrubbed).status).toBe('clean');
  });

  it('blocks a truncated editsJson that still holds prompt text, and changes nothing', () => {
    const legacy = JSON.parse(buildNotePayload(noteData(), true));
    legacy.origin.prompts[0].editsJson = `{"promptIndex":0,"promptText":"${LEAK} start` + TRUNCATED;
    const result = scrubNoteObject(legacy);
    expect(result).toMatchObject({ status: 'blocked', reason: 'edits_json_truncated', field: 'origin.prompts[].editsJson' });
    expect(result.changed).toBe(false);
    expect(result.scrubbed).toBe(legacy);
    expect(legacy.origin.prompts[0].editsJson).toContain(LEAK);
  });

  it('accepts a truncated editsJson whose kept bytes hold no prompt text', () => {
    // The metadata-only writer blanks promptText before the cut.
    const blanked = { origin: { version: 1, prompts: [{ index: 0, editsJson: '{"promptIndex":0,"promptText":"","edits":[{"file":"a.ts","newContent":"con' + TRUNCATED }] } };
    expect(scrubNoteObject(blanked).status).toBe('clean');
    // Cut before the promptText key was reached.
    const cutEarly = { origin: { version: 1, prompts: [{ index: 0, editsJson: '{"edits":[{"file":"a.ts","newContent":"x\\"y' + TRUNCATED }] } };
    expect(scrubNoteObject(cutEarly).status).toBe('clean');
  });

  it('blocks a truncated editsJson whose prefix cannot be read', () => {
    const note = { origin: { version: 1, prompts: [{ index: 0, editsJson: '{"a" 1' + TRUNCATED }] } };
    expect(scrubNoteObject(note)).toMatchObject({ status: 'blocked', reason: 'edits_json_invalid' });
  });

  it('blocks a truncated editsJson with a raw control character inside a string', () => {
    // JSON.stringify escapes U+0000..U+001F, so these bytes were never written as JSON.
    for (const raw of ['\u0001', '\n', '\u001f']) {
      const editsJson = `{"edits":[{"file":"a.ts","newContent":"x${raw}y"}],"promptText":""` + TRUNCATED;
      expect(scrubNoteObject({ origin: { version: 1, prompts: [{ index: 0, editsJson }] } }))
        .toMatchObject({ status: 'blocked', reason: 'edits_json_invalid' });
    }
    // The escaped form of the same bytes is clean.
    const escaped = `{"edits":[{"file":"a.ts","newContent":"x\\ny"}],"promptText":""` + TRUNCATED;
    expect(scrubNoteObject({ origin: { version: 1, prompts: [{ index: 0, editsJson: escaped }] } }).status).toBe('clean');
  });

  it('blocks an invalid, non-object or wrongly typed editsJson', () => {
    const withEdits = (editsJson: unknown) => ({ origin: { version: 1, prompts: [{ index: 0, editsJson }] } });
    expect(scrubNoteObject(withEdits('{"promptText": "x"'))).toMatchObject({ status: 'blocked', reason: 'edits_json_invalid' });
    expect(scrubNoteObject(withEdits('[1,2]'))).toMatchObject({ status: 'blocked', reason: 'edits_json_not_object' });
    expect(scrubNoteObject(withEdits({ promptText: 'x' }))).toMatchObject({ status: 'blocked', reason: 'edits_json_wrong_type' });
    expect(scrubNoteObject(withEdits('{"promptText":42}'))).toMatchObject({ status: 'blocked', reason: 'carrier_wrong_type' });
  });

  it('blocks a carrier of an unexpected type instead of guessing', () => {
    expect(scrubNoteObject({ origin: { fullPrompt: { text: 'x' } } })).toMatchObject({ status: 'blocked', reason: 'carrier_wrong_type', field: 'origin.fullPrompt' });
    expect(scrubNoteObject({ origin: { promptSummary: null } })).toMatchObject({ status: 'blocked', field: 'origin.promptSummary' });
    expect(scrubNoteObject({ origin: { markers: ['x'] } })).toMatchObject({ status: 'blocked', field: 'origin.markers' });
    expect(scrubNoteObject({ origin: { prompts: [{ text: 7 }] } })).toMatchObject({ status: 'blocked', field: 'origin.prompts[].text' });
    expect(scrubNoteObject({ origin: { prompts: {} } })).toMatchObject({ status: 'blocked', reason: 'prompts_not_array' });
    expect(scrubNoteObject({ origin: { prompts: ['x'] } })).toMatchObject({ status: 'blocked', reason: 'prompt_entry_not_object' });
  });

  it('a JSON object without an `origin` key is clean as it is: the three known formats', () => {
    const record = { schema_version: 1, revision: 'a'.repeat(40), agent_id: 'claude', session_id: 'sess-1' };
    const known = [
      // record-only note (corpus fixture #2048)
      { attribution_record: record },
      // rewrite note (#1967)
      { attribution_record: record, origin_rewrite: { schema: 'origin-rewrite/1', target: 'a'.repeat(40), sources: ['b'.repeat(40)], base: 'none' } },
      // bare backfill object
      { sessionId: 'backfill-abcdef12', agent: 'claude', agentName: 'claude', model: 'unknown', confidence: 'high', source: 'backfill-coauthor' },
    ];
    for (const note of known) {
      const result = scrubNoteObject(note);
      expect(result).toMatchObject({ status: 'clean', changed: false });
      expect(result.scrubbed).toBe(note);
      expect(scrubNoteBody(JSON.stringify(note, null, 2) + '\n').status).toBe('clean');
      expect(scrubNoteObject(note, { dropUnprovableEdits: true }).status).toBe('clean');
    }
  });

  it('a malformed `origin`, a non-object JSON value or a non-JSON body stays blocked', () => {
    for (const origin of ['text', 42, null, ['x'], true]) {
      expect(scrubNoteObject({ origin, attribution_record: {} })).toMatchObject({ status: 'blocked', reason: 'origin_not_object', field: 'origin', changed: false });
    }
    for (const value of [null, [1], 'x', 3, [{ origin: {} }]]) {
      expect(scrubNoteObject(value)).toMatchObject({ status: 'blocked', reason: 'not_json_object', changed: false });
    }
    expect(scrubNoteBody('Origin-Session: plain text note')).toMatchObject({ status: 'blocked', reason: 'not_json' });
    expect(scrubNoteBody('[]')).toMatchObject({ status: 'blocked', reason: 'not_json_object' });
  });

  it('keeps unknown top-level fields and the attribution record', () => {
    const legacy = { ...JSON.parse(buildNotePayload(noteData(), true)), attribution_record: { schema: 1, agent: 'claude' }, future_field: [1] };
    const { scrubbed } = scrubNoteObject(legacy) as any;
    expect(scrubbed.attribution_record).toStrictEqual(legacy.attribution_record);
    expect(scrubbed.future_field).toStrictEqual([1]);
  });

  it('verifyScrubbedNote refuses any change outside the prompt carriers', () => {
    const legacy = { ...JSON.parse(buildNotePayload(noteData(), true)), attribution_record: { schema: 1 } };
    const { scrubbed } = scrubNoteObject(legacy) as any;
    expect(verifyScrubbedNote(legacy, scrubbed)).toBeNull();
    expect(verifyScrubbedNote(legacy, { ...scrubbed, attribution_record: { schema: 2 } })).toBe('attribution_record changed');
    expect(verifyScrubbedNote(legacy, { ...scrubbed, origin: { ...scrubbed.origin, model: 'other' } })).toBe('a non-prompt field changed');
    const lostEdit = structuredClone(scrubbed);
    lostEdit.origin.prompts[0].editsJson = JSON.stringify({ promptIndex: 0 });
    expect(verifyScrubbedNote(legacy, lostEdit)).toBe('a non-prompt field changed');
    expect(verifyScrubbedNote(legacy, legacy)).toBe('rewrite still carries prompt text');
  });
});

describe('scrubNoteObject with dropUnprovableEdits', () => {
  const drop = { dropUnprovableEdits: true };
  const truncatedWithPrompt = `{"promptIndex":0,"promptText":"${LEAK} start of a prompt` + EDITS_TRUNCATED_MARKER;
  function legacyTruncated() {
    const legacy = JSON.parse(buildNotePayload(noteData(), true));
    legacy.origin.prompts[0].editsJson = truncatedWithPrompt;
    legacy.attribution_record = { schema_version: 1, revision: 'c'.repeat(40), agent_id: 'claude', session_id: 'sess-1' };
    legacy.future_field = { kept: [1, 'two'] };
    return legacy;
  }

  it('default: a prompt-bearing truncated editsJson blocks, and the input is untouched', () => {
    const legacy = legacyTruncated();
    const snapshot = structuredClone(legacy);
    const result = scrubNoteObject(legacy);
    expect(result).toMatchObject({ status: 'blocked', reason: 'edits_json_truncated', field: 'origin.prompts[].editsJson', changed: false });
    expect(result.scrubbed).toBe(legacy);
    expect(legacy).toStrictEqual(snapshot);
  });

  it('opt-in: deletes only the whole editsJson; every sibling field and attribution_record is kept', () => {
    const legacy = legacyTruncated();
    const snapshot = structuredClone(legacy);
    const result = scrubNoteObject(legacy, drop);
    expect(result.status).toBe('rewritten');
    if (result.status !== 'rewritten') return;
    expect(result.droppedEditsJson).toBe(1);
    // Counted apart from the in-place carrier removals: no editsJson.promptText entry for it.
    expect(result.removed['origin.prompts[].editsJson.promptText']).toBeUndefined();
    expect(result.removed['origin.prompts[].text']).toBe(1);
    expect(JSON.stringify(result.scrubbed)).not.toContain(LEAK);
    const { text, editsJson, ...siblings } = snapshot.origin.prompts[0];
    expect(result.scrubbed.origin.prompts[0]).toStrictEqual(siblings);
    expect(result.scrubbed.origin.promptTextWithheld).toBe(true);
    expect(result.scrubbed.attribution_record).toStrictEqual(snapshot.attribution_record);
    expect(result.scrubbed.future_field).toStrictEqual(snapshot.future_field);
    const { promptSummary, fullPrompt, markers, prompts, ...originRest } = snapshot.origin;
    const { prompts: _p, promptTextWithheld, ...afterRest } = result.scrubbed.origin;
    expect(afterRest).toStrictEqual(originRest);
    expect(legacy).toStrictEqual(snapshot);
    expect(verifyScrubbedNote(legacy, result.scrubbed, drop)).toBeNull();
    // A scrubbed note is clean with or without the option.
    expect(scrubNoteObject(result.scrubbed).status).toBe('clean');
    expect(scrubNoteObject(result.scrubbed, drop).status).toBe('clean');
  });

  it('a note whose only carrier is the truncated editsJson is rewritten too', () => {
    const note = { origin: { version: 1, prompts: [{ index: 0, files: ['a.ts'], promptHash: 'v1:aa', editsJson: truncatedWithPrompt }] } };
    const result = scrubNoteObject(note, drop);
    expect(result).toMatchObject({ status: 'rewritten', droppedEditsJson: 1, removed: {} });
    expect((result as any).scrubbed.origin.prompts).toStrictEqual([{ index: 0, files: ['a.ts'], promptHash: 'v1:aa' }]);
  });

  it('does not open up anything else', () => {
    const withEdits = (editsJson: unknown) => ({ origin: { version: 1, prompts: [{ index: 0, editsJson }] } });
    const cases: Array<[unknown, string]> = [
      // invalid JSON without the writer's marker
      [`{"promptText":"${LEAK}"`, 'edits_json_invalid'],
      // a marker that is close but not exact
      [`{"promptText":"${LEAK}` + EDITS_TRUNCATED_MARKER.trim(), 'edits_json_invalid'],
      [`{"promptText":"${LEAK}` + EDITS_TRUNCATED_MARKER + ' ', 'edits_json_invalid'],
      // a truncated prefix that is not readable JSON tokens
      ['{"a" 1' + EDITS_TRUNCATED_MARKER, 'edits_json_invalid'],
      [`{"promptText":"${LEAK}\u0001x` + EDITS_TRUNCATED_MARKER, 'edits_json_invalid'],
      [`{"promptText":42,"x":"${LEAK}` + EDITS_TRUNCATED_MARKER, 'edits_json_invalid'],
      // wrong carrier types
      [{ promptText: LEAK }, 'edits_json_wrong_type'],
      ['{"promptText":42}', 'carrier_wrong_type'],
      ['[1,2]', 'edits_json_not_object'],
    ];
    for (const [editsJson, reason] of cases) {
      expect(scrubNoteObject(withEdits(editsJson), drop)).toMatchObject({ status: 'blocked', reason });
    }
    expect(scrubNoteObject({ origin: { fullPrompt: { text: LEAK } } }, drop)).toMatchObject({ status: 'blocked', reason: 'carrier_wrong_type' });
    expect(scrubNoteBody(`not json ${LEAK}`, drop)).toMatchObject({ status: 'blocked', reason: 'not_json' });
    expect(scrubNoteObject({ origin: LEAK }, drop)).toMatchObject({ status: 'blocked', reason: 'origin_not_object' });
    // A truncated value whose kept bytes hold no prompt text is still kept, not dropped.
    const blanked = withEdits('{"promptIndex":0,"promptText":"","edits":[{"file":"a.ts","newContent":"con' + EDITS_TRUNCATED_MARKER);
    expect(scrubNoteObject(blanked, drop)).toMatchObject({ status: 'clean' });
  });

  it('verifyScrubbedNote accepts a dropped editsJson only with the option and only where the source proves it', () => {
    const legacy = legacyTruncated();
    const { scrubbed } = scrubNoteObject(legacy, drop) as any;
    expect(verifyScrubbedNote(legacy, scrubbed)).toBe('an editsJson was dropped without --drop-unprovable-edits');
    // A valid editsJson dropped by the rewrite: refused even with the option.
    const valid = JSON.parse(buildNotePayload(noteData(), true));
    const { scrubbed: validScrubbed } = scrubNoteObject(valid) as any;
    const lost = structuredClone(validScrubbed);
    delete lost.origin.prompts[0].editsJson;
    expect(verifyScrubbedNote(valid, lost, drop)).toBe('a dropped editsJson was not a truncated capture holding prompt text');
    // A truncated value without prompt text dropped: refused.
    const blankedSrc = { origin: { version: 1, prompts: [{ index: 0, text: 'x', editsJson: '{"promptText":"","edits":[' + EDITS_TRUNCATED_MARKER }] } };
    expect(verifyScrubbedNote(blankedSrc, { origin: { version: 1, promptTextWithheld: true, prompts: [{ index: 0 }] } }, drop))
      .toBe('a dropped editsJson was not a truncated capture holding prompt text');
    // A sibling changed next to the drop: refused.
    const touched = structuredClone(scrubbed);
    touched.origin.prompts[0].files = ['elsewhere.ts'];
    expect(verifyScrubbedNote(legacy, touched, drop)).toBe('a non-prompt field changed');
    const record = structuredClone(scrubbed);
    record.attribution_record.agent_id = 'codex';
    expect(verifyScrubbedNote(legacy, record, drop)).toBe('attribution_record changed');
  });
});
