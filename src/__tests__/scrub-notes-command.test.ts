/**
 * `origin scrub-notes` against real git repositories (OR-49/A9).
 *
 * A work clone, a bare "remote" and a second clone of it. The notes ref holds
 * a legacy note with every prompt carrier, one with empty carriers, two clean
 * notes, and an earlier prompt-bearing version of one of them in the ref's
 * history. Every prompt-derived value contains SENTINEL; nothing else does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { gitDetailed } from '../utils/exec.js';
import { scrubNotesCommand, CANDIDATE_REF_PREFIX, type GitRunner } from '../commands/scrub-notes.js';

const SENTINEL = 'OR49_SENTINEL_prompt_c41e';
const TRUNCATED = '\n/* [origin: editsJson truncated for note portability] */';

let root: string;
let work: string;
let remote: string;
let other: string;
let commits: string[];
let output: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 1 << 28 }).trim();
}

function configure(cwd: string) {
  git(cwd, 'config', 'user.name', 'Scrub Test');
  git(cwd, 'config', 'user.email', 'scrub@test.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

// The exact bytes as one note, without `git notes add -m` whitespace cleanup.
function putNote(cwd: string, commit: string, body: string) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: body, encoding: 'utf8' }).trim();
  git(cwd, 'notes', '--ref=origin', 'add', '-f', '-C', blob, commit);
}

function notesMap(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  let list = '';
  try { list = git(cwd, 'notes', '--ref=origin', 'list'); } catch { return out; }
  for (const line of list.split('\n').filter(Boolean)) {
    const [blob, commit] = line.split(' ');
    out.set(commit, blob);
  }
  return out;
}

const noteJson = (cwd: string, commit: string) => JSON.parse(git(cwd, 'notes', '--ref=origin', 'show', commit));
const allRefs = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)');
const tip = (cwd: string, ref = 'refs/notes/origin') => git(cwd, 'rev-parse', ref);

// Does any object in this repository's database contain the needle?
function objectDbContains(cwd: string, needle: string): boolean {
  const all = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch'], { cwd, maxBuffer: 1 << 28 });
  return all.includes(Buffer.from(needle));
}

// Does anything a fetch of `ref` transfers contain the needle?
function reachableContains(cwd: string, ref: string, needle: string): boolean {
  const shas = git(cwd, 'rev-list', '--objects', ref).split('\n').map((l) => l.split(' ')[0]).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd, input: shas, maxBuffer: 1 << 28 });
  return out.includes(Buffer.from(needle));
}

const attribution = (commit: string) => ({ schema_version: 1, revision: commit, agent_id: 'claude', session_id: 'sess-49' });

function legacyFullNote(commit: string) {
  return {
    origin: {
      version: 1,
      sessionId: 'sess-49',
      model: 'claude-fable-5',
      agent: 'claude',
      promptCount: 2,
      promptHash: 'v1:0f1e2d3c4b5a',
      promptSummary: `${SENTINEL} summary`,
      fullPrompt: `${SENTINEL} full prompt`,
      markers: { intent: [`${SENTINEL} intent`], decision: [`${SENTINEL} decision`] },
      prompts: [
        {
          index: 0,
          text: `${SENTINEL} first prompt`,
          promptHash: 'v1:aa11',
          model: 'claude-fable-5',
          files: ['src/a.ts'],
          editsJson: JSON.stringify({
            promptIndex: 0,
            promptText: `${SENTINEL} first prompt`,
            agent: 'claude',
            edits: [{ file: 'src/a.ts', oldContent: 'a', newContent: 'b', lines: [1, 2] }],
            empty: null,
          }),
          treeSha: 'tree-a',
          commitSha: 'commit-a',
        },
        { index: 1, text: `${SENTINEL} second prompt`, files: ['src/b.ts'] },
      ],
      originUrl: 'https://getorigin.io/sessions/sess-49',
      linesAdded: 12,
      linesRemoved: 3,
      aiPercentage: 80,
    },
    attribution_record: attribution(commit),
    future_top_level: { kept: true, list: [1, 'two'] },
  };
}

function legacyEmptyNote(commit: string) {
  return {
    origin: { version: 1, promptSummary: '', markers: {}, prompts: [{ index: 0, text: '', files: ['src/c.ts'] }], originUrl: 'https://getorigin.io/sessions/sess-50' },
    attribution_record: attribution(commit),
  };
}

function cleanNote(commit: string) {
  return {
    origin: {
      version: 1,
      promptTextWithheld: true,
      prompts: [{ index: 0, promptHash: 'v1:cc33', editsJson: '{"promptIndex":0,"promptText":"","edits":[{"file":"src/d.ts","newContent":"lo' + TRUNCATED }],
      originUrl: 'https://getorigin.io/sessions/sess-51',
    },
    attribution_record: attribution(commit),
  };
}

const pretty = (o: unknown) => JSON.stringify(o, null, 2) + '\n';

function makeRunner(intercept?: (args: string[]) => ReturnType<GitRunner> | void, cwd?: string) {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const runner: GitRunner = (args, opts = {}) => {
    calls.push(args);
    envs.push(opts.env);
    const forced = intercept?.(args);
    if (forced) return forced;
    return gitDetailed(args, { cwd: cwd ?? work, ...opts, maxBuffer: 1 << 29 });
  };
  return { runner, calls, envs };
}

async function scrub(opts: { dryRun?: boolean; push?: boolean; remote?: string; dropUnprovableEdits?: boolean }, runner?: GitRunner, cwd?: string): Promise<number> {
  process.exitCode = undefined;
  await scrubNotesCommand(opts, { cwd: cwd ?? work, git: runner });
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return code;
}

const isWrite = (args: string[]) =>
  ['fast-import', 'update-ref', 'push', 'fetch', 'hash-object', 'notes', 'commit-tree', 'mktree'].includes(args[0]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'or49-scrub-'));
  remote = path.join(root, 'remote.git');
  work = path.join(root, 'work');
  other = path.join(root, 'other');
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', '-b', 'main', work);
  configure(work);
  commits = [];
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(work, `f${i}.txt`), `content ${i}\n`);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', `commit ${i}`);
    commits.push(git(work, 'rev-parse', 'HEAD'));
  }
  git(work, 'tag', 'v1', commits[1]);
  git(work, 'branch', 'feature', commits[2]);
  git(work, 'remote', 'add', 'origin', remote);

  putNote(work, commits[0], pretty(legacyFullNote(commits[0])));
  putNote(work, commits[1], pretty(legacyEmptyNote(commits[1])));
  putNote(work, commits[2], pretty(cleanNote(commits[2])));
  // An earlier prompt-bearing version of commits[3]'s note stays in history.
  putNote(work, commits[3], pretty(legacyFullNote(commits[3])));
  putNote(work, commits[3], pretty(cleanNote(commits[3])));

  // Out-of-scope refs that must never be touched (no prompt text in them).
  git(work, 'notes', '--ref=origin-memory', 'add', '-m', 'memory payload', commits[0]);
  git(work, 'branch', 'origin-sessions', commits[4]);
  git(work, 'update-ref', 'refs/origin/sessions/sess-49', commits[4]);
  git(work, 'push', '-q', 'origin', 'main', 'feature', 'origin-sessions', '--tags',
    'refs/notes/origin:refs/notes/origin', 'refs/notes/origin-memory:refs/notes/origin-memory',
    'refs/origin/sessions/sess-49:refs/origin/sessions/sess-49');
  // A local branch that was never pushed: the scrub push must not publish it.
  git(work, 'branch', 'local-only', commits[4]);

  output = '';
  const capture = (...args: unknown[]) => { output += args.map(String).join(' ') + '\n'; };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

function cloneOther() {
  git(root, 'clone', '-q', remote, other);
  configure(other);
  git(other, 'fetch', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
}

describe('origin scrub-notes --dry-run', () => {
  it('reports counts and carrier names, and changes nothing', async () => {
    const refsBefore = allRefs(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({ dryRun: true }, runner)).toBe(0);
    expect(allRefs(work)).toBe(refsBefore);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(calls.some((a) => a[0] === 'ls-remote')).toBe(false);
    expect(output).not.toContain(SENTINEL);
    expect(output).toContain('dry run');
    expect(output).toContain('notes:     4 (2 already clean, 2 to rewrite, 0 blocked)');
    expect(output).toContain('origin.promptSummary ×2');
    expect(output).toContain('origin.fullPrompt ×1');
    expect(output).toContain('origin.markers ×2');
    expect(output).toContain('origin.prompts[].text ×3');
    expect(output).toContain('origin.prompts[].editsJson.promptText ×1');
    expect(output).toContain('history:   5 commits, 1 earlier note version not provably clean');
    expect(output).toContain('remote:    not contacted (dry run)');
  });

  it('rejects --dry-run with --push, and --remote without --push', async () => {
    const refsBefore = allRefs(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({ dryRun: true, push: true }, runner)).toBe(1);
    expect(output).toContain('--dry-run and --push cannot be combined');
    expect(await scrub({ remote: 'origin' }, runner)).toBe(1);
    expect(output).toContain('--remote only applies with --push');
    expect(calls).toEqual([]);
    expect(allRefs(work)).toBe(refsBefore);
  });
});

describe('origin scrub-notes (local rewrite)', () => {
  it('removes every carrier, keeps everything else, and touches no code ref', async () => {
    const notesBefore = notesMap(work);
    const oldTip = tip(work);
    const codeRefs = git(work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags');
    const head = git(work, 'rev-parse', 'HEAD');
    const memoryTip = tip(work, 'refs/notes/origin-memory');

    expect(await scrub({})).toBe(0);
    const newTip = tip(work);
    expect(newTip).not.toBe(oldTip);
    expect(output).toContain(`ref tip:   ${oldTip}`);
    expect(output).toContain(`new tip:   ${newTip}`);
    expect(output).toContain(`git update-ref refs/notes/origin ${oldTip} ${newTip}`);
    expect(output).not.toContain(SENTINEL);

    // Same notes on the same commits; untouched notes byte-identical.
    const notesAfter = notesMap(work);
    expect([...notesAfter.keys()].sort()).toEqual([...notesBefore.keys()].sort());
    expect(notesAfter.get(commits[2])).toBe(notesBefore.get(commits[2]));
    expect(notesAfter.get(commits[3])).toBe(notesBefore.get(commits[3]));
    expect(notesAfter.get(commits[0])).not.toBe(notesBefore.get(commits[0]));

    // One parentless commit: the prompt-bearing history is gone from the ref.
    expect(git(work, 'rev-list', '--count', 'refs/notes/origin')).toBe('1');
    expect(reachableContains(work, 'refs/notes/origin', SENTINEL)).toBe(false);

    // Everything that is not a prompt carrier survives.
    const expected = legacyFullNote(commits[0]);
    const after = noteJson(work, commits[0]);
    expect(after.attribution_record).toStrictEqual(expected.attribution_record);
    expect(after.future_top_level).toStrictEqual(expected.future_top_level);
    const { promptSummary, fullPrompt, markers, prompts, ...safeOrigin } = expected.origin;
    const { prompts: afterPrompts, promptTextWithheld, ...afterOrigin } = after.origin;
    expect(afterOrigin).toStrictEqual(safeOrigin);
    expect(promptTextWithheld).toBe(true);
    const { text, editsJson, ...safePrompt0 } = prompts[0] as any;
    const { editsJson: afterEdits, ...afterPrompt0 } = afterPrompts[0];
    expect(afterPrompt0).toStrictEqual(safePrompt0);
    const { promptText, ...safeEdits } = JSON.parse(editsJson);
    expect(JSON.parse(afterEdits)).toStrictEqual(safeEdits);
    expect(afterPrompts[1]).toStrictEqual({ index: 1, files: ['src/b.ts'] });
    const empty = noteJson(work, commits[1]);
    expect(empty).toStrictEqual({
      origin: { version: 1, prompts: [{ index: 0, files: ['src/c.ts'] }], originUrl: 'https://getorigin.io/sessions/sess-50', promptTextWithheld: true },
      attribution_record: attribution(commits[1]),
    });

    expect(git(work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags')).toBe(codeRefs);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(tip(work, 'refs/notes/origin-memory')).toBe(memoryTip);
    expect(git(work, 'for-each-ref', CANDIDATE_REF_PREFIX.replace(/candidate-$/, ''))).toBe('');
    // The remote was not contacted.
    expect(tip(remote)).toBe(oldTip);
  });

  it('is idempotent: a second run changes nothing', async () => {
    expect(await scrub({})).toBe(0);
    const once = tip(work);
    output = '';
    const { runner, calls } = makeRunner();
    expect(await scrub({}, runner)).toBe(0);
    expect(tip(work)).toBe(once);
    expect(output).toContain('already clean; nothing to do');
    expect(calls.filter(isWrite)).toEqual([]);
  });

  it('a ref that only has prompt text in its history is still replaced', async () => {
    // Scrub everything but leave the old history behind: what the previous
    // `git notes add -f` based scrub-notes produced.
    putNote(work, commits[0], pretty({ origin: { version: 1, promptTextWithheld: true }, attribution_record: attribution(commits[0]) }));
    putNote(work, commits[1], pretty({ origin: { version: 1, promptTextWithheld: true }, attribution_record: attribution(commits[1]) }));
    expect(await scrub({ dryRun: true })).toBe(0);
    expect(output).toContain('0 to rewrite');
    expect(output).toContain('would rewrite 0 notes and the ref history');
    expect(await scrub({})).toBe(0);
    expect(reachableContains(work, 'refs/notes/origin', SENTINEL)).toBe(false);
    expect(git(work, 'rev-list', '--count', 'refs/notes/origin')).toBe('1');
  });
});

describe('origin scrub-notes refuses what it cannot prove clean', () => {
  const bad: Array<[string, string]> = [
    ['a truncated editsJson that holds prompt text', pretty({ origin: { version: 1, prompts: [{ index: 0, editsJson: `{"promptIndex":0,"promptText":"${SENTINEL} cut` + TRUNCATED }] } })],
    ['an invalid editsJson', pretty({ origin: { version: 1, prompts: [{ index: 0, editsJson: `{"promptText":"${SENTINEL}"` }] } })],
    ['a body that is not JSON', `Origin-Session: sess-49\n${SENTINEL} plain text\n`],
    ['an `origin` that is not an object', pretty({ origin: `${SENTINEL} malformed envelope`, attribution_record: attribution('x') })],
    ['a JSON array', pretty([{ origin: { fullPrompt: `${SENTINEL} in an array` } }])],
  ];

  for (const [label, body] of bad) {
    it(`${label}: non-zero, nothing rewritten or pushed, nothing printed`, async () => {
      putNote(work, commits[4], body);
      git(work, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
      const refsBefore = allRefs(work);
      const remoteBefore = allRefs(remote);
      const { runner, calls } = makeRunner();
      expect(await scrub({ push: true }, runner)).toBe(1);
      expect(allRefs(work)).toBe(refsBefore);
      expect(allRefs(remote)).toBe(remoteBefore);
      expect(calls.filter(isWrite)).toEqual([]);
      expect(output).toContain(commits[4].slice(0, 12));
      expect(output).toContain('cannot be proven clean');
      expect(output).not.toContain(SENTINEL);
    });
  }

  // --drop-unprovable-edits opens exactly one case (the first one above).
  for (const [label, body] of bad.slice(1)) {
    it(`${label}: still blocked with --drop-unprovable-edits`, async () => {
      putNote(work, commits[4], body);
      git(work, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
      const refsBefore = allRefs(work);
      const remoteBefore = allRefs(remote);
      const { runner, calls } = makeRunner();
      expect(await scrub({ dryRun: true, dropUnprovableEdits: true }, runner)).toBe(1);
      expect(await scrub({ dropUnprovableEdits: true }, runner)).toBe(1);
      expect(await scrub({ push: true, dropUnprovableEdits: true }, runner)).toBe(1);
      expect(allRefs(work)).toBe(refsBefore);
      expect(allRefs(remote)).toBe(remoteBefore);
      expect(calls.filter(isWrite)).toEqual([]);
      expect(output).toContain('cannot be proven clean');
      expect(output).not.toContain('--dry-run --drop-unprovable-edits');
      expect(output).not.toContain(SENTINEL);
    });
  }

  it('an unreadable note object: non-zero and the ref is unchanged, with or without --drop-unprovable-edits', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: `{"origin":{"fullPrompt":"${SENTINEL}"}}` }).toString().trim();
    git(work, 'notes', '--ref=origin', 'add', '-f', '-C', blob, commits[4]);
    fs.rmSync(path.join(work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const refsBefore = allRefs(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({}, runner)).toBe(1);
    expect(await scrub({ dropUnprovableEdits: true }, runner)).toBe(1);
    expect(allRefs(work)).toBe(refsBefore);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(output).not.toContain(SENTINEL);
  });
});

describe('origin scrub-notes stays honest and leaks nothing', () => {
  it('after a plain local rewrite, --push refuses, says why, and points to a fresh clone', async () => {
    expect(await scrub({})).toBe(0);
    expect(output).not.toContain('origin scrub-notes --push --remote');
    expect(output).toContain('--push from here will refuse');
    expect(output).toContain('fresh clone');
    const localTip = tip(work);
    const remoteBefore = allRefs(remote);
    output = '';
    const { runner, calls } = makeRunner();
    expect(await scrub({ push: true }, runner)).toBe(1);
    expect(output).toContain('already scrubbed locally');
    expect(output).toContain('--push from a fresh clone');
    expect(calls.filter(isWrite)).toEqual([]);
    expect(tip(work)).toBe(localTip);
    expect(allRefs(remote)).toBe(remoteBefore);
  });

  it('a note that is not valid UTF-8 blocks the rewrite: ref, mapping and output untouched', async () => {
    // A prompt carrier next to a raw invalid byte in an unknown field: a lenient
    // decode would parse it and store U+FFFD in place of the original bytes.
    const body = Buffer.concat([
      Buffer.from(`{"origin":{"version":1,"fullPrompt":"${SENTINEL} prompt"},"unknown":"x`),
      Buffer.from([0xff, 0xc3]),
      Buffer.from('y"}\n'),
    ]);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: body }).toString().trim();
    git(work, 'notes', '--ref=origin', 'add', '-f', '-C', blob, commits[4]);
    const refsBefore = allRefs(work);
    const notesBefore = notesMap(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({}, runner)).toBe(1);
    expect(allRefs(work)).toBe(refsBefore);
    expect(notesMap(work)).toStrictEqual(notesBefore);
    expect(notesMap(work).get(commits[4])).toBe(blob);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(output).toContain(`${commits[4].slice(0, 12)}  unreadable`);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('\uFFFD');
  });

  it('a tree entry that is not a note is reported by its object SHA, never by its path', async () => {
    const secretPath = `${SENTINEL}-not-a-note`;
    const stream = `commit refs/notes/origin\ncommitter T <t@test.invalid> 1800000000 +0000\ndata 5\nextra\n`
      + `from ${tip(work)}\nM 100644 inline ${secretPath}\ndata 3\nabc\n`;
    execFileSync('git', ['fast-import', '--quiet'], { cwd: work, input: stream });
    const blob = git(work, 'rev-parse', `refs/notes/origin:${secretPath}`);
    const refsBefore = allRefs(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({ dryRun: true }, runner)).toBe(1);
    expect(await scrub({}, runner)).toBe(1);
    expect(allRefs(work)).toBe(refsBefore);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(output).toContain(`${blob.slice(0, 12)}  unreadable  non-note tree entry (blob object)`);
    expect(output).not.toContain(SENTINEL);
  });
});

describe('origin scrub-notes is atomic', () => {
  it('a failure while verifying the candidate leaves the live ref and no temporary ref', async () => {
    const refsBefore = allRefs(work);
    let lsTrees = 0;
    const { runner, calls } = makeRunner((args) => {
      // The second ls-tree reads the candidate back.
      if (args[0] === 'ls-tree' && ++lsTrees === 2) return { stdout: '', stderr: 'injected', status: 1 };
    });
    expect(await scrub({}, runner)).toBe(1);
    expect(calls.some((a) => a[0] === 'fast-import')).toBe(true);
    expect(allRefs(work)).toBe(refsBefore);
    expect(output).toContain('refs/notes/origin was not changed');
  });

  it('a concurrent note write between scan and swap is not overwritten', async () => {
    let concurrentTip = '';
    const { runner } = makeRunner((args) => {
      if (args[0] === 'update-ref' && args.includes('refs/notes/origin') && !concurrentTip) {
        putNote(work, commits[4], pretty({ origin: { version: 1, sessionId: 'concurrent' } }));
        concurrentTip = tip(work);
      }
    });
    expect(await scrub({}, runner)).toBe(1);
    expect(tip(work)).toBe(concurrentTip);
    expect(noteJson(work, commits[4]).origin.sessionId).toBe('concurrent');
    expect(output).toContain('changed while the scrub ran');
    expect(git(work, 'for-each-ref', 'refs/origin-scrub')).toBe('');
  });
});

describe('origin scrub-notes --push', () => {
  it('refuses a remote whose notes differ from the local ref, before changing anything', async () => {
    cloneOther();
    putNote(other, commits[4], pretty({ origin: { version: 1, sessionId: 'remote-only' } }));
    git(other, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
    const remoteTip = tip(remote);
    const refsBefore = allRefs(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({ push: true }, runner)).toBe(1);
    expect(allRefs(work)).toBe(refsBefore);
    expect(tip(remote)).toBe(remoteTip);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(output).toContain('is not the local one');
  });

  it('refuses a remote name that is not configured', async () => {
    const { runner, calls } = makeRunner();
    expect(await scrub({ push: true, remote: 'elsewhere' }, runner)).toBe(1);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(output).toContain('not a configured remote');
  });

  it('a remote write after the scan makes the lease refuse the push; the new remote note survives', async () => {
    cloneOther();
    let otherTip = '';
    const { runner } = makeRunner((args) => {
      if (args[0] === 'push' && !otherTip) {
        putNote(other, commits[4], pretty({ origin: { version: 1, sessionId: 'late-writer' } }));
        git(other, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
        otherTip = tip(other);
      }
    });
    expect(await scrub({ push: true }, runner)).toBe(1);
    expect(tip(remote)).toBe(otherTip);
    const remoteNote = JSON.parse(git(remote, 'notes', '--ref=origin', 'show', commits[4]));
    expect(remoteNote.origin.sessionId).toBe('late-writer');
    expect(output).toContain('lease refused the push');
    expect(output).not.toMatch(/git push [^\n]*\+refs\/notes/);
    expect(output).not.toContain(SENTINEL);
  });

  it('replaces only refs/notes/origin, and a fresh clone gets no prompt text but every attribution', async () => {
    const fixtureNotes = notesMap(work);
    const fixtureRecords = new Map([...fixtureNotes.keys()].map((c) => [c, noteJson(work, c).attribution_record]));
    const remoteBefore = allRefs(remote).split('\n');
    const { runner, calls } = makeRunner();

    expect(await scrub({ push: true }, runner)).toBe(0);
    const newTip = tip(work);
    expect(output).toContain(`refs/notes/origin replaced`);

    // The one push: exactly one refspec, leased on the scanned tip.
    const pushes = calls.filter((a) => a[0] === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`${newTip}:refs/notes/origin`);
    expect(pushes[0].filter((a) => a.includes(':'))).toHaveLength(2); // the lease and the refspec
    expect(pushes[0].some((a) => a.startsWith('+'))).toBe(false);
    expect(pushes[0]).not.toContain('--force');

    const remoteAfter = allRefs(remote).split('\n');
    const changed = remoteAfter.filter((l) => !remoteBefore.includes(l));
    expect(changed).toEqual([`refs/notes/origin ${newTip}`]);
    expect(remoteAfter.some((l) => l.startsWith('refs/heads/local-only'))).toBe(false);

    // A fresh clone that explicitly fetches the notes ref.
    const fresh = path.join(root, 'fresh');
    git(root, 'clone', '-q', '--no-local', remote, fresh);
    git(fresh, 'fetch', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
    expect(objectDbContains(fresh, SENTINEL)).toBe(false);
    const freshNotes = notesMap(fresh);
    expect([...freshNotes.keys()].sort()).toEqual([...fixtureNotes.keys()].sort());
    for (const [commit, record] of fixtureRecords) {
      expect(noteJson(fresh, commit).attribution_record).toStrictEqual(record);
    }
    const first = noteJson(fresh, commits[0]).origin;
    expect(first.originUrl).toBe('https://getorigin.io/sessions/sess-49');
    expect(first.promptHash).toBe('v1:0f1e2d3c4b5a');
    expect(first.prompts[0].promptHash).toBe('v1:aa11');
    expect(JSON.parse(first.prompts[0].editsJson).edits).toStrictEqual([{ file: 'src/a.ts', oldContent: 'a', newContent: 'b', lines: [1, 2] }]);
    expect(git(fresh, 'rev-parse', 'origin/main')).toBe(commits[4]);
    expect(output).toContain('Clones, forks, mirrors and backups');
  });
});

const gitVersion = (/(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })) ?? []).slice(1).map(Number);
const hasNoLazyFetch = gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 45);
const REMOTE_CALLS = new Set(['--version', 'remote', 'ls-remote', 'push']);

describe('origin scrub-notes never fetches lazily', () => {
  // A blob:none partial clone of the remote: its note blobs are promisor
  // objects that any plain read would fetch on demand.
  function partialClone(): string {
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    const partial = path.join(root, 'partial');
    git(root, 'clone', '-q', '--no-local', '--filter=blob:none', pathToFileURL(remote).href, partial);
    git(partial, 'fetch', '-q', '--filter=blob:none', 'origin', 'refs/notes/origin:refs/notes/origin');
    return partial;
  }
  const isMissing = (cwd: string, sha: string) => {
    try {
      execFileSync('git', ['cat-file', '-e', sha], { cwd, stdio: 'pipe', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
      return false;
    } catch { return true; }
  };

  it.skipIf(!hasNoLazyFetch)('every local read runs with GIT_NO_LAZY_FETCH, and a missing promisor note blocks instead of fetching', async () => {
    const partial = partialClone();
    const blob = notesMap(partial).get(commits[0])!;
    expect(isMissing(partial, blob)).toBe(true);
    const { runner, calls, envs } = makeRunner(undefined, partial);
    expect(await scrub({ dryRun: true }, runner, partial)).toBe(1);
    expect(output).toContain('unreadable');
    expect(output).toContain('cannot be proven clean');
    expect(isMissing(partial, blob)).toBe(true);
    const local = calls.map((args, i) => ({ args, env: envs[i] })).filter(({ args }) => !REMOTE_CALLS.has(args[0]));
    expect(local.some(({ args }) => args[0] === 'cat-file')).toBe(true);
    for (const { env } of local) expect(env?.GIT_NO_LAZY_FETCH).toBe('1');
  });

  it('git older than 2.45 refuses a partial clone before reading any content', async () => {
    const partial = partialClone();
    const { runner, calls } = makeRunner((args) => {
      if (args[0] === '--version') return { stdout: 'git version 2.40.1\n', stderr: '', status: 0 };
    }, partial);
    const refsBefore = allRefs(partial);
    expect(await scrub({ dryRun: true }, runner, partial)).toBe(1);
    expect(output).toContain('partial clone');
    expect(calls.filter((a) => ['ls-tree', 'cat-file', 'rev-list'].includes(a[0]))).toEqual([]);
    expect(allRefs(partial)).toBe(refsBefore);
  });

  it('git older than 2.45 still audits a full clone', async () => {
    const { runner, envs } = makeRunner((args) => {
      if (args[0] === '--version') return { stdout: 'git version 2.30.2\n', stderr: '', status: 0 };
    });
    expect(await scrub({ dryRun: true }, runner)).toBe(0);
    expect(output).toContain('2 to rewrite');
    expect(envs.some((e) => e && 'GIT_NO_LAZY_FETCH' in e)).toBe(false);
  });
});

describe('origin scrub-notes reads notes in batches', () => {
  it('a ref with hundreds of notes costs a fixed number of git calls', async () => {
    const N = 300;
    // Commits and their notes in one fast-import, onto a fresh notes ref.
    git(work, 'update-ref', '-d', 'refs/notes/origin');
    let stream = '';
    const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
    for (let i = 0; i < N; i++) {
      stream += `commit refs/heads/bulk\nmark :${i + 1}\ncommitter T <t@test.invalid> ${1700000000 + i} +0000\n${data(`bulk ${i}`)}`;
      if (i === 0) stream += `from ${commits[4]}\n`;
      stream += `M 100644 inline bulk.txt\n${data(`line ${i}`)}`;
    }
    stream += `commit refs/notes/origin\ncommitter T <t@test.invalid> 1800000000 +0000\n${data('notes')}`;
    for (let i = 0; i < N; i++) {
      const note = i % 2
        ? { origin: { version: 1, fullPrompt: `${SENTINEL} ${i}`, linesAdded: i } }
        : { origin: { version: 1, promptTextWithheld: true, linesAdded: i } };
      stream += `N inline :${i + 1}\n${data(pretty(note))}`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: work, input: stream });

    // Needs no git-2.32-only `rev-list --filter`: a git without it still works.
    const noFilter = (args: string[]) => (args.some((a) => a.startsWith('--filter'))
      ? { stdout: '', stderr: 'error: invalid filter-spec', status: 129 } : undefined);
    const dry = makeRunner(noFilter);
    expect(await scrub({ dryRun: true }, dry.runner)).toBe(0);
    expect(output).toContain(`notes:     ${N} (${N / 2} already clean, ${N / 2} to rewrite, 0 blocked)`);
    expect(dry.calls.length).toBeLessThan(15);

    const apply = makeRunner(noFilter);
    expect(await scrub({}, apply.runner)).toBe(0);
    expect(apply.calls.length).toBeLessThan(30);
    expect(apply.calls.filter((a) => a[0] === 'cat-file').length).toBeLessThanOrEqual(3);
    expect(apply.calls.some((a) => a[0] === 'notes')).toBe(false);
    expect([...dry.calls, ...apply.calls].some((a) => a.some((x) => x.startsWith('--filter')))).toBe(false);
    expect(notesMap(work).size).toBe(N);
    expect(reachableContains(work, 'refs/notes/origin', SENTINEL)).toBe(false);
  });
});

// ─── Review №5: real-history unblockers ───────────────────────────────────

// Code text that was captured into a truncated editsJson before the prompt:
// it goes with the whole value, so no fresh clone may hold it either.
const DROPPED_CODE = 'OR49_DROPPED_code_9b2d';
const truncatedPromptEdits = (i: number) =>
  `{"promptIndex":${i},"edits":[{"file":"src/t${i}.ts","newContent":"${DROPPED_CODE} ${i}"}],"promptText":"${SENTINEL} cut prompt ${i}` + TRUNCATED;

function truncatedNote(commit: string, i: number) {
  return {
    origin: {
      version: 1,
      sessionId: `sess-t${i}`,
      promptHash: `v1:t${i}`,
      prompts: [{ index: 0, promptHash: `v1:tp${i}`, files: [`src/t${i}.ts`], treeSha: `tree-t${i}`, commitSha: `commit-t${i}`, editsJson: truncatedPromptEdits(i) }],
      originUrl: `https://getorigin.io/sessions/sess-t${i}`,
      linesAdded: i,
    },
    attribution_record: attribution(commit),
    future_top_level: { truncated: i },
  };
}

describe('origin scrub-notes --drop-unprovable-edits', () => {
  // On top of the shared fixture: two notes whose truncated editsJson kept
  // prompt text — commits[4], and commits[2] (which already had a clean note).
  beforeEach(() => {
    putNote(work, commits[4], pretty(truncatedNote(commits[4], 4)));
    putNote(work, commits[2], pretty(truncatedNote(commits[2], 2)));
    git(work, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
  });

  it('default: the same ref is blocked, byte-for-byte unchanged, and the result names the safe next step', async () => {
    const refsBefore = allRefs(work);
    const notesBefore = notesMap(work);
    const remoteBefore = allRefs(remote);
    const { runner, calls } = makeRunner();
    expect(await scrub({ dryRun: true }, runner)).toBe(1);
    expect(output).toContain('notes:     5 (1 already clean, 2 to rewrite, 2 blocked)');
    expect(output).toContain(`${commits[4].slice(0, 12)}  edits_json_truncated  origin.prompts[].editsJson`);
    expect(output).toContain('run origin scrub-notes --dry-run --drop-unprovable-edits');
    expect(output).toContain('"editsJson dropped" count');
    expect(output).not.toContain('editsJson dropped:');
    expect(await scrub({}, runner)).toBe(1);
    expect(await scrub({ push: true }, runner)).toBe(1);
    expect(allRefs(work)).toBe(refsBefore);
    expect(notesMap(work)).toStrictEqual(notesBefore);
    expect(allRefs(remote)).toBe(remoteBefore);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(DROPPED_CODE);
  });

  it('dry run with the option: the dropped count, zero writes, nothing printed', async () => {
    const refsBefore = allRefs(work);
    const { runner, calls } = makeRunner();
    expect(await scrub({ dryRun: true, dropUnprovableEdits: true }, runner)).toBe(0);
    expect(output).toContain('notes:     5 (1 already clean, 4 to rewrite, 0 blocked)');
    expect(output).toContain('editsJson dropped: 2 (truncated payloads containing prompt text)');
    // The drop is not counted as an in-place promptText removal.
    expect(output).toContain('origin.prompts[].editsJson.promptText ×1');
    expect(output).toContain('deleting 2 whole editsJson values');
    expect(allRefs(work)).toBe(refsBefore);
    expect(calls.filter(isWrite)).toEqual([]);
    expect(calls.some((a) => a[0] === 'ls-remote')).toBe(false);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(DROPPED_CODE);
  });

  it('apply with the option: same mapping, same blobs for clean notes, nothing dropped reachable', async () => {
    const notesBefore = notesMap(work);
    const before = new Map([...notesBefore.keys()].map((c) => [c, noteJson(work, c)]));
    const oldTip = tip(work);
    expect(await scrub({ dropUnprovableEdits: true })).toBe(0);
    const newTip = tip(work);
    expect(newTip).not.toBe(oldTip);
    expect(output).toContain('editsJson dropped: 2 (truncated payloads containing prompt text)');
    expect(output).not.toContain(SENTINEL);

    const notesAfter = notesMap(work);
    expect([...notesAfter.keys()].sort()).toEqual([...notesBefore.keys()].sort());
    expect(notesAfter.get(commits[3])).toBe(notesBefore.get(commits[3]));
    expect(git(work, 'rev-list', '--count', 'refs/notes/origin')).toBe('1');
    expect(reachableContains(work, 'refs/notes/origin', SENTINEL)).toBe(false);
    expect(reachableContains(work, 'refs/notes/origin', DROPPED_CODE)).toBe(false);
    expect(git(work, 'log', '-1', '--format=%B', newTip)).toContain('Dropped 2 truncated editsJson values');

    for (const i of [2, 4]) {
      const src = before.get(commits[i]);
      const after = noteJson(work, commits[i]);
      expect(after.attribution_record).toStrictEqual(src.attribution_record);
      expect(after.future_top_level).toStrictEqual(src.future_top_level);
      const { prompts, ...originRest } = src.origin;
      const { prompts: afterPrompts, promptTextWithheld, ...afterRest } = after.origin;
      expect(afterRest).toStrictEqual(originRest);
      expect(promptTextWithheld).toBe(true);
      const { editsJson, ...siblings } = prompts[0];
      expect(afterPrompts).toStrictEqual([siblings]);
    }
    // The ordinary scrub still ran alongside it.
    expect(JSON.parse(noteJson(work, commits[0]).origin.prompts[0].editsJson).edits).toHaveLength(1);
    expect(git(work, 'for-each-ref', 'refs/origin-scrub')).toBe('');
    expect(tip(remote)).toBe(oldTip);
  });

  it('repeated dry runs and applies are idempotent, with or without the option', async () => {
    const { runner: r1 } = makeRunner();
    expect(await scrub({ dryRun: true, dropUnprovableEdits: true }, r1)).toBe(0);
    const first = output;
    output = '';
    expect(await scrub({ dryRun: true, dropUnprovableEdits: true }, r1)).toBe(0);
    expect(output).toBe(first);

    expect(await scrub({ dropUnprovableEdits: true })).toBe(0);
    const once = tip(work);
    for (const opts of [{ dropUnprovableEdits: true }, {}, { dryRun: true, dropUnprovableEdits: true }, { dryRun: true }]) {
      output = '';
      const { runner, calls } = makeRunner();
      expect(await scrub(opts, runner)).toBe(0);
      expect(output).toContain('already clean; nothing to do');
      expect(output).toContain('0 to rewrite, 0 blocked');
      expect(calls.filter(isWrite)).toEqual([]);
      expect(tip(work)).toBe(once);
    }
    expect(output).not.toContain('editsJson dropped:');
  });

  it('--push with the option: a fresh clone gets every attribution and none of the dropped text', async () => {
    const fixtureNotes = notesMap(work);
    const fixtureRecords = new Map([...fixtureNotes.keys()].map((c) => [c, noteJson(work, c).attribution_record]));
    const { runner, calls } = makeRunner();
    expect(await scrub({ push: true, dropUnprovableEdits: true }, runner)).toBe(0);
    const newTip = tip(work);
    expect(calls.filter((a) => a[0] === 'push')).toHaveLength(1);
    expect(tip(remote)).toBe(newTip);
    expect(output).toContain('editsJson dropped: 2');

    const fresh = path.join(root, 'fresh');
    git(root, 'clone', '-q', '--no-local', remote, fresh);
    git(fresh, 'fetch', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
    expect(objectDbContains(fresh, SENTINEL)).toBe(false);
    expect(objectDbContains(fresh, DROPPED_CODE)).toBe(false);
    const freshNotes = notesMap(fresh);
    expect([...freshNotes.keys()].sort()).toEqual([...fixtureNotes.keys()].sort());
    for (const [commit, record] of fixtureRecords) {
      expect(noteJson(fresh, commit).attribution_record).toStrictEqual(record);
    }
    const t4 = noteJson(fresh, commits[4]).origin;
    expect(t4.prompts).toStrictEqual([{ index: 0, promptHash: 'v1:tp4', files: ['src/t4.ts'], treeSha: 'tree-t4', commitSha: 'commit-t4' }]);
    expect(t4.originUrl).toBe('https://getorigin.io/sessions/sess-t4');

    // The verification clone audits clean.
    output = '';
    expect(await scrub({ dryRun: true }, makeRunner(undefined, fresh).runner, fresh)).toBe(0);
    expect(output).toContain('0 to rewrite, 0 blocked');
    expect(output).toContain('0 earlier note versions not provably clean');
  });
});

describe('origin scrub-notes leaves notes without an `origin` key alone', () => {
  const record = (commit: string) => ({ schema_version: 1, revision: commit, agent_id: 'claude', session_id: 'sess-no-origin' });
  // The exact bytes each writer stores: not reformatted by the scrub.
  const bodies = (c: string[]) => new Map<string, string>([
    // record-only note (corpus fixture #2048)
    [c[0], JSON.stringify({ attribution_record: record(c[0]) }, null, 2)],
    // rewrite note (#1967)
    [c[1], JSON.stringify({ attribution_record: record(c[1]), origin_rewrite: { schema: 'origin-rewrite/1', target: c[1], sources: [c[2]], base: 'none' } }, null, 2)],
    // bare backfill object, as `git notes add -m` stores it
    [c[2], JSON.stringify({ sessionId: `backfill-${c[2].slice(0, 8)}`, agent: 'claude', agentName: 'claude', model: 'unknown', confidence: 'high', source: 'backfill-coauthor' }) + '\n'],
  ]);

  it('a dry run reports them clean, and a rewrite keeps their blob SHAs', async () => {
    const known = bodies(commits);
    for (const [commit, body] of known) putNote(work, commit, body);
    const notesBefore = notesMap(work);

    const { runner, calls } = makeRunner();
    expect(await scrub({ dryRun: true }, runner)).toBe(0);
    expect(output).toContain('notes:     4 (4 already clean, 0 to rewrite, 0 blocked)');
    expect(output).toContain('would rewrite 0 notes and the ref history');
    expect(calls.filter(isWrite)).toEqual([]);

    // commits[3] still carries an old prompt-bearing version in its history,
    // so the ref is rewritten; the three no-origin notes keep their blobs.
    expect(await scrub({})).toBe(0);
    const notesAfter = notesMap(work);
    for (const commit of known.keys()) {
      expect(notesAfter.get(commit)).toBe(notesBefore.get(commit));
      expect(git(work, 'cat-file', 'blob', notesAfter.get(commit)!)).toBe(known.get(commit)!.trimEnd());
    }
    expect(reachableContains(work, 'refs/notes/origin', SENTINEL)).toBe(false);

    output = '';
    expect(await scrub({ dryRun: true })).toBe(0);
    expect(output).toContain('0 to rewrite, 0 blocked');
    expect(output).toContain('already clean; nothing to do');
  });
});
