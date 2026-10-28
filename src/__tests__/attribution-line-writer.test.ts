/**
 * OR-45 checkpoint 2: the canonical v1 record carries proven commit-coordinate
 * line claims, written through the shared note lifecycle.
 *
 *   - the builder emits `attribution_level: "line"` + `contributions[].files`
 *     only for non-empty claims that pass full validation, and the old
 *     commit-level record byte for byte otherwise;
 *   - `lineClaimsForCommits` is the one preparation path (post-commit's live
 *     ledger, Stop/SessionEnd's edit map) for Claude Code and Codex;
 *   - a later write of the same session that lacks the claims never
 *     downgrades a stored line record, and a later write that has them
 *     upgrades a commit-level one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const importGitNote = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../api.js', () => ({ api: { importGitNote } }));

const { writeGitNotes } = await import('../git-notes.js');
const {
  buildAttributionRecordForCommit,
  buildInferredAttributionRecord,
  noteIsLineUpgradeCandidate,
  preserveProvenLineClaims,
  publishableLineFiles,
  LINE_FILES_MAX_BYTES,
  ATTRIBUTION_RECORD_NOTE_KEY,
} = await import('../attribution-note.js');
const { planStopNoteWrites, editCapturesFromEditsJson, editCapturesFromLiveLedger, lineClaimsForCommits } = await import('../attribution-line-claims.js');
const { validateFull } = await import('../attribution-record.js');
const { EDITS_TRUNCATED_MARKER } = await import('../note-scrub.js');

const SESSION = 'sess-0f3c2a';
const OPTS = { recordedAt: new Date('2026-10-16T12:00:00Z'), producerVersion: '0.0.0-test' };
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
const write = (rel: string, content: string) => fs.writeFileSync(path.join(repo, rel), content);
const commit = (msg: string): string => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const readNote = (sha: string): any => JSON.parse(git('notes', '--ref=origin', 'show', sha));

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-line-writer-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', rows(1, 10));
  commit('base');
});
afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  importGitNote.mockClear();
});

const shaOf = (c: string) => c.repeat(40);
type Decisions = ReturnType<typeof lineClaimsForCommits>;
const proven = (files: unknown) => ({ status: 'proven' as const, files: files as any });
/** The proven files of each decision; degraded and not-evaluated commits drop out. */
const provenOf = (decisions: Decisions) => Object.fromEntries(
  Object.entries(decisions).flatMap(([sha, d]) => (d.status === 'proven' ? [[sha, d.files]] : [])));
// A roomy budget: these tests pin what is proven, not how fast (the budget has its own tests).
const decide = (...[repoPath, agent, state, shas, caps]: Parameters<typeof lineClaimsForCommits>) =>
  lineClaimsForCommits(repoPath, agent, state, shas, caps, { budgetMs: 60_000 });
const provenClaims = (...args: Parameters<typeof lineClaimsForCommits>) => provenOf(decide(...args));
const source = (over: Record<string, unknown> = {}) => ({ sessionId: SESSION, agentId: 'claude-code', ...over });

describe('buildAttributionRecordForCommit with line claims', () => {
  const sha = shaOf('a');

  it('emits a line-level record for non-empty claims, with the iteration it names', () => {
    const built = buildAttributionRecordForCommit(sha, source({
      iterationIndexBySha: { [sha]: 2 },
      lineClaims: { [sha]: proven([{ path: 'src/a.ts', ranges: [{ start_line: 4, end_line: 6, iteration_index: 2 }] }]) },
    }), OPTS);
    expect(built.record?.attribution_level).toBe('line');
    expect(built.record?.schema_version).toBe('1.0');
    expect(built.record?.contributions[0].files).toEqual([
      { path: 'src/a.ts', ranges: [{ start_line: 4, end_line: 6, iteration_index: 2 }] },
    ]);
    expect(validateFull(built.record).ok).toBe(true);
  });

  it('keeps the commit-level record unchanged when there are no claims', () => {
    const plain = buildAttributionRecordForCommit(sha, source(), OPTS);
    expect(buildAttributionRecordForCommit(sha, source({ lineClaims: {} }), OPTS)).toEqual(plain);
    expect(buildAttributionRecordForCommit(sha, source({ lineClaims: { [sha]: proven([]) } }), OPTS)).toEqual(plain);
    expect(buildAttributionRecordForCommit(sha, source({ lineClaims: { [shaOf('b')]: proven([{ path: 'x', ranges: [{ start_line: 1, end_line: 1 }] }]) } }), OPTS))
      .toEqual(plain);
    expect(plain.record?.attribution_level).toBe('commit');
    expect(plain.record?.contributions[0]).not.toHaveProperty('files');
  });

  it('drops an iteration_index the contribution does not name, instead of guessing one', () => {
    const built = buildAttributionRecordForCommit(sha, source({
      iterationIndexBySha: { [sha]: 2 },
      lineClaims: { [sha]: proven([{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: 5 }, { start_line: 3, end_line: 3 }] }]) },
    }), OPTS);
    expect(built.record?.contributions[0].files[0].ranges).toEqual([{ start_line: 1, end_line: 1 }, { start_line: 3, end_line: 3 }]);
    // No attested iteration at all: no range may name one.
    const none = buildAttributionRecordForCommit(sha, source({
      lineClaims: { [sha]: proven([{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: 0 }] }]) },
    }), OPTS);
    expect(none.record?.contributions[0].files[0].ranges).toEqual([{ start_line: 1, end_line: 1 }]);
    expect(validateFull(none.record).ok).toBe(true);
  });

  it('writes the honest commit-level record when the claims do not validate', () => {
    const plain = buildAttributionRecordForCommit(sha, source(), OPTS);
    const bad = buildAttributionRecordForCommit(sha, source({
      lineClaims: { [sha]: proven([{ path: '../escape.ts', ranges: [{ start_line: 1, end_line: 2 }] }]) },
    }), OPTS);
    expect(bad).toEqual(plain);
    const malformed = buildAttributionRecordForCommit(sha, source({
      lineClaims: { [sha]: proven([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 1 }, { start_line: 0, end_line: 1 }] }] as any) },
    }), OPTS);
    expect(malformed).toEqual(plain);
  });

  it('fails closed on a mixed set: one bad entry voids every claim of the commit', () => {
    const plain = buildAttributionRecordForCommit(sha, source({ iterationIndexBySha: { [sha]: 0 } }), OPTS);
    const good = { path: 'a.ts', ranges: [{ start_line: 1, end_line: 2, iteration_index: 0 }] };
    const mixed: unknown[][] = [
      [good, { path: 'b.ts', ranges: [{ start_line: 5, end_line: 3 }] }],                     // reversed range
      [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 2 }, { start_line: 0, end_line: 1 }] }], // zero line
      [good, { path: 'b.ts', ranges: [{ start_line: 1.5, end_line: 2 }] }],                    // not an integer
      [good, { path: 'b.ts', ranges: [] }],                                                    // empty file entry
      [good, { path: 'a.ts', ranges: [{ start_line: 9, end_line: 9 }] }],                      // path listed twice
      [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 4 }, { start_line: 3, end_line: 6 }] }], // overlap
      [good, { path: 'b.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: -1 }] }], // bad iteration
      [good, { path: 'b.ts', ranges: [{ start_line: 1, end_line: 1, extra: 1 }] }],            // unknown key
      [good, { path: 'b.ts', ranges: [{ start_line: 1, end_line: 1 }], hint: 'x' }],           // unknown key
      [good, { path: '../escape.ts', ranges: [{ start_line: 1, end_line: 1 }] }],              // unsafe path
      [good, null],
    ];
    for (const claims of mixed) {
      const built = buildAttributionRecordForCommit(sha, source({ iterationIndexBySha: { [sha]: 0 }, lineClaims: { [sha]: proven(claims as any) } }), OPTS);
      expect(built, JSON.stringify(claims)).toEqual(plain);
    }
    // The same valid entry alone still makes a line record.
    expect(buildAttributionRecordForCommit(sha, source({ iterationIndexBySha: { [sha]: 0 }, lineClaims: { [sha]: proven([good]) } }), OPTS)
      .record?.attribution_level).toBe('line');
  });

  it('leaves the inferred writer commit-level', () => {
    const inferred = buildInferredAttributionRecord(sha, 'codex', OPTS);
    expect(inferred.record?.attribution_level).toBe('commit');
    expect(inferred.record?.contributions[0]).toEqual({ evidence: 'inferred', agent: { id: 'codex' } });
  });
});

describe('lineClaimsForCommits — the shared preparation path', () => {
  const AGENT = 'claude-code';
  const edit = (file: string, oldContent: string, newContent: string, extra: Record<string, unknown> = {}) =>
    ({ file, op: 'edit' as const, oldContent, newContent, source: 'tool_call' as const, ...extra });
  const attested = (sha: string, turnId: string, at: string, via: 'post-commit' | 'trailer' | 'transcript' = 'post-commit') =>
    ({ sha, turnId, at, via });

  it('Claude Code: projects the live ledger of the attested turn, with its iteration', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('claude edit');
    const state = {
      promptTurnIds: ['t0', 't1'],
      commitTurns: [attested(sha, 't1', '2026-10-16T10:00:00Z')],
      liveEdits: [
        { promptIndex: 1, toolName: 'Edit', capturedAt: '2026-10-16T09:59:00Z', edits: [{ ...edit('a.ts', 'Row 4', 'Row four'), evidence: 'tool_call' as const }] },
        // A sub-agent's worktree: relative to another tree, never replayed here.
        { promptIndex: 1, toolName: 'Edit', capturedAt: '2026-10-16T09:59:30Z', tree: '/elsewhere', edits: [edit('a.ts', 'Row 9', 'Row nine')] },
      ],
    };
    const claims = provenClaims(repo, AGENT, state as any, [sha.slice(0, 10)], editCapturesFromLiveLedger(state as any));
    expect(claims).toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 1 }] }] });
  });

  it('Codex: projects the commit patch of an attested commit from the Stop edit map', () => {
    const next = rows(1, 10).replace('Row 7\n', 'Row seven\n');
    write('a.ts', next);
    const sha = commit('codex shell commit');
    const map = new Map([[0, JSON.stringify({
      promptIndex: 0, agent: 'codex', commits: [sha],
      edits: [{ file: 'a.ts', op: 'edit', oldContent: rows(1, 10), newContent: next, source: 'commit', commitSha: sha }],
    })]]);
    const state = { promptTurnIds: ['t0'], commitTurns: [attested(sha, 't0', '2026-10-16T10:00:00Z')] };
    expect(provenClaims(repo, 'codex', state as any, [sha], editCapturesFromEditsJson(map)))
      .toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 7, end_line: 7, iteration_index: 0 }] }] });
    // Seen only in the transcript: not a binding that opens line claims.
    const seenOnly = { promptTurnIds: ['t0'], commitTurns: [attested(sha, 't0', '2026-10-16T10:00:00Z', 'transcript')] };
    expect(provenClaims(repo, 'codex', seenOnly as any, [sha], editCapturesFromEditsJson(map))).toEqual({});
  });

  it('gives each commit only the turns since the session\'s previous commit', () => {
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const first = commit('turn 0');
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 8\n', 'Row eight\n'));
    const second = commit('turn 1');
    const state = {
      promptTurnIds: ['t0', 't1'],
      commitTurns: [attested(first, 't0', '2026-10-16T10:00:00Z'), attested(second, 't1', '2026-10-16T10:05:00Z')],
      liveEdits: [
        { promptIndex: 0, toolName: 'Edit', capturedAt: 'x', edits: [edit('a.ts', 'Row 2', 'Row two')] },
        { promptIndex: 1, toolName: 'Edit', capturedAt: 'y', edits: [edit('a.ts', 'Row 8', 'Row eight')] },
      ],
    };
    const claims = provenClaims(repo, AGENT, state as any, [first, second], editCapturesFromLiveLedger(state as any));
    expect(claims[first]).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
    expect(claims[second]).toEqual([{ path: 'a.ts', ranges: [{ start_line: 8, end_line: 8, iteration_index: 1 }] }]);
  });

  it('opens line claims only for Claude Code, Codex, (edit-hook only) Cursor and (proven tool call only) Gemini and Copilot', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    const map = new Map([[0, JSON.stringify({ edits: [edit('a.ts', 'Row 4', 'Row four')] })]]);
    const state = { promptTurnIds: ['t0'], commitTurns: [attested(sha, 't0', '2026-10-16T10:00:00Z')] };
    const caps = editCapturesFromEditsJson(map);
    for (const agent of ['claude-code', 'codex', 'Claude-Code']) {
      expect(provenClaims(repo, agent, state as any, [sha], caps)).toHaveProperty(sha);
    }
    // An unstamped edit proves no success for Cursor, Gemini or Copilot; the
    // rest are not enabled.
    for (const agent of ['cursor', 'gemini', 'copilot', 'antigravity', 'constructor', undefined]) {
      expect(provenClaims(repo, agent, state as any, [sha], caps)).toEqual({});
    }
  });

  it('ends the window at the post-commit turn whatever weaker sighting comes later, in either order', () => {
    // Turn 0 wrote Row two and committed; turn 1 rewrote the same line after
    // the commit. A late transcript sighting of the sha under turn 1 must not
    // pull turn 1's edit into the replay — that would cost turn 0 its line.
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const sha = commit('turn 0');
    const caps = editCapturesFromLiveLedger({ liveEdits: [
      { promptIndex: 0, toolName: 'Edit', capturedAt: 'x', edits: [edit('a.ts', 'Row 2', 'Row two')] },
      { promptIndex: 1, toolName: 'Edit', capturedAt: 'y', edits: [edit('a.ts', 'Row two', 'Row TWO')] },
    ] } as any);
    const strong = attested(sha, 't0', '2026-10-16T10:00:00Z', 'post-commit');
    const weakLater = attested(sha, 't1', '2026-10-16T10:09:00Z', 'transcript');
    const expected = { [sha]: [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }] };
    for (const commitTurns of [[strong, weakLater], [weakLater, strong]]) {
      expect(provenClaims(repo, AGENT, { promptTurnIds: ['t0', 't1'], commitTurns } as any, [sha], caps)).toEqual(expected);
    }
  });

  it('orders commits by their strongest sighting\'s time, not an earlier weaker one, in either order', () => {
    // B's transcript sighting predates A's commit. Taken as B's time, it put B
    // before A, so B's window lost its lower bound and replayed turn 0's edit
    // (already in B's parent): B lost its line.
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const a = commit('turn 0');
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 8\n', 'Row eight\n'));
    const b = commit('turn 1');
    const caps = editCapturesFromLiveLedger({ liveEdits: [
      { promptIndex: 0, toolName: 'Edit', capturedAt: 'x', edits: [edit('a.ts', 'Row 2', 'Row two')] },
      { promptIndex: 1, toolName: 'Edit', capturedAt: 'y', edits: [edit('a.ts', 'Row 8', 'Row eight')] },
    ] } as any);
    const sightings = [
      attested(a, 't0', '2026-10-16T10:00:00Z'),
      attested(b, 't1', '2026-10-16T10:05:00Z'),
      attested(b, 't1', '2026-10-16T09:00:00Z', 'transcript'),
    ];
    const expected = {
      [a]: [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }],
      [b]: [{ path: 'a.ts', ranges: [{ start_line: 8, end_line: 8, iteration_index: 1 }] }],
    };
    for (const commitTurns of [sightings, [...sightings].reverse()]) {
      expect(provenClaims(repo, AGENT, { promptTurnIds: ['t0', 't1'], commitTurns } as any, [a, b], caps)).toEqual(expected);
    }
  });

  it('binds no turn when the strongest sightings disagree', () => {
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const sha = commit('turn 0');
    const caps = editCapturesFromLiveLedger({ liveEdits: [
      { promptIndex: 0, toolName: 'Edit', capturedAt: 'x', edits: [edit('a.ts', 'Row 2', 'Row two')] },
    ] } as any);
    const twoTurns = { promptTurnIds: ['t0', 't1'], commitTurns: [
      attested(sha, 't1', '2026-10-16T10:01:00Z'), attested(sha, 't0', '2026-10-16T10:00:00Z'),
    ] };
    expect(provenClaims(repo, AGENT, twoTurns as any, [sha], caps)).toEqual({});
    const unnumbered = { promptTurnIds: ['t0'], commitTurns: [attested(sha, 't0', '2026-10-16T10:00:00Z'), attested(sha, 't-gone', '2026-10-16T10:00:01Z')] };
    expect(provenClaims(repo, AGENT, unnumbered as any, [sha], caps)).toEqual({});
  });

  it('claims nothing without an attested turn, or with a truncated capture', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    const map = new Map([[0, JSON.stringify({ edits: [edit('a.ts', 'Row 4', 'Row four')] })]]);
    expect(provenClaims(repo, AGENT, { promptTurnIds: ['t0'], commitTurns: [] } as any, [sha], editCapturesFromEditsJson(map))).toEqual({});
    const state = { promptTurnIds: ['t0'], commitTurns: [attested(sha, 't0', '2026-10-16T10:00:00Z')] };
    expect(provenClaims(repo, AGENT, state as any, [sha], editCapturesFromEditsJson(map))).toHaveProperty(sha);
    const cut = new Map([[0, '{"edits":[' + EDITS_TRUNCATED_MARKER]]);
    expect(provenClaims(repo, AGENT, state as any, [sha], editCapturesFromEditsJson(cut))).toEqual({});
  });
});

describe('Cursor (OR-45 checkpoint 3A): only afterFileEdit content with an attested binding', () => {
  // What afterFileEdit leaves in the ledger: one whole-file write per file and
  // turn, from the turn's baseline to the bytes on disk after Cursor wrote them.
  const hookWrite = (file: string, oldContent: string | undefined, newContent: string | undefined) =>
    ({ file, op: oldContent === undefined ? 'create' : 'write', oldContent, newContent, source: 'uncommitted', evidence: 'edit_hook' });
  const ledger = (promptIndex: number, edits: unknown[]) =>
    editCapturesFromLiveLedger({ liveEdits: [{ promptIndex, toolName: 'cursor-edit-hook', capturedAt: 'x', edits }] } as any);
  const sighting = (sha: string, via: string) => ({ promptTurnIds: ['t0'], commitTurns: [{ sha, turnId: 't0', at: '2026-10-16T10:00:00Z', via }] });
  let sha: string;
  let next: string;
  beforeEach(() => {
    next = rows(1, 10).replace('Row 4\n', 'Row four\n').replace('Row 5\n', 'Row 5\nRow 5b\n');
    write('a.ts', next);
    sha = commit('cursor edit');
  });

  it('projects an edit-hook write of a post-commit or trailer attested commit, only its changed lines', () => {
    const caps = ledger(0, [hookWrite('a.ts', rows(1, 10), next)]);
    const expected = { [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }, { start_line: 6, end_line: 6, iteration_index: 0 }] }] };
    expect(provenClaims(repo, 'cursor', sighting(sha, 'post-commit') as any, [sha], caps)).toEqual(expected);
    // A trailer names the session but is not post-commit: the lines stand, the prompt does not.
    expect(provenClaims(repo, 'cursor', sighting(sha, 'trailer') as any, [sha], caps))
      .toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }, { start_line: 6, end_line: 6 }] }] });
  });

  it('claims the edit-hook line, never the line a human typed after the hook, in one commit', () => {
    // Turn baseline = the parent. Cursor changes Row 2 (the hook reads that
    // back); the human then edits Row 9 and commits both.
    const agentState = next.replace('Row 2\n', 'Row two\n');
    write('a.ts', agentState.replace('Row 9\n', 'typed by hand\n'));
    const both = commit('cursor edit + human');
    const caps = ledger(0, [hookWrite('a.ts', next, agentState)]);
    expect(provenClaims(repo, 'cursor', sighting(both, 'post-commit') as any, [both], caps))
      .toEqual({ [both]: [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }] });
  });

  it('stays commit-level on the transcript-only binding Cursor usually has', () => {
    const caps = ledger(0, [hookWrite('a.ts', rows(1, 10), next)]);
    expect(provenClaims(repo, 'cursor', sighting(sha, 'transcript') as any, [sha], caps)).toEqual({});
  });

  it('stays commit-level for a path-only edit-hook record (content declined for size)', () => {
    const caps = ledger(0, [hookWrite('a.ts', undefined, undefined)]);
    expect(provenClaims(repo, 'cursor', sighting(sha, 'post-commit') as any, [sha], caps)).toEqual({});
  });

  it('stays commit-level for a write Origin back-filled from the commit blob', () => {
    const backfilled = { file: 'a.ts', op: 'write', oldContent: rows(1, 10), newContent: next, source: 'tool_call', backfillSource: 'commit-blob' };
    const caps = editCapturesFromEditsJson(new Map([[0, JSON.stringify({ edits: [backfilled, { ...backfilled, evidence: 'edit_hook' }] })]]));
    expect(provenClaims(repo, 'cursor', sighting(sha, 'post-commit') as any, [sha], caps)).toEqual({});
  });

  it('stays commit-level for transcript edits, whose success the Cursor transcript cannot show', async () => {
    // The real Cursor extractor over the real transcript shape: a StrReplace
    // with no id and no tool_result. A rejected one would read the same.
    const { capturePromptEdits } = await import('../prompt-capture/index.js');
    const transcript = path.join(repo, '..', `${path.basename(repo)}-cursor.jsonl`);
    const user = (t: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${t}\n</user_query>` }] } });
    const assistant = (blocks: unknown[]) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
    fs.writeFileSync(transcript, [
      user('rename row 4'),
      assistant([{ type: 'tool_use', name: 'StrReplace', input: { path: path.join(repo, 'a.ts'), old_string: 'Row 4\n', new_string: 'Row four\n' } }]),
    ].join('\n') + '\n');
    try {
      const caps = capturePromptEdits({ agent: 'cursor', repoPath: repo, transcriptPath: transcript, sessionCommitShas: [sha] });
      const edits = caps.flatMap((c) => c.edits).filter((e) => e.file === 'a.ts' && typeof e.newContent === 'string');
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every((e) => e.evidence === undefined)).toBe(true);
      const byIndex = new Map(caps.map((c) => [c.promptIndex, JSON.stringify(c)] as [number, string]));
      expect(provenClaims(repo, 'cursor', sighting(sha, 'post-commit') as any, [sha], editCapturesFromEditsJson(byIndex))).toEqual({});
    } finally {
      fs.rmSync(transcript, { force: true });
    }
  });

  it('stays commit-level for ambiguous shell evidence without a sole-session proof', () => {
    const probe = { ...hookWrite('a.ts', rows(1, 10), next), evidence: 'command_probe' };
    expect(provenClaims(repo, 'cursor', sighting(sha, 'post-commit') as any, [sha], ledger(0, [probe]))).toEqual({});
  });
});

describe('Gemini (OR-45 checkpoint 3B, G3): only a tool call proven to have succeeded', () => {
  // The chats JSONL Gemini CLI writes (fixtures/gemini-jsonl-2-prompts.jsonl):
  // each call carries its CoreToolCallStatus and its functionResponse.
  const sighting = (sha: string, via: string) => ({ promptTurnIds: ['t0'], commitTurns: [{ sha, turnId: 't0', at: '2026-10-16T10:00:00Z', via }] });
  const call = (id: string, name: string, args: Record<string, unknown>, status: string | undefined, response: Record<string, unknown> = { output: 'ok' }) => ({
    id, name, args, result: [{ functionResponse: { id, name, response } }], ...(status !== undefined && { status }), timestamp: '2026-10-16T09:59:00Z',
  });
  const replaceRow4 = (id: string, status: string | undefined, response?: Record<string, unknown>) =>
    call(id, 'replace', { file_path: path.join(repo, 'a.ts'), old_string: 'Row 4\n', new_string: 'Row four\n', instruction: 'rename' }, status, response);
  let sha: string;
  let transcript: string;
  beforeEach(() => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    sha = commit('gemini edit');
    transcript = path.join(repo, '..', `${path.basename(repo)}-gemini.jsonl`);
  });
  afterEach(() => { fs.rmSync(transcript, { force: true }); });

  const captureOf = async (toolCalls: unknown[]) => {
    const { capturePromptEdits } = await import('../prompt-capture/index.js');
    fs.writeFileSync(transcript, [
      { sessionId: 'gem-3b', projectHash: 'h', startTime: '2026-10-16T09:58:00Z', lastUpdated: '2026-10-16T09:58:00Z', kind: 'main' },
      { id: 'u1', timestamp: '2026-10-16T09:58:30Z', type: 'user', content: [{ text: 'rename row 4' }] },
      { id: 'g1', timestamp: '2026-10-16T09:59:00Z', type: 'gemini', content: '', thoughts: [], model: 'gemini-2.5-pro', toolCalls },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const caps = capturePromptEdits({ agent: 'gemini', repoPath: repo, transcriptPath: transcript, sessionCommitShas: [sha] });
    return editCapturesFromEditsJson(new Map(caps.map((c) => [c.promptIndex, JSON.stringify(c)] as [number, string])));
  };
  const claims = (caps: any, via = 'post-commit') => provenClaims(repo, 'gemini', sighting(sha, via) as any, [sha], caps);

  it('projects a successful replace of a post-commit or trailer attested commit', async () => {
    const caps = await captureOf([replaceRow4('replace_1', 'success')]);
    expect(caps[0].edits.map((e) => e.evidence)).toEqual(['tool_call']);
    expect(claims(caps)).toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }] });
    expect(claims(caps, 'trailer')).toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }] }] });
  });

  it('stays commit-level when the replace failed or was cancelled — even if the line did land', async () => {
    // The human made the change the failed call describes: the commit carries
    // it, the replay would match, and the line is still not the agent's.
    for (const status of ['error', 'cancelled']) {
      const caps = await captureOf([replaceRow4('replace_1', status, { error: 'Failed to edit, could not find the string to replace.' })]);
      // Only the commit's own supplement remains, which proves nothing for Gemini.
      expect(caps.flatMap((c) => c.edits).filter((e) => e.source === 'tool_call'), status).toEqual([]);
      expect(claims(caps), status).toEqual({});
    }
  });

  it('stays commit-level when the status is missing or not final', async () => {
    for (const status of [undefined, 'executing', 'awaiting_approval', 'SUCCESS']) {
      const caps = await captureOf([replaceRow4('replace_1', status)]);
      // Kept for the turn's file list, but proves nothing.
      expect(caps[0].edits.map((e) => [e.file, e.evidence]), String(status)).toEqual([['a.ts', undefined]]);
      expect(claims(caps), String(status)).toEqual({});
    }
  });

  it('takes a re-appended call\'s last status, and replays it once', async () => {
    const caps = await captureOf([replaceRow4('replace_1', 'executing'), replaceRow4('replace_1', 'success')]);
    expect(caps[0].edits.map((e) => e.evidence)).toEqual(['tool_call', undefined]);
    expect(claims(caps)).toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }] });
    const failedLater = await captureOf([replaceRow4('replace_1', 'executing'), replaceRow4('replace_1', 'error')]);
    expect(failedLater.flatMap((c) => c.edits).filter((e) => e.source === 'tool_call')).toEqual([]);
    expect(claims(failedLater)).toEqual({});
  });

  it('stays commit-level on a transcript-only binding', async () => {
    const caps = await captureOf([replaceRow4('replace_1', 'success')]);
    expect(claims(caps, 'transcript')).toEqual({});
  });

  it('stays commit-level for path-only or back-filled content, even stamped as a tool call', () => {
    const pathOnly = { file: 'a.ts', op: 'write', source: 'tool_call', evidence: 'tool_call' };
    const backfilled = { file: 'a.ts', op: 'write', oldContent: rows(1, 10), newContent: rows(1, 10).replace('Row 4\n', 'Row four\n'), source: 'tool_call', evidence: 'tool_call', backfillSource: 'commit-blob' };
    for (const e of [pathOnly, backfilled]) {
      const caps = editCapturesFromEditsJson(new Map([[0, JSON.stringify({ edits: [e] })]]));
      expect(claims(caps), JSON.stringify(e)).toEqual({});
    }
  });

  it('stays commit-level for shell-probe evidence: G3 closes tool calls only', () => {
    const probe = { file: 'a.ts', op: 'write', oldContent: rows(1, 10), newContent: rows(1, 10).replace('Row 4\n', 'Row four\n'), source: 'uncommitted', evidence: 'command_named' };
    expect(claims(editCapturesFromEditsJson(new Map([[0, JSON.stringify({ edits: [probe] })]])))).toEqual({});
  });

  it('post-commit live ledger: an AfterTool ToolResult without error proves; with one, or none, it does not', async () => {
    const { recordLiveEdits } = await import('../commands/hooks/tool-use.js');
    const tool_input = { file_path: path.join(repo, 'a.ts'), old_string: 'Row 4\n', new_string: 'Row four\n' };
    const afterTool = (tool_response?: unknown) => {
      const state: any = { agentSlug: 'gemini', repoPath: repo, prompts: ['rename row 4'], promptTurnIds: ['t0'], commitTurns: sighting(sha, 'post-commit').commitTurns };
      recordLiveEdits(state, { tool_name: 'replace', tool_input, ...(tool_response !== undefined && { tool_response }) }, repo);
      return state;
    };
    const ok = afterTool({ llmContent: 'Successfully modified file', returnDisplay: 'ok' });
    expect(provenClaims(repo, 'gemini', ok, [sha], editCapturesFromLiveLedger(ok)))
      .toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }] });

    const failed = afterTool({ llmContent: 'Error: could not find the string', returnDisplay: 'Error', error: { message: 'could not find the string', type: 'edit_no_occurrence_found' } });
    expect(failed.liveEdits ?? []).toEqual([]);
    expect(provenClaims(repo, 'gemini', failed, [sha], editCapturesFromLiveLedger(failed))).toEqual({});

    const unknown = afterTool();
    expect(unknown.liveEdits.flatMap((e: any) => e.edits).map((e: any) => e.evidence)).toEqual([undefined]);
    expect(provenClaims(repo, 'gemini', unknown, [sha], editCapturesFromLiveLedger(unknown))).toEqual({});
  });
});

describe('Copilot (OR-45 checkpoints 3C/3C.1): only an edit its completion says succeeded, under an attested binding', () => {
  // ~/.copilot/session-state/<id>/events.jsonl (fixtures/copilot-events.jsonl):
  // tool.execution_start carries the arguments, tool.execution_complete the
  // verdict, joined by toolCallId.
  const sighting = (sha: string, via: string) => ({ promptTurnIds: ['t0'], commitTurns: [{ sha, turnId: 't0', at: '2026-10-16T10:00:00Z', via }] });
  const start = (toolCallId: string, toolName: string, args: Record<string, unknown>) =>
    ({ type: 'tool.execution_start', data: { toolCallId, toolName, arguments: args } });
  const complete = (toolCallId: string, data: Record<string, unknown>) => ({ type: 'tool.execution_complete', data: { toolCallId, ...data } });
  const editRow4 = (id: string) => start(id, 'edit', { path: path.join(repo, 'a.ts'), old_str: 'Row 4\n', new_str: 'Row four\n' });
  const patchRow4 = (id: string) => {
    const patch = `*** Begin Patch\n*** Update File: ${path.join(repo, 'a.ts')}\n@@\n Row 3\n-Row 4\n+Row four\n Row 5\n*** End Patch\n`;
    // Character-indexed, as Copilot serializes apply_patch.
    return start(id, 'apply_patch', Object.fromEntries([...patch].map((ch, i) => [String(i), ch])));
  };
  let sha: string;
  let events: string;
  beforeEach(() => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    sha = commit('copilot edit');
    events = path.join(repo, '..', `${path.basename(repo)}-copilot-events.jsonl`);
  });
  afterEach(() => { fs.rmSync(events, { force: true }); });

  const captureOf = async (rest: unknown[]) => {
    const { capturePromptEdits } = await import('../prompt-capture/index.js');
    fs.writeFileSync(events, [{ type: 'user.message', data: { content: 'rename row 4' } }, ...rest].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const caps = capturePromptEdits({ agent: 'copilot', repoPath: repo, transcriptPath: events, sessionCommitShas: [sha] });
    return editCapturesFromEditsJson(new Map(caps.map((c) => [c.promptIndex, JSON.stringify(c)] as [number, string])));
  };
  const claims = (caps: any, via = 'post-commit') => provenClaims(repo, 'copilot', sighting(sha, via) as any, [sha], caps);

  it('projects a successful edit or apply_patch of a post-commit or trailer attested commit', async () => {
    for (const call of [editRow4, patchRow4]) {
      const caps = await captureOf([call('c1'), complete('c1', { success: true })]);
      expect(caps[0].edits.map((e) => [e.file, e.evidence])).toEqual([['a.ts', 'tool_call']]);
      expect(claims(caps)).toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }] });
      expect(claims(caps, 'trailer')).toEqual({ [sha]: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }] }] });
    }
  });

  it('drops a failed call — even when its line did land — and a call reported both ways', async () => {
    const failed = await captureOf([editRow4('c1'), complete('c1', { success: false, error: { message: 'No match found' } })]);
    expect(failed.flatMap((c) => c.edits)).toEqual([]);
    expect(claims(failed)).toEqual({});
    const both = await captureOf([editRow4('c1'), complete('c1', { success: true }), complete('c1', { success: false })]);
    expect(both.flatMap((c) => c.edits)).toEqual([]);
    expect(claims(both)).toEqual({});
  });

  it('keeps a cancelled or unknown outcome unstamped', async () => {
    const outcomes: unknown[][] = [
      [{ type: 'abort', data: { reason: 'user_initiated' } }],       // turn aborted, no completion
      [],                                                            // log read before the completion flushed
      [complete('c1', {})],                                          // no verdict
      [complete('c1', { success: 'true' })],                         // not a boolean
      [complete('other', { success: true })],                        // another call's verdict
    ];
    for (const tail of outcomes) {
      const caps = await captureOf([editRow4('c1'), ...tail]);
      expect(caps[0].edits.map((e) => [e.file, e.evidence]), JSON.stringify(tail)).toEqual([['a.ts', undefined]]);
      expect(claims(caps), JSON.stringify(tail)).toEqual({});
    }
    // A start with no toolCallId cannot be joined to any verdict.
    const anon = await captureOf([{ type: 'tool.execution_start', data: { toolName: 'edit', arguments: { path: path.join(repo, 'a.ts'), old_str: 'Row 4\n', new_str: 'Row four\n' } } }]);
    expect(anon[0].edits.map((e) => e.evidence)).toEqual([undefined]);
    expect(claims(anon)).toEqual({});
  });

  it('stays commit-level for the watcher\'s path-only fallback and for back-filled content', () => {
    // transcript-watch.ts: the file set from promptDiffs, shaped like a tool call.
    const watcher = { file: 'a.ts', op: 'edit', source: 'tool_call' };
    const backfilled = { file: 'a.ts', op: 'write', oldContent: rows(1, 10), newContent: rows(1, 10).replace('Row 4\n', 'Row four\n'), source: 'tool_call', backfillSource: 'live-file' };
    for (const e of [watcher, { ...watcher, evidence: 'tool_call' }, backfilled, { ...backfilled, evidence: 'tool_call' }]) {
      const caps = editCapturesFromEditsJson(new Map([[0, JSON.stringify({ edits: [e], commits: [] })]]));
      expect(claims(caps), JSON.stringify(e)).toEqual({});
      // Under no agent: path-only and back-filled content prove nothing.
      expect(provenClaims(repo, 'claude-code', sighting(sha, 'post-commit') as any, [sha], caps), JSON.stringify(e)).toEqual({});
    }
  });

  it('stays commit-level on a transcript-only sighting or none', async () => {
    const caps = await captureOf([editRow4('c1'), complete('c1', { success: true })]);
    expect(claims(caps, 'transcript')).toEqual({});
    expect(provenClaims(repo, 'copilot', { promptTurnIds: ['t0'], commitTurns: [] } as any, [sha], caps)).toEqual({});
  });
});

describe('Codex end to end: rollout capture -> shared path -> note', () => {
  const rolloutCapture = async (patch: string, sha: string) => {
    const { capturePromptEdits } = await import('../prompt-capture/index.js');
    const rollout = path.join(repo, '..', `${path.basename(repo)}-rollout.jsonl`);
    fs.writeFileSync(rollout, [
      JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ text: 'edit and commit' }] } }),
      JSON.stringify({ payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch } }),
      JSON.stringify({ payload: { type: 'function_call_output', output: `[main ${sha.slice(0, 7)}] edit` } }),
    ].join('\n'));
    try {
      const caps = capturePromptEdits({ agent: 'codex', repoPath: repo, transcriptPath: rollout, sessionCommitShas: [sha] });
      return editCapturesFromEditsJson(new Map(caps.map((c) => [c.promptIndex, JSON.stringify(c)] as [number, string])));
    } finally {
      fs.rmSync(rollout, { force: true });
    }
  };
  const attestedState = (sha: string) => ({ promptTurnIds: ['t0'], commitTurns: [{ sha, turnId: 't0', at: '2026-10-16T10:00:00Z', via: 'post-commit' as const }] });

  it('writes the apply_patch lines of an attested Codex commit into a line record', async () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n').replace('Row 5\n', 'Row 5\nRow 5b\n'));
    const sha = commit('Update a.ts');
    const caps = await rolloutCapture(
      '*** Begin Patch\n*** Update File: a.ts\n@@\n Row 3\n-Row 4\n+Row four\n Row 5\n+Row 5b\n Row 6\n*** End Patch', sha,
    );
    const lineClaims = decide(repo, 'codex', attestedState(sha) as any, [sha], caps);
    const files = [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }, { start_line: 6, end_line: 6, iteration_index: 0 }] }];
    expect(provenOf(lineClaims)).toEqual({ [sha]: files });

    writeGitNotes(repo, [sha], {
      sessionId: SESSION, model: 'gpt-5.5-codex', agentSlug: 'codex', promptCount: 1, promptSummary: '',
      originUrl: '', linesAdded: 2, linesRemoved: 1,
      attribution: { sessionId: SESSION, agentId: 'codex', iterationIndexBySha: { [sha]: 0 }, lineClaims },
    } as any);
    const record = readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY];
    expect(record.attribution_level).toBe('line');
    expect(record.contributions[0].agent).toEqual({ id: 'codex' });
    expect(record.contributions[0].files).toEqual(files);
    expect(validateFull(record).ok).toBe(true);
  });

  it('an apply_patch Add File in a non-root commit stays commit-level (possible_rename)', async () => {
    const body = ['alpha', 'bravo', 'charlie'];
    write('stav.txt', body.map((l) => `${l}\n`).join(''));
    const sha = commit('Add stav');
    const caps = await rolloutCapture(`*** Begin Patch\n*** Add File: stav.txt\n${body.map((l) => `+${l}`).join('\n')}\n*** End Patch`, sha);
    expect(caps.flatMap((c) => c.edits).some((e) => e.file === 'stav.txt')).toBe(true);
    expect(decide(repo, 'codex', attestedState(sha) as any, [sha], caps))
      .toEqual({ [sha]: { status: 'degraded', reason: 'possible_rename' } });
  });
});

describe('note lifecycle: no downgrade, later upgrade', () => {
  // `claims`: an array is a `proven` decision; an object is the decision itself.
  const noteData = (sha: string, over: Record<string, unknown> = {}, claims?: unknown) => ({
    sessionId: SESSION,
    model: 'claude-opus-5-5',
    agentSlug: 'claude-code',
    promptCount: 1,
    promptSummary: 'do the thing',
    originUrl: `https://origin.example.com/sessions/${SESSION}`,
    linesAdded: 1,
    linesRemoved: 1,
    attribution: {
      sessionId: SESSION,
      agentId: 'claude-code',
      iterationIndexBySha: { [sha]: 0 },
      ...(claims ? { lineClaims: { [sha]: Array.isArray(claims) ? proven(claims) : claims } } : {}),
    },
    ...over,
  });
  const claims = [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }];

  it('post-commit line -> SessionEnd that did NOT re-check the lines (not_evaluated) -> line remains', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    writeGitNotes(repo, [sha], noteData(sha, { snapshot: true }, claims) as any);
    expect(readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('line');

    // SessionEnd: a fuller legacy payload, but no capture to re-check — no
    // decision at all, and an explicit not_evaluated, read the same.
    for (const decision of [undefined, { status: 'not_evaluated' }]) {
      writeGitNotes(repo, [sha], noteData(sha, { tokensUsed: 4321, promptCount: 2 }, decision) as any, { lockWaitMs: 2_000 });
      const note = readNote(sha);
      expect(note.origin.tokensUsed).toBe(4321);
      expect(note.origin.promptCount).toBe(2);
      expect(note[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('line');
      expect(note[ATTRIBUTION_RECORD_NOTE_KEY].contributions[0].files).toEqual(claims);
      expect(validateFull(note[ATTRIBUTION_RECORD_NOTE_KEY]).ok).toBe(true);
    }
  });

  describe('post-commit line -> a fresh SessionEnd/Stop re-check that fails (degraded) -> commit-level', () => {
    const state = (sha: string) => ({ promptTurnIds: ['t0'], commitTurns: [{ sha, turnId: 't0', at: '2026-10-16T10:00:00Z', via: 'post-commit' }] });
    const reCheck = (sha: string, map: Map<number, string>) => decide(repo, 'claude-code', state(sha) as any, [sha], editCapturesFromEditsJson(map));
    let sha: string;
    beforeEach(() => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      sha = commit('edit');
      writeGitNotes(repo, [sha], noteData(sha, { snapshot: true }, claims) as any);
      expect(readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('line');
    });
    const expectCommitLevelNow = (decisions: Decisions, reason: string) => {
      expect(decisions[sha]).toEqual({ status: 'degraded', reason });
      writeGitNotes(repo, [sha], noteData(sha, { tokensUsed: 99 }, decisions[sha]) as any, { lockWaitMs: 2_000 });
      const note = readNote(sha);
      expect(note.origin.tokensUsed).toBe(99);
      expect(note[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('commit');
      expect(note[ATTRIBUTION_RECORD_NOTE_KEY].contributions[0]).not.toHaveProperty('files');
      expect(note[ATTRIBUTION_RECORD_NOTE_KEY].contributions[0].session.id).toBe(SESSION);
      expect(validateFull(note[ATTRIBUTION_RECORD_NOTE_KEY]).ok).toBe(true);
    };

    it('capture_truncated', () => {
      expectCommitLevelNow(reCheck(sha, new Map([[0, `{"edits":[${EDITS_TRUNCATED_MARKER}`]])), 'capture_truncated');
    });

    it('replay_mismatch', () => {
      // The turn's edit names a "before" the parent never had.
      const map = new Map([[0, JSON.stringify({ edits: [{ file: 'a.ts', op: 'edit', oldContent: 'Row forty', newContent: 'Row four', source: 'tool_call' }] })]]);
      expectCommitLevelNow(reCheck(sha, map), 'replay_mismatch');
    });

    it('an unpublishable result is degraded too, never the stored lines', () => {
      expectCommitLevelNow({ [sha]: { status: 'degraded', reason: 'unpublishable' } }, 'unpublishable');
    });
  });

  it('commit-level -> a later write with proven claims upgrades to line', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    writeGitNotes(repo, [sha], noteData(sha) as any);
    const before = readNote(sha);
    expect(before[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('commit');
    expect(noteIsLineUpgradeCandidate(JSON.stringify(before), sha, SESSION)).toBe(true);

    writeGitNotes(repo, [sha], noteData(sha, {}, claims) as any);
    const after = readNote(sha);
    expect(after[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('line');
    expect(after[ATTRIBUTION_RECORD_NOTE_KEY].contributions[0].files).toEqual(claims);
    expect(noteIsLineUpgradeCandidate(JSON.stringify(after), sha, SESSION)).toBe(false);
  });

  const readStored = (s: string): string | null => { try { return git('notes', '--ref=origin', 'show', s); } catch { return null; } };
  /** Stop's plan, with a projector that records what it was asked and answers `answer`. */
  const stopPlan = (shas: string[], answer: (asked: string[]) => Decisions) => {
    const asked: string[][] = [];
    const plan = planStopNoteWrites({
      repoPath: repo, sessionId: SESSION, shas, readNote: readStored,
      project: (candidates) => { asked.push(candidates); return answer(candidates); },
    });
    return { ...plan, asked };
  };

  it('Stop picks a commit-level note for upgrade under an abbreviated sha, and leaves a line note alone', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    const short = sha.slice(0, 9);
    const provenFor = () => ({ [sha]: proven(claims) });

    expect(stopPlan([short], provenFor).write).toEqual([short]);                            // no note yet
    // Missing notes are written whatever the projection says.
    expect(stopPlan([short], () => ({ [sha]: { status: 'degraded', reason: 'timeout' } })).write).toEqual([short]);
    writeGitNotes(repo, [short], noteData(sha) as any);                                      // post-commit: commit-level
    expect(readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('commit');
    expect(stopPlan([short], () => ({})).write).toEqual([]);                                 // nothing new to add
    expect(stopPlan([short], () => ({ [sha]: { status: 'degraded', reason: 'replay_mismatch' } })).write).toEqual([]);
    const upgrade = stopPlan([short], provenFor);
    expect(upgrade.write).toEqual([short]);                                                  // upgrade
    expect(upgrade.asked).toEqual([[short]]);

    writeGitNotes(repo, [short], noteData(sha, {}, upgrade.lineClaims[sha]) as any);
    expect(readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY].contributions[0].files).toEqual(claims);
    // Already carries this session's lines: neither projected nor written, by full or short sha.
    const again = stopPlan([sha, short], provenFor);
    expect(again.write).toEqual([]);
    expect(again.asked).toEqual([]);
  });

  it('Stop leaves another session\'s note alone: not projected, not written, not pushed or imported', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    const other = noteData(sha, { sessionId: 'sess-other1', originUrl: 'https://origin.example.com/sessions/sess-other1' }) as any;
    other.attribution.sessionId = 'sess-other1';
    writeGitNotes(repo, [sha], other);
    const before = readStored(sha);
    importGitNote.mockClear();

    const plan = stopPlan([sha], () => ({ [sha]: proven(claims) }));
    expect(plan.asked).toEqual([]);
    expect(plan.write).toEqual([]);
    // What Stop does with an empty plan: nothing (stop.ts only calls writeGitNotes for a non-empty one).
    expect(readStored(sha)).toBe(before);
    expect(importGitNote).not.toHaveBeenCalled();
  });

  it('Stop leaves an invalid or legacy-only note alone, every time', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    const valid = JSON.parse(JSON.stringify(buildAttributionRecordForCommit(sha, source(), OPTS).record));
    const stored = [
      JSON.stringify({ origin: { version: 1, sessionId: SESSION } }),                                           // legacy-only
      JSON.stringify({ origin: { version: 1 }, [ATTRIBUTION_RECORD_NOTE_KEY]: { ...valid, schema_version: '2.0' } }), // unsupported
      JSON.stringify({ origin: { version: 1 }, [ATTRIBUTION_RECORD_NOTE_KEY]: { ...valid, revision: { vcs: 'git', id: shaOf('d') } } }),
      JSON.stringify({ origin: { version: 1 }, [ATTRIBUTION_RECORD_NOTE_KEY]: { ...valid, attribution_level: 'line', contributions: [{ ...valid.contributions[0], files: [{ path: 'a.ts', ranges: [{ start_line: 9, end_line: 2 }] }] }] } }),
      'not json',
    ];
    for (const raw of stored) {
      git('notes', '--ref=origin', 'add', '-f', '-m', raw, sha);
      for (let stop = 0; stop < 2; stop++) {
        const plan = stopPlan([sha], () => ({ [sha]: proven(claims) }));
        expect(plan.asked, raw).toEqual([]);
        expect(plan.write, raw).toEqual([]);
      }
    }
  });

  it('Stop with ten session commits of which one needs a note projects that one only', () => {
    write('a.ts', rows(1, 10));
    const shas: string[] = [];
    for (let i = 0; i < 10; i++) {
      write('a.ts', rows(1, 10).replace(`Row ${i + 1}\n`, `Row ${i + 1} changed\n`));
      shas.push(commit(`edit ${i}`));
    }
    // Nine already have this session's line notes; the last has none.
    for (const sha of shas.slice(0, 9)) writeGitNotes(repo, [sha], noteData(sha, {}, claims) as any);
    const plan = stopPlan(shas, (asked) => Object.fromEntries(asked.map((s) => [s, proven(claims)])));
    expect(plan.asked).toEqual([[shas[9]]]);
    expect(plan.write).toEqual([shas[9]]);
  });

  it('a fresh line result replaces the stored one', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n').replace('Row 6\n', 'Row six\n'));
    const sha = commit('edit');
    writeGitNotes(repo, [sha], noteData(sha, {}, claims) as any);
    const fresh = [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }, { start_line: 6, end_line: 6, iteration_index: 0 }] }];
    writeGitNotes(repo, [sha], noteData(sha, {}, fresh) as any);
    expect(readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY].contributions[0].files).toEqual(fresh);
  });

  it('keeps the stored iteration a range names when the rewrite lost the attestation', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    writeGitNotes(repo, [sha], noteData(sha, {}, claims) as any);
    const lost = noteData(sha) as any;
    delete lost.attribution.iterationIndexBySha;
    writeGitNotes(repo, [sha], lost);
    const record = readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY];
    expect(record.contributions[0].session.iterations).toEqual([{ index: 0 }]);
    expect(record.contributions[0].files).toEqual(claims);
    expect(validateFull(record).ok).toBe(true);
  });

  it('does not hand one session\'s proven lines to another session', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    writeGitNotes(repo, [sha], noteData(sha, {}, claims) as any);
    const other = noteData(sha, { sessionId: 'sess-other1', originUrl: 'https://origin.example.com/sessions/sess-other1' }) as any;
    other.attribution.sessionId = 'sess-other1';
    writeGitNotes(repo, [sha], other);
    const record = readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY];
    expect(record.contributions.map((c: any) => c.session.id)).toEqual(['sess-other1']);
    expect(record.attribution_level).toBe('commit');
  });

  it('never trusts a stored record that is not a valid v1.0 record of this commit', () => {
    const sha = shaOf('c');
    const payload = JSON.stringify({ origin: { version: 1 }, [ATTRIBUTION_RECORD_NOTE_KEY]: buildAttributionRecordForCommit(sha, source(), OPTS).record });
    const lineRecord = buildAttributionRecordForCommit(sha, source({ lineClaims: { [sha]: proven(claims) } }), OPTS).record!;
    const foreign = JSON.stringify({ [ATTRIBUTION_RECORD_NOTE_KEY]: { ...lineRecord, revision: { vcs: 'git', id: shaOf('d') } } });
    const broken = JSON.stringify({ [ATTRIBUTION_RECORD_NOTE_KEY]: { ...lineRecord, schema_version: '2.0' } });
    expect(preserveProvenLineClaims(foreign, payload, sha)).toBe(payload);
    expect(preserveProvenLineClaims(broken, payload, sha)).toBe(payload);
    expect(preserveProvenLineClaims('not json', payload, sha)).toBe(payload);
    expect(preserveProvenLineClaims(JSON.stringify({ [ATTRIBUTION_RECORD_NOTE_KEY]: lineRecord }), payload, sha)).not.toBe(payload);
  });

  it('puts no source line or prompt text into the record', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'SECRET_CODE_LINE\n'));
    const sha = commit('edit');
    writeGitNotes(repo, [sha], noteData(sha, { promptSummary: 'SECRET_PROMPT' }, claims) as any);
    expect(JSON.stringify(readNote(sha)[ATTRIBUTION_RECORD_NOTE_KEY])).not.toMatch(/SECRET/);
  });
});

describe('decisions: proven, degraded, not_evaluated (checkpoint 6.3)', () => {
  const edit = (file: string, oldContent: string, newContent: string) =>
    ({ file, op: 'edit' as const, oldContent, newContent, source: 'tool_call' as const, evidence: 'tool_call' as const });
  const bound = (sha: string, turnId = 't0', at = '2026-10-16T10:00:00Z') =>
    ({ promptTurnIds: ['t0', 't1'], commitTurns: [{ sha, turnId, at, via: 'post-commit' as const }] });
  let sha: string;
  beforeEach(() => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    sha = commit('edit');
  });

  it('not_evaluated when this writer had nothing to look at', () => {
    const caps = [{ promptIndex: 0, edits: [edit('a.ts', 'Row 4', 'Row four')] }];
    // An agent without line claims, or no capture at all: no key, read as not_evaluated.
    expect(decide(repo, 'antigravity', bound(sha) as any, [sha], caps)).toEqual({});
    expect(decide(repo, 'claude-code', bound(sha) as any, [sha], [])).toEqual({});
    // No bound turn; no countable edit in the window (the edit is a later turn's).
    expect(decide(repo, 'claude-code', { promptTurnIds: ['t0'], commitTurns: [] } as any, [sha], caps))
      .toEqual({ [sha]: { status: 'not_evaluated' } });
    expect(decide(repo, 'claude-code', bound(sha) as any, [sha], [{ promptIndex: 1, edits: caps[0].edits }]))
      .toEqual({ [sha]: { status: 'not_evaluated' } });
  });

  it('degraded when the window was evaluated and proved nothing', () => {
    expect(decide(repo, 'claude-code', bound(sha) as any, [sha], [{ promptIndex: 0, edits: [], truncated: true }]))
      .toEqual({ [sha]: { status: 'degraded', reason: 'capture_truncated' } });
    expect(decide(repo, 'claude-code', bound(sha) as any, [sha], [{ promptIndex: 0, edits: [edit('a.ts', 'Row forty', 'Row four')] }]))
      .toEqual({ [sha]: { status: 'degraded', reason: 'replay_mismatch' } });
  });

  it('proven only for a publishable set', () => {
    expect(decide(repo, 'claude-code', bound(sha) as any, [sha], [{ promptIndex: 0, edits: [edit('a.ts', 'Row 4', 'Row four')] }]))
      .toEqual({ [sha]: { status: 'proven', files: [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }] } });
  });

  it('a capture that cannot even be prepared leaves the lines not evaluated, and never throws', () => {
    const thrown = () => { throw new Error('ledger is not an array'); };
    expect(decide(repo, 'claude-code', bound(sha) as any, [sha], thrown)).toEqual({});
    // The live-ledger preparation post-commit runs, on a corrupt ledger.
    const corrupt = { ...bound(sha), liveEdits: 'corrupt' } as any;
    expect(() => editCapturesFromLiveLedger(corrupt)).toThrow();
    expect(decide(repo, 'claude-code', corrupt, [sha], () => editCapturesFromLiveLedger(corrupt))).toEqual({});
  });
});

describe('byte budget for line files (checkpoint 6.5)', () => {
  /** A 2400-line file in which the agent changed every other line: 1200 one-line ranges. */
  const fragmented = () => {
    const base = rows(1, 2400);
    write('frag.ts', base);
    commit('base frag');
    const next = base.split('\n').map((l, i) => (i % 2 === 0 && l ? `${l} agent` : l)).join('\n');
    write('frag.ts', next);
    return { base, next, sha: commit('fragmented') };
  };

  it('accepts a set whole or refuses it whole — never a trimmed one', () => {
    const small = [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1 }] }];
    expect(publishableLineFiles(small, undefined)).toEqual(small);
    const ranges = Array.from({ length: 1200 }, (_, i) => ({ start_line: 2 * i + 1, end_line: 2 * i + 1 }));
    expect(publishableLineFiles([{ path: 'frag.ts', ranges }], undefined)).toBeNull();
    expect(publishableLineFiles([...small, { path: 'frag.ts', ranges }], undefined)).toBeNull();
    // Measured as stored in the note, well inside Linux's 128 KiB per argument.
    expect(LINE_FILES_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
  });

  it('1200 fragmented ranges: degraded, a valid commit-level note is written, and the next Stop does not pick it', () => {
    const { base, next, sha } = fragmented();
    const state = { promptTurnIds: ['t0'], commitTurns: [{ sha, turnId: 't0', at: '2026-10-16T10:00:00Z', via: 'post-commit' }] };
    const caps = [{ promptIndex: 0, edits: [{ file: 'frag.ts', op: 'write' as const, oldContent: base, newContent: next, source: 'tool_call' as const }] }];
    const lineClaims = decide(repo, 'claude-code', state as any, [sha], caps);
    expect(lineClaims).toEqual({ [sha]: { status: 'degraded', reason: 'unpublishable' } });

    writeGitNotes(repo, [sha], {
      sessionId: SESSION, model: 'claude-opus-5-5', agentSlug: 'claude-code', promptCount: 1, promptSummary: '',
      originUrl: '', linesAdded: 1200, linesRemoved: 1200,
      attribution: { sessionId: SESSION, agentId: 'claude-code', lineClaims },
    } as any);
    const note = readNote(sha);
    expect(note.origin.sessionId).toBe(SESSION);
    expect(note[ATTRIBUTION_RECORD_NOTE_KEY].attribution_level).toBe('commit');
    expect(validateFull(note[ATTRIBUTION_RECORD_NOTE_KEY]).ok).toBe(true);

    // The builder runs the same check: handed the raw projection as "proven",
    // it still writes commit-level.
    const projected = Array.from({ length: 1200 }, (_, i) => ({ start_line: 2 * i + 1, end_line: 2 * i + 1 }));
    const built = buildAttributionRecordForCommit(sha, source({ lineClaims: { [sha]: proven([{ path: 'frag.ts', ranges: projected }]) } }), OPTS);
    expect(built.record?.attribution_level).toBe('commit');

    // Next Stop: an own commit-level note is a candidate, the projection is
    // degraded again, and nothing is written.
    let projectedCount = 0;
    const plan = planStopNoteWrites({
      repoPath: repo, sessionId: SESSION, shas: [sha],
      readNote: (s) => { try { return git('notes', '--ref=origin', 'show', s); } catch { return null; } },
      project: (shas) => { projectedCount++; return decide(repo, 'claude-code', state as any, shas, caps); },
    });
    expect(projectedCount).toBe(1);
    expect(plan.write).toEqual([]);
  });
});

describe('accepted underclaim (checkpoint 6.8)', () => {
  it('an unstamped edit made before the first commit of a multi-commit turn breaks the second commit\'s replay: commit-level, no rebinding', () => {
    // One turn: edit Row 2, commit A; edit Row 8, commit B. The Row 2 edit is
    // unstamped (no commitSha), so it stays in B's window too, where B's
    // parent (A) already has it: B's replay cannot find "Row 2" and degrades.
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const a = commit('first commit of the turn');
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 8\n', 'Row eight\n'));
    const b = commit('second commit of the turn');
    const edit = (oldContent: string, newContent: string) => ({ file: 'a.ts', op: 'edit' as const, oldContent, newContent, source: 'tool_call' as const });
    const caps = [{ promptIndex: 0, edits: [edit('Row 2', 'Row two'), edit('Row 8', 'Row eight')] }];
    const state = { promptTurnIds: ['t0'], commitTurns: [
      { sha: a, turnId: 't0', at: '2026-10-16T10:00:00Z', via: 'post-commit' },
      { sha: b, turnId: 't0', at: '2026-10-16T10:01:00Z', via: 'post-commit' },
    ] };
    const decisions = decide(repo, 'claude-code', state as any, [b], caps);
    expect(decisions[b]).toEqual({ status: 'degraded', reason: 'replay_mismatch' });
    // And the Row 8 line is not handed to B some other way.
    expect(provenOf(decisions)).toEqual({});
  });
});
