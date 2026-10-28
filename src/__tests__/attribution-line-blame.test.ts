// Line-level readers on top of the OR-46 re-anchor (checkpoint 2, CR1).
//
// `getLineBlame` and everything built on it answer per line in tiers: `ai` /
// `line` ([AI]) on a canonical line claim that survives into the viewed file;
// `ai` / `commit` ([AI~]) when only the blamed commit carries AI evidence — a
// commit-level record, a legacy note, a trailer, an active session whose state
// recorded that exact commit (never one it merely started before); `human`
// only under HUMAN_WHEN_NO_AI_EVIDENCE; and `unknown` for everything else — a
// line a line-level record does not cover, a broken record, an uncommitted
// line, an exhausted budget. These tests pin that policy, the HEAD /
// dirty-working-tree contract, and each consumer's handling of the tiers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const activeSessions = vi.hoisted(() => ({
  list: [] as Array<{ headShaAtStart?: string; sessionId?: string; model?: string; sessionCommitShas?: string[] }>,
  /** Called on every read of the active sessions: the last evidence phase. */
  onList: null as null | (() => void),
}));
const connected = vi.hoisted(() => ({ on: false }));
/** The server's /why answers, and every sha the CLI asked it about. */
const server = vi.hoisted(() => ({ card: null as any, cardFor: null as null | ((sha: string) => any), asked: [] as string[], session: null as any }));
vi.mock('../api.js', () => ({
  api: {
    getWhyByRemote: async (q: { sha: string }) => { server.asked.push(q.sha); return server.cardFor ? server.cardFor(q.sha) : server.card; },
    getWhy: async () => null,
    getRepos: async () => [],
    getSession: async () => { if (!server.session) throw new Error('offline in tests'); return server.session; },
  },
}));
vi.mock('../session-state.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listActiveSessions: () => { activeSessions.onList?.(); return activeSessions.list; },
}));
/** `withOpenedPrompts`: pass-through unless a test opens (or refuses) the seal. */
const seal = vi.hoisted(() => ({ open: null as null | ((origin: any) => any), calls: 0 }));
vi.mock('../note-seal.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withOpenedPrompts: async (origin: any) => { seal.calls++; return seal.open ? seal.open(origin) : origin; },
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isConnectedMode: () => connected.on,
}));

const {
  getLineBlame,
  resolveLineAttribution,
  computeFileAttribution,
  computeAcceptanceMetrics,
  buildFileAttributionContext,
} = await import('../attribution.js');
const { validateFull } = await import('../attribution-record.js');
const { claimIdentity, resolveFileAtRevision } = await import('../attribution-line-reanchor.js');
const { diffCommand } = await import('../commands/diff.js');
const { computeAttributionStats, MAX_TRACKED_CLAIM_LINES } = await import('../attribution.js');
const { compareCommand } = await import('../commands/compare.js');
const { verifyCommand } = await import('../commands/verify.js');
const { blameCommand } = await import('../commands/blame.js');
const { whyCommand } = await import('../commands/why.js');
const { summarizeBlame, buildReviewPrompt } = await import('../commands/pre-review.js');
const { computeCommitAttribution } = await import('../attribution.js');
const { exportAgentTrace, importAgentTrace } = await import('../agent-trace.js');

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

type Range = { start_line: number; end_line: number; iteration_index?: number };

function lineRecord(sha: string, files: Array<{ path: string; ranges: Range[] }> | null, session = 'session-agent') {
  const iterations = [...new Set((files ?? []).flatMap((f) => f.ranges.flatMap((r) => r.iteration_index ?? [])))];
  return {
    schema_version: '1.0',
    revision: { vcs: 'git', id: sha },
    attribution_level: files ? 'line' : 'commit',
    recorded_at: '2026-10-20T00:00:00Z',
    producer: { name: 'origin-cli', version: '0.20261020.1504' },
    contributions: [{
      evidence: 'session_capture',
      agent: { id: 'codex' },
      model: { id: 'gpt-5.3-codex' },
      session: iterations.length ? { id: session, iterations: iterations.map((index) => ({ index })) } : { id: session },
      ...(files ? { files } : {}),
    }],
  };
}

let repo: string;
let logs: string[];
const origCwd = process.cwd();
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commit = (msg: string): string => {
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', msg);
  return git('rev-parse', 'HEAD').trim();
};
const note = (sha: string, payload: Record<string, unknown>) =>
  git('notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(payload), sha);
/** A canonical record (with an unrelated legacy payload beside it, as writers leave it). */
const canonical = (sha: string, files: Array<{ path: string; ranges: Range[] }> | null, session = 'session-agent') => {
  const rec = lineRecord(sha, files, session);
  expect(validateFull(rec).ok).toBe(true);
  note(sha, { origin: { sessionId: 'legacy-session', model: 'legacy-model', agent: 'legacy-agent', promptSummary: 'LEGACY PROMPT' }, attribution_record: rec });
};
const kinds = (lines: Array<{ authorship: string }>) => lines.map((l) => l.authorship);
const output = () => logs.join('\n').replace(/\[[0-9;]*m/g, '');

beforeEach(() => {
  activeSessions.list = [];
  activeSessions.onList = null;
  connected.on = false;
  server.card = null;
  server.cardFor = null;
  server.asked = [];
  seal.open = null;
  seal.calls = 0;
  server.session = null;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-line-blame-')));
  git('init', '-q');
  git('config', 'user.email', 'h@example.com');
  git('config', 'user.name', 'Hannah Human');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(origCwd);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── The policy ─────────────────────────────────────────────────────────────

describe('getLineBlame: proof, policy and unknown', () => {
  it('marks only the proven lines of a mixed commit as AI, with the canonical identity', () => {
    write('a.ts', rows(1, 6));
    const x = commit('mixed work');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 3, iteration_index: 1 }] }]);
    const lines = getLineBlame(repo, 'a.ts');
    expect(kinds(lines)).toEqual(['unknown', 'ai', 'ai', 'unknown', 'unknown', 'unknown']);
    expect(lines[1]).toEqual({
      lineNumber: 2, authorship: 'ai', confidence: 'line', sessionId: 'session-agent', agent: 'codex', model: 'gpt-5.3-codex', tool: 'codex',
      author: 'Hannah Human', commitSha: x, iterationIndex: 1,
    });
    // The record is line-level and does not cover line 1: unknown, not human,
    // and not [AI~] from the legacy payload beside the record either.
    expect(lines[0]).toMatchObject({ authorship: 'unknown', unknownReason: 'no_line_claim', commitSha: x });
    expect(lines[0].sessionId).toBeUndefined();
    expect(lines[0].confidence).toBeUndefined();
  });

  it('commit-level, legacy and trailer evidence is [AI~] — never line proof, nor human, nor unknown', () => {
    write('commit-level.ts', rows(1, 2));
    write('legacy.ts', rows(1, 2));
    write('trailer.ts', rows(1, 2));
    const a = commit('agent, commit-level');
    canonical(a, null);
    // The canonical commit-level record names the identity, not its legacy payload.
    expect(getLineBlame(repo, 'commit-level.ts')).toEqual([1, 2].map((n) => ({
      lineNumber: n, authorship: 'ai', confidence: 'commit', sessionId: 'session-agent', agent: 'codex', tool: 'codex',
      model: 'gpt-5.3-codex', author: 'Hannah Human', commitSha: a,
    })));

    write('legacy.ts', rows(1, 3));
    const b = commit('agent, legacy note only');
    note(b, { origin: { sessionId: 'legacy-only', model: 'claude-opus-4-6', agent: 'claude-code' } });
    const legacy = getLineBlame(repo, 'legacy.ts');
    expect(legacy[2]).toEqual({
      lineNumber: 3, authorship: 'ai', confidence: 'commit', sessionId: 'legacy-only', agent: 'claude-code', tool: 'claude-code',
      model: 'claude-opus-4-6', author: 'Hannah Human', commitSha: b,
    });
    expect(legacy[2].iterationIndex).toBeUndefined();

    write('trailer.ts', rows(1, 3));
    const t = commit('agent work\n\nOrigin-Session: abc\nCo-Authored-By: Claude <noreply@anthropic.com>');
    expect(getLineBlame(repo, 'trailer.ts')[2]).toEqual({ lineNumber: 3, authorship: 'ai', confidence: 'commit', sessionId: 'abc', author: 'Hannah Human', commitSha: t });

    // A known agent pattern without any session names the tool only.
    write('pattern.ts', 'one\n');
    const p = commit('agent work\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    expect(getLineBlame(repo, 'pattern.ts')).toEqual([{ lineNumber: 1, authorship: 'ai', confidence: 'commit', agent: 'claude-code', tool: 'claude-code', author: 'Hannah Human', commitSha: p }]);
    for (const l of [...getLineBlame(repo, 'commit-level.ts'), ...legacy]) expect(l.confidence).not.toBe('line');
  });

  it('calls a line human only when its commit has no Origin AI evidence at all', () => {
    write('a.ts', rows(1, 3));
    const h = commit('plain human commit');
    expect(getLineBlame(repo, 'a.ts')).toEqual([1, 2, 3].map((n) => ({ lineNumber: n, authorship: 'human', author: 'Hannah Human', commitSha: h })));
  });

  it('a note of any kind on the commit, even a non-AI one, keeps its lines unknown', () => {
    write('a.ts', rows(1, 2));
    const h = commit('human, but noted');
    note(h, { origin: { agent: 'Human' } });
    expect(getLineBlame(repo, 'a.ts').map((l) => l.unknownReason)).toEqual(['no_record', 'no_record']);
  });

  it('hands a human rewrite of a claimed line to the human, and a reformat by an agent commit to that commit at commit level', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 4 }] }]);
    write('a.ts', rows(1, 4).replace('Row 2\n', 'Row two\n'));
    commit('human edit');
    write('a.ts', rows(1, 4).replace('Row 2\n', 'Row two\n').replace('Row 3\n', '  Row 3\n'));
    commit('format\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const lines = getLineBlame(repo, 'a.ts');
    expect(lines.map((l) => [l.authorship, l.confidence])).toEqual([['ai', 'line'], ['human', undefined], ['ai', 'commit'], ['ai', 'line']]);
  });

  it('an exhausted budget in the strict phase leaves no human and no AI line', () => {

    write('a.ts', rows(1, 3));
    commit('human');
    // A clock that runs out after the two rev-parse calls, inside the resolver:
    // the file is still shown, every line unknown, none human.
    let reads = 0;
    const timedOut = getLineBlame(repo, 'a.ts', { deadline: { at: 1e9, now: () => (++reads > 4 ? 2e9 : 0) } });
    expect(timedOut).toEqual([1, 2, 3].map((n) => ({ lineNumber: n, authorship: 'unknown', unknownReason: 'timeout' })));
    // The same, with a line claim at stake: no proof was shown, so none is.
    canonical(git('rev-parse', 'HEAD').trim(), [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 3 }] }]);
    reads = 0;
    expect(kinds(getLineBlame(repo, 'a.ts', { deadline: { at: 1e9, now: () => (++reads > 4 ? 2e9 : 0) } }))).toEqual(['unknown', 'unknown', 'unknown']);
    // Expired before anything: no answer at all rather than a guess.
    expect(getLineBlame(repo, 'a.ts', { deadline: { at: 0, now: () => 1 } })).toEqual([]);
  });
});

// ─── HEAD and the dirty working tree ────────────────────────────────────────

describe('view contract: HEAD proof, working-tree coordinates', () => {
  let x: string;
  beforeEach(() => {
    write('src/a.ts', rows(1, 6));
    x = commit('agent');
    canonical(x, [{ path: 'src/a.ts', ranges: [{ start_line: 3, end_line: 4 }] }]);
  });

  it('a clean file reads the same in both views', () => {
    const wt = resolveLineAttribution(repo, 'src/a.ts')!;
    const head = resolveLineAttribution(repo, 'src/a.ts', { view: 'head' })!;
    expect(wt.lines).toEqual(head.lines);
    expect(wt.text).toBe(head.text);
    expect(wt.revision).toBe(x);
  });

  it('numbers lines as on disk; an uncommitted insertion above shifts the claim and is itself uncommitted', () => {
    write('src/a.ts', 'new line\n' + rows(1, 6));
    const wt = resolveLineAttribution(repo, 'src/a.ts')!;
    expect(wt.text).toBe('new line\n' + rows(1, 6));
    expect(kinds(wt.lines)).toEqual(['unknown', 'unknown', 'unknown', 'ai', 'ai', 'unknown', 'unknown']);
    expect(wt.lines[0].unknownReason).toBe('uncommitted');
    expect(wt.lines[3]).toMatchObject({ lineNumber: 4, authorship: 'ai', commitSha: x });

    // The HEAD view does not move with the disk.
    const head = resolveLineAttribution(repo, 'src/a.ts', { view: 'head' })!;
    expect(head.text).toBe(rows(1, 6));
    expect(kinds(head.lines)).toEqual(['unknown', 'unknown', 'ai', 'ai', 'unknown', 'unknown']);
  });

  it('an uncommitted edit of a claimed line drops its claim on disk only', () => {
    write('src/a.ts', rows(1, 6).replace('Row 3\n', 'Row three\n'));
    expect(resolveLineAttribution(repo, 'src/a.ts')!.lines[2]).toEqual({ lineNumber: 3, authorship: 'unknown', unknownReason: 'uncommitted' });
    expect(resolveLineAttribution(repo, 'src/a.ts', { view: 'head' })!.lines[2].authorship).toBe('ai');
  });

  it('an uncommitted deletion of one of two identical claimed lines claims neither', () => {
    write('d.ts', 'start\nx = 1\nx = 1\nend\n');
    const d = commit('agent duplicates');
    canonical(d, [{ path: 'd.ts', ranges: [{ start_line: 2, end_line: 3 }] }]);
    expect(kinds(getLineBlame(repo, 'd.ts'))).toEqual(['unknown', 'ai', 'ai', 'unknown']);
    write('d.ts', 'start\nx = 1\nend\n');
    expect(getLineBlame(repo, 'd.ts')[1]).toEqual({ lineNumber: 2, authorship: 'unknown', unknownReason: 'uncommitted' });
  });

  it('an untracked file is all uncommitted; a file deleted on disk has no worktree view', () => {
    write('new.ts', 'a\nb\n');
    expect(getLineBlame(repo, 'new.ts')).toEqual([
      { lineNumber: 1, authorship: 'unknown', unknownReason: 'uncommitted' },
      { lineNumber: 2, authorship: 'unknown', unknownReason: 'uncommitted' },
    ]);
    expect(getLineBlame(repo, 'new.ts', { view: 'head' })).toEqual([]);
    fs.rmSync(path.join(repo, 'src/a.ts'));
    expect(resolveLineAttribution(repo, 'src/a.ts')).toBeNull();
    expect(kinds(getLineBlame(repo, 'src/a.ts', { view: 'head' }))).toContain('ai');
  });

  it('accepts an absolute path and a subdirectory as repoPath, and refuses a path outside the repo', () => {
    const abs = path.join(repo, 'src', 'a.ts');
    expect(kinds(getLineBlame(path.join(repo, 'src'), abs))).toEqual(kinds(getLineBlame(repo, 'src/a.ts')));
    expect(getLineBlame(repo, path.join(os.tmpdir(), 'elsewhere.ts'))).toEqual([]);
  });
});

// ─── Consumers ──────────────────────────────────────────────────────────────

describe('consumers keep unknown apart', () => {
  let x: string;
  beforeEach(() => {
    write('a.ts', rows(1, 4));
    x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
    write('a.ts', rows(1, 4) + 'human tail\n');
    commit('human');
  });

  it('origin blame --json: ai, unknown and human lines, with sessions only for proven lines', async () => {
    process.chdir(repo);
    await blameCommand('a.ts', { json: true });
    const parsed = JSON.parse(output());
    expect(parsed.view).toBe('worktree');
    expect(parsed.revision).toBe(git('rev-parse', 'HEAD').trim());
    expect(parsed.lines.map((l: any) => [l.authorship, l.unknownReason ?? null])).toEqual([
      ['ai', null], ['unknown', 'no_line_claim'], ['unknown', 'no_line_claim'], ['unknown', 'no_line_claim'], ['human', null],
    ]);
    expect(parsed.lines[0]).toMatchObject({ sessionId: 'session-agent', agent: 'codex', content: 'Row 1' });
    expect(parsed.lines[1].sessionId).toBeUndefined();
    // The legacy payload names a different session: it is not attached to the proven one.
    expect(parsed.sessions).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain('LEGACY PROMPT');
  });

  it('origin blame pretty output counts unknown on its own', async () => {
    process.chdir(repo);
    await blameCommand('a.ts', {});
    const out = output();
    expect(out).toContain('[??]');
    expect(out).toContain('AI: 1 (20%)');
    expect(out).toContain('Human: 1 (20%)');
    expect(out).toContain('Unknown: 3 (60%)');
  });

  it('origin why on an unknown line names no agent, session or prompt', async () => {
    process.chdir(repo);
    await whyCommand('a.ts:2');
    const out = output();
    expect(out).toContain('Line-level attribution unknown (no_line_claim)');
    for (const leaked of ['session-', 'legacy-session', 'LEGACY PROMPT', 'codex', 'Written by']) expect(out).not.toContain(leaked);
  });

  it('origin why on a proven line names the canonical session, not the legacy one', async () => {
    process.chdir(repo);
    await whyCommand('a.ts:1');
    const out = output();
    expect(out).toContain('Written by codex');
    expect(out).toContain('Session session-');
    expect(out).not.toContain('legacy-s');
    expect(out).not.toContain('LEGACY PROMPT');
  });

  it('origin why on a human line and on an uncommitted line', async () => {
    process.chdir(repo);
    await whyCommand('a.ts:5');
    expect(output()).toContain('No Origin session found for this commit.');
    logs = [];
    write('a.ts', rows(1, 4) + 'human tail\nuncommitted\n');
    await whyCommand('a.ts:6');
    expect(output()).toContain('Uncommitted change');
  });

  it('origin why <file> reports unknown as its own row', async () => {
    process.chdir(repo);
    await whyCommand('a.ts');
    const out = output();
    expect(out).toContain('20% AI (1)');
    expect(out).toContain('20% human (1)');
    expect(out).toContain('60% unknown (3)');
    expect(out).toMatch(/Unknown\s+3 lines/);
  });

  it('pre-review counts unknown apart and takes sessions from proven lines only', () => {
    const summary = summarizeBlame('a.ts', getLineBlame(repo, 'a.ts'));
    expect(summary).toEqual({ file: 'a.ts', aiLines: 1, humanLines: 1, mixedLines: 0, unknownLines: 3, sessionIds: ['session-agent'] });
  });

  it('file attribution context says unknown, and names no agent for it', () => {
    const ctx = buildFileAttributionContext(repo, path.join(repo, 'a.ts'))!;
    expect(ctx).toContain('20% AI-generated (1/5 lines); 3 lines have no line-level attribution.');
    expect(ctx).toContain('Line 1: codex (gpt-5.3-codex)');
    expect(ctx).toContain('Lines 2-4: unknown (no line-level attribution)');
    expect(ctx).toContain('Line 5: human (Hannah Human)');
  });

  it('file attribution and acceptance count unknown on their own', () => {
    expect(computeFileAttribution(repo, 'a.ts')).toMatchObject({ totalLines: 5, aiLines: 1, humanLines: 1, unknownLines: 3, unknownPercentage: 60 });
    // A legacy-noted AI commit tracks nothing: only canonical claims are tracked.
    write('b.ts', rows(1, 2));
    const b = commit('agent, legacy');
    note(b, { origin: { sessionId: 'legacy-only', model: 'claude-opus-4-6' } });
    expect(computeAcceptanceMetrics(repo, `${x}..HEAD`)).toEqual({
      totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null,
    });
  });

  it('Agent Trace exports HEAD lines with unknown as unknown, and importing unknown records nothing', () => {
    write('a.ts', 'dirty\n' + rows(1, 4) + 'human tail\n');
    const trace = exportAgentTrace(repo);
    const file = trace.files.find((f) => f.path === 'a.ts')!;
    const byType = Object.fromEntries(file.conversations.map((c) => [c.contributor.type, c.ranges]));
    expect(byType).toEqual({
      ai: [{ start_line: 1, end_line: 1 }],
      unknown: [{ start_line: 2, end_line: 4 }],
      human: [{ start_line: 5, end_line: 5 }],
    });

    const target = git('rev-parse', 'HEAD').trim();
    importAgentTrace(repo, { ...trace, vcs: { type: 'git', revision: target } });
    const imported = JSON.parse(git('notes', '--ref=origin', 'show', target)).origin.attribution.files['a.ts'];
    expect(imported.humanLines).toEqual([5]);
    expect(imported.aiLines).toEqual([1]);
  });
});

// ─── Revision of checkpoint 2 ───────────────────────────────────────────────

describe('connected origin why: a proven line is enriched strictly, any other committed line asks its commit', () => {
  const serverCard = (sessionId: string, promptIndex = 0) => ({
    session: { id: sessionId, agent: 'server-agent', model: 'server-model', url: `/sessions/${sessionId}` },
    prompt: { index: promptIndex, text: 'SERVER PROMPT TEXT' },
    confidence: 'high',
    sha: 'f'.repeat(40),
    message: 'from the server',
  });

  let x: string;
  beforeEach(() => {
    connected.on = true;
    write('a.ts', rows(1, 4));
    x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: 2 }] }]);
    write('c.ts', rows(1, 2));
    write('l.ts', rows(1, 2));
    write('m.ts', rows(1, 2));
    const y = commit('three more agent files');
    note(y, {
      origin: { sessionId: 'legacy-session', model: 'm', agent: 'claude-code', promptSummary: 'LEGACY PROMPT' },
      attribution_record: lineRecord(y, null, 'commit-level-session'),
    });
    process.chdir(repo);
  });

  /** A server card, said as server attribution at commit level — never as the line's proof. */
  const expectCommitLevelCard = (out: string) => {
    expect(out).toContain('commit-level · server attribution; local line proof unavailable');
    expect(out).toContain('Written by server-agent');
    expect(out).toContain('Server prompt #0: "SERVER PROMPT TEXT"');
    expect(out).not.toMatch(/ {2}Prompt #/);
  };

  it('a line-level record that does not cover the line: one call for its commit, a commit-level server card', async () => {
    server.card = serverCard('another-session');
    await whyCommand('a.ts:2');
    expect(server.asked).toEqual([x]);
    expectCommitLevelCard(output());
    expect(output()).not.toContain('Line-level attribution unknown');
  });

  it('a commit-level record: one call, the server card over the local [AI~], whatever session it names', async () => {
    server.card = serverCard('not-the-local-session');
    await whyCommand('c.ts:2');
    expect(server.asked).toHaveLength(1);
    expectCommitLevelCard(output());
  });

  it('a commit-level record with no server card: the local [AI~] answer, unchanged', async () => {
    server.card = { sha: 'f'.repeat(40), message: 'no session here', prompt: { index: 0, text: 'SERVER PROMPT TEXT' } };
    await whyCommand('c.ts:2');
    expect(server.asked).toHaveLength(1);
    const out = output();
    expect(out).toContain('commit-level attribution');
    expect(out).toContain('no line-level proof');
    expect(out).toContain('Session commit-l');
    expect(out).not.toContain('legacy-s');
    expect(out).not.toContain('SERVER PROMPT TEXT');
    expect(out).not.toContain('Prompt #');
  });

  it('a human line with no note gets the server card of its commit; without one it stays human', async () => {
    write('h.ts', 'plain\n');
    const h = commit('plain human commit');
    server.card = serverCard('fresh-clone-session');
    await whyCommand('h.ts:1');
    expect(server.asked).toEqual([h]);
    expectCommitLevelCard(output());
    logs = [];
    server.card = null;
    await whyCommand('h.ts:1');
    expect(output()).toContain('No Origin session found for this commit.');
  });

  /** `n` commits, each rewriting line 1 of `file`; returns them oldest first. */
  const rewrites = (file: string, n: number) => Array.from({ length: n }, (_, k) => {
    write(file, `version ${k}\n`);
    return commit(`human v${k}`);
  });
  const cardAt = (sessionId: string, confidence: string, message: string) =>
    ({ session: { id: sessionId, agent: 'server-agent', url: `/sessions/${sessionId}` }, confidence, sha: 'f'.repeat(40), message });

  it('history: a high current card asks nothing more', async () => {
    const [, , c3] = rewrites('hist.ts', 3);
    server.cardFor = (sha) => cardAt('s-current', 'high', `card of ${sha.slice(0, 7)}`);
    await whyCommand('hist.ts:1');
    expect(server.asked).toEqual([c3]);
    expect(output()).not.toContain('line moved since it was written');
  });

  it('history: a null or weak current card gives way to an older high card, marked drifted and commit-level', async () => {
    const [c1, c2, c3] = rewrites('hist.ts', 3);
    for (const current of [null, cardAt('s-weak', 'medium', 'weak current')]) {
      logs = [];
      server.asked = [];
      server.cardFor = (sha) => (sha === c3 ? current : sha === c1 ? cardAt('s-old', 'high', 'older high') : null);
      await whyCommand('hist.ts:1');
      expect(server.asked).toEqual([c3, c2, c1]);
      const out = output();
      expect(out).toContain('commit-level · server attribution; local line proof unavailable');
      expect(out).toContain('older high');
      expect(out).toContain('line moved since it was written');
      expect(out).not.toContain('weak current');
    }
  });

  it('history: a weak current card stays when history offers only weak or empty cards', async () => {
    const [c1, c2, c3] = rewrites('hist.ts', 3);
    server.cardFor = (sha) => (sha === c3 ? cardAt('s-weak', 'medium', 'weak current') : sha === c2 ? cardAt('s-old', 'low', 'older weak') : null);
    await whyCommand('hist.ts:1');
    expect(server.asked).toEqual([c3, c2, c1]);
    const out = output();
    expect(out).toContain('weak current');
    expect(out).not.toContain('older weak');
    expect(out).not.toContain('line moved since it was written');
  });

  it('history: more than six commits never fan out past the bound, and no commit is asked twice', async () => {
    const all = rewrites('hist.ts', 10);
    server.cardFor = () => null;
    await whyCommand('hist.ts:1');
    expect(server.asked[0]).toBe(all[9]);
    expect(server.asked.length).toBeLessThanOrEqual(6);
    expect(new Set(server.asked).size).toBe(server.asked.length);
    expect(output()).toContain('No Origin session found for this commit.');
  });

  it('history: a dirty insertion above a committed line walks the history of its strict-blame origin', async () => {
    const [c1, c2, c3] = Array.from({ length: 3 }, (_, k) => {
      write('hist.ts', `top\nversion ${k}\n`);
      return commit(`human v${k}`);
    });
    write('hist.ts', 'dirty a\ndirty b\ntop\nversion 2\n');
    const resolution = resolveLineAttribution(repo, 'hist.ts')!;
    expect(resolution.historyAnchors).toHaveLength(resolution.lines.length);
    expect(resolution.historyAnchors[0]).toBeNull();
    expect(resolution.historyAnchors[3]).toEqual({ revision: c3, path: 'hist.ts', line: 2 });

    // Displayed line 4 is HEAD's line 2: the history is that line's, not a line 4 HEAD does not have.
    server.cardFor = (sha) => (sha === c1 ? cardAt('s-old', 'high', 'older high') : null);
    await whyCommand('hist.ts:4');
    expect(server.asked).toEqual([c3, c2, c1]);
    expect(output()).toContain('older high');
    expect(output()).toContain('line moved since it was written');
  });

  it('history: a proven line whose card is refused never walks the history', async () => {
    write('p.ts', 'old\n');
    commit('human base');
    write('p.ts', 'new\n');
    const p1 = commit('agent');
    canonical(p1, [{ path: 'p.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
    server.cardFor = () => cardAt('someone-else', 'high', 'refused card');
    await whyCommand('p.ts:1');
    expect(server.asked).toEqual([p1]);
    expect(output()).not.toContain('refused card');
  });

  const sealedLegacy = (file: string, origin: Record<string, unknown>) => {
    write(file, rows(1, 3));
    const sha = commit(`legacy ${file}`);
    note(sha, { origin: { model: 'm', agent: 'claude-code', promptTextWithheld: true, sealed: { kid: 'k1', blob: 'x' }, costUsd: 0.5, promptCount: 3, ...origin } });
    return sha;
  };

  it('opened prompt: a legacy [AI~] of the same session, after a server miss, shows the session summary as commit-level', async () => {
    sealedLegacy('l.ts', { sessionId: 'legacy-only' });
    seal.open = (o) => ({ ...o, promptSummary: 'OPENED SUMMARY', fullPrompt: 'FULL PROMPT TEXT', prompts: [{ index: 0, text: 'PROMPTS ELEMENT' }], promptsUnsealed: true });
    await whyCommand('l.ts:3');
    expect(seal.calls).toBe(1);
    const out = output();
    expect(out).toContain('commit-level attribution');
    expect(out).toContain('Session prompt (commit-level; not proof for this line): OPENED SUMMARY');
    expect(out).toContain('Session metadata: $0.50 · 3 turns');
    for (const leaked of ['Prompt #', 'FULL PROMPT TEXT', 'PROMPTS ELEMENT']) expect(out).not.toContain(leaked);
  });

  it('opened prompt: a mismatched legacy session or a multi-session aggregate opens and shows nothing', async () => {
    seal.open = (o) => ({ ...o, promptSummary: 'MUST NOT SHOW' });
    // c.ts: the canonical record names commit-level-session, its legacy payload legacy-session.
    await whyCommand('c.ts:2');
    write('sq.ts', 'one\n');
    const q = commit('squash');
    note(q, { origin: { squashMerge: true, sessionIds: ['s1', 's2'], promptSummary: 'AGGREGATE SUMMARY' } });
    await whyCommand('sq.ts:1');
    expect(seal.calls).toBe(0);
    const out = output();
    for (const leaked of ['MUST NOT SHOW', 'AGGREGATE SUMMARY', 'LEGACY PROMPT', 'Session prompt']) expect(out).not.toContain(leaked);
    expect(out).toContain('commit-level attribution');
  });

  it('opened prompt: a seal that cannot be opened keeps the local [AI~] with the sealed, commit-level explanation', async () => {
    sealedLegacy('l.ts', { sessionId: 'legacy-only' });
    for (const refuse of [(o: any) => o, () => { throw new Error('no key'); }]) {
      logs = [];
      seal.open = refuse;
      await whyCommand('l.ts:3');
      const out = output();
      expect(out).toContain('commit-level attribution: this commit carries AI evidence, but there is no line-level proof');
      expect(out).toContain('Session prompt: sealed in git notes — no key for this user (commit-level; not proof for this line)');
      expect(out).not.toContain('Prompt #');
    }
  });

  it('an uncommitted line never asks the server', async () => {
    write('a.ts', rows(1, 4) + 'dirty\n');
    server.card = serverCard('session-agent');
    await whyCommand('a.ts:5');
    expect(server.asked).toEqual([]);
    expect(output()).toContain('Uncommitted change');
  });

  it('a legacy note only, or a malformed record, with no server answer: the local answers stand', async () => {
    write('l.ts', rows(1, 3));
    const legacy = commit('legacy only');
    note(legacy, { origin: { sessionId: 'legacy-only', model: 'm', agent: 'claude-code' } });
    write('m.ts', rows(1, 3));
    const malformed = commit('malformed record');
    note(malformed, { origin: { sessionId: 'x' }, attribution_record: { schema_version: '1.0', revision: { vcs: 'git', id: malformed } } });
    server.card = null;
    await whyCommand('l.ts:3');
    await whyCommand('m.ts:3');
    expect(server.asked).toEqual([legacy, malformed]);
    // The legacy note is commit evidence; a malformed record is not evidence at all.
    expect(output()).toContain('commit-level attribution: this commit carries AI evidence, but there is no line-level proof');
    expect(output()).toContain('Line-level attribution unknown (record_invalid)');
    expect(output()).not.toContain('SERVER PROMPT TEXT');
  });

  it('a proven line takes the card of its own session, with the prompt its claim names', async () => {
    server.card = serverCard('session-agent', 2);
    await whyCommand('a.ts:1');
    expect(server.asked).toEqual([x]);
    expect(output()).toContain('Written by server-agent');
    expect(output()).toContain('Prompt #2: "SERVER PROMPT TEXT"');
  });

  it('a card naming another prompt keeps the session but not the prompt', async () => {
    server.card = serverCard('session-agent', 5);
    await whyCommand('a.ts:1');
    expect(output()).toContain('Written by server-agent');
    expect(output()).not.toContain('SERVER PROMPT TEXT');
  });

  it('a card for another session is refused; the local proven answer stands', async () => {
    server.card = serverCard('someone-else');
    await whyCommand('a.ts:1');
    expect(server.asked).toEqual([x]);
    const out = output();
    expect(out).not.toContain('server-agent');
    expect(out).not.toContain('SERVER PROMPT TEXT');
    expect(out).toContain('Written by codex');
  });

  /** `origin why --trace` over these `file:line` frames; the JSON when asked for. */
  const runTrace = async (frames: string[], json: boolean) => {
    const tracePath = path.join(repo, '..', `trace-${path.basename(repo)}.log`);
    fs.writeFileSync(tracePath, ['Error: boom', ...frames.map((f, k) => `    at f${k} (${f}:1)`)].join('\n'));
    logs = [];
    try {
      await whyCommand('', { trace: tracePath, json });
    } finally {
      fs.rmSync(tracePath, { force: true });
    }
    return json ? JSON.parse(output()) : output();
  };

  it('why --trace: [AI] proven frames strictly, [AI~] committed frames with a usable card, uncommitted never sent', async () => {
    const y = git('rev-list', '-1', 'HEAD', '--', 'c.ts').trim();
    write('a.ts', rows(1, 4) + 'human tail\n');
    const h = commit('human');
    write('a.ts', rows(1, 4) + 'human tail\ndirty\n');
    server.cardFor = (sha) => (sha === x ? serverCard('session-agent', 2)
      : sha === y ? { ...serverCard('commit-session'), confidence: 'medium' } : null);
    const parsed = await runTrace(['a.ts:1', 'c.ts:1', 'a.ts:5', 'a.ts:6'], true);
    // The human frame asked its commit and got nothing; the dirty frame asked nothing.
    expect(server.asked).toEqual([x, y, h]);
    expect(parsed).toMatchObject({ serverLookups: 3, serverLookupLimitReached: false });
    expect(parsed.results.map((r: any) => [`${r.file}:${r.line}`, r.sha, r.attributionConfidence, r.confidence])).toEqual([
      ['a.ts:1', x, 'line', 'high'],
      ['c.ts:1', y, 'commit', 'medium'],
    ]);
    expect(parsed.results[0]).toMatchObject({ session: { id: 'session-agent' }, drifted: false });
    expect(parsed.results[1]).toMatchObject({ session: { id: 'commit-session' }, drifted: false });

    server.asked = [];
    const pretty = await runTrace(['a.ts:1', 'c.ts:1'], false);
    expect(pretty).toMatch(/\[AI\] +a\.ts:1/);
    expect(pretty).toMatch(/\[AI~\] c\.ts:1[\s\S]*commit-level · server attribution; local line proof unavailable/);
    expect(pretty.match(/local line proof unavailable/g)).toHaveLength(1);
  });

  it('why --trace: one budget of 50 server lookups for the whole trace; results found before it are kept', async () => {
    write('many.ts', rows(1, 60));
    commit('human, many lines');
    server.cardFor = (sha) => (sha === x ? serverCard('session-agent', 2) : null);
    const frames = ['a.ts:1', ...Array.from({ length: 60 }, (_, k) => `many.ts:${k + 1}`)];
    const parsed = await runTrace(frames, true);
    expect(server.asked).toHaveLength(50);
    expect(parsed).toMatchObject({ frames: 61, attributed: 1, serverLookups: 50, serverLookupLimitReached: true });
    expect(parsed.results.map((r: any) => [`${r.file}:${r.line}`, r.attributionConfidence])).toEqual([['a.ts:1', 'line']]);

    server.asked = [];
    const pretty = await runTrace(frames, false);
    expect(server.asked).toHaveLength(50);
    expect(pretty).toContain('Server lookup limit reached (50): later frames were not queried.');
    expect(pretty).toMatch(/\[AI\] +a\.ts:1/);
  });

  it('why --trace: a refused proven card walks no history; a non-proven frame finds an older high card, drifted', async () => {
    write('p.ts', 'old\n');
    const p0 = commit('human base');
    write('p.ts', 'new\n');
    const p1 = commit('agent');
    canonical(p1, [{ path: 'p.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
    const [c1, c2, c3] = rewrites('hist.ts', 3);
    server.cardFor = (sha) => (sha === p1 ? serverCard('someone-else') : sha === p0 ? serverCard('session-agent')
      : sha === c1 ? cardAt('s-old', 'high', 'older high') : null);
    const parsed = await runTrace(['p.ts:1', 'hist.ts:1'], true);
    expect(server.asked).toEqual([p1, c3, c2, c1]);
    expect(server.asked.filter((sha) => sha !== p1).length).toBeLessThanOrEqual(6);
    expect(parsed.results.map((r: any) => [`${r.file}:${r.line}`, r.sha, r.attributionConfidence, r.confidence, r.drifted])).toEqual([
      ['hist.ts:1', c3, 'commit', 'high', true],
    ]);
  });
});

describe('a claim keeps the identity of the record it was proven on', () => {
  it('a note replaced after the batch read changes nothing, and cannot re-prove the old claim', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 3 }] }], 'session-original');
    const resolved = resolveFileAtRevision({ repoPath: repo, targetRevision: x, targetPath: 'a.ts' });
    const [claim] = resolved.result.claims;
    expect(claim).toMatchObject({ start_line: 2, end_line: 3, contribution_index: 0 });

    // Same revision, same contribution index, a valid record — but it now
    // claims other lines for another session.
    const replaced = lineRecord(x, [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }] }], 'session-intruder');
    note(x, { attribution_record: replaced });
    expect(resolved.identityOf(claim)).toEqual({
      sessionId: 'session-original', agentId: 'codex', modelId: 'gpt-5.3-codex',
      recordFingerprint: expect.stringMatching(/^origin-record-fingerprint\/1:sha256:[0-9a-f]{64}$/),
    });
    expect(claimIdentity(JSON.stringify({ attribution_record: replaced }), claim)).toBeNull();
    // A claim this call did not produce gets nothing.
    expect(resolved.identityOf({ ...claim })).toBeNull();
    // And the next resolution answers from the replaced record alone.
    expect(kinds(getLineBlame(repo, 'a.ts'))).toEqual(['unknown', 'unknown', 'unknown', 'ai']);
    expect(getLineBlame(repo, 'a.ts')[3].sessionId).toBe('session-intruder');
  });
});

describe('origin diff labels added lines by tier', () => {
  let base: string;
  beforeEach(() => {
    write('a.ts', rows(1, 2));
    base = commit('human base');
    process.chdir(repo);
  });
  const diffJson = async (range: string) => {
    logs = [];
    await diffCommand(range, { json: true });
    return (JSON.parse(output()) as any[]).filter((l) => l.type === 'addition' || l.type === 'deletion');
  };

  it('a mixed commit: [AI] only on claimed additions, [AI~] on a legacy commit, the rest unknown or human by policy', async () => {
    write('a.ts', rows(1, 2) + 'ai one\nai two\nunclaimed\n');
    const x = commit('mixed agent commit');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 4 }] }]);
    write('a.ts', 'Row one\n' + rows(2, 2) + 'ai one\nai two\nunclaimed\nhuman line\n');
    const h = commit('human commit');
    write('b.ts', 'legacy line\n');
    const l = commit('legacy agent commit\n\nOrigin-Session: s');
    note(l, { origin: { sessionId: 'legacy', model: 'm' } });

    const lines = await diffJson(`${base}..HEAD`);
    expect(lines.map((d) => [d.type, d.content, d.authorship, d.commitSha])).toEqual([
      ['deletion', '-Row 1', 'unknown', null],
      ['addition', '+Row one', 'human', h],
      ['addition', '+ai one', 'ai', x],
      ['addition', '+ai two', 'ai', x],
      ['addition', '+unclaimed', 'unknown', x],
      ['addition', '+human line', 'human', h],
      ['addition', '+legacy line', 'ai', l],
    ]);
    expect(lines.map((d) => d.confidence)).toEqual([null, null, 'line', 'line', null, null, 'commit']);

    // --ai-only keeps both tiers, still told apart.
    logs = [];
    await diffCommand(`${base}..HEAD`, { json: true, aiOnly: true });
    const ai = (JSON.parse(output()) as any[]).filter((d) => d.type === 'addition');
    expect(ai.map((d) => [d.content, d.confidence])).toEqual([['+ai one', 'line'], ['+ai two', 'line'], ['+legacy line', 'commit']]);
  });

  it('pretty output tags [AI~] apart and never counts unknown as human', async () => {
    write('a.ts', rows(1, 2) + 'commit level\n');
    const x = commit('commit-level agent');
    canonical(x, null);
    write('b.ts', 'noted\n');
    const n = commit('human, but noted');
    note(n, { origin: { agent: 'Human' } });
    logs = [];
    await diffCommand(`${base}..HEAD`, {});
    const out = output();
    expect(out).toContain('[AI~] +commit level');
    expect(out).toContain('[??] +noted');
    expect(out).toContain('AI: +1 (50%) [AI] line-proven: +0, [AI~] commit-level: +1');
    expect(out).toContain('Human: +0 (0%)');
    expect(out).toContain('Unknown: +1 (50%)');
  });

  it('a ref against the working tree uses the disk view: uncommitted additions are unknown', async () => {
    write('a.ts', rows(1, 2) + 'ai one\n');
    const x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }] }]);
    write('a.ts', 'dirty top\n' + rows(1, 2) + 'ai one\n');
    const lines = await diffJson(base);
    expect(lines.map((d) => [d.content, d.authorship])).toEqual([['+dirty top', 'unknown'], ['+ai one', 'ai']]);
  });

  it('a range ending at a commit is viewed at that commit; a bare ref is diffed against the working tree', async () => {
    write('a.ts', rows(1, 2) + 'ai one\n');
    const x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }] }]);
    write('a.ts', 'shift\n' + rows(1, 2) + 'ai one\n');
    commit('human shift');
    const lines = await diffJson(x);
    // `git diff <x>` is x against the working tree (clean = HEAD): shifted, still proven.
    expect(lines.map((d) => [d.content, d.authorship])).toEqual([['+shift', 'human']]);
    const shown = await diffJson(`${base}..${x}`);
    expect(shown.map((d) => [d.content, d.authorship])).toEqual([['+ai one', 'ai']]);
  });
});

describe('acceptance follows the source claim, never the old line number', () => {
  let base: string;
  beforeEach(() => {
    write('keep.txt', 'base\n');
    base = commit('base');
  });
  /** A canonical record whose legacy payload names the same model, so per-model stats see it. */
  const agentNote = (sha: string, files: Array<{ path: string; ranges: Range[] }>) => {
    const rec = lineRecord(sha, files);
    expect(validateFull(rec).ok).toBe(true);
    note(sha, { origin: { sessionId: 'session-agent', model: 'gpt-5.3-codex', agent: 'codex' }, attribution_record: rec });
  };
  const fates = () => computeAcceptanceMetrics(repo, `${base}..HEAD`);

  it('an insertion above the range: both claimed lines accepted at their new place', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    agentNote(x, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 3 }] }]);
    write('a.ts', 'inserted\ninserted\n' + rows(1, 4));
    commit('human inserts above');
    // The old raw comparison read HEAD lines 2-3 ("inserted", "Row 1") here.
    expect(fates()).toEqual({ totalAiLines: 2, acceptedLines: 2, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: 1 });
  });

  it('a rename keeps the claims', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    agentNote(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 4 }] }]);
    git('mv', 'a.ts', 'b.ts');
    commit('rename');
    expect(fates()).toMatchObject({ totalAiLines: 4, acceptedLines: 4, acceptanceRate: 1 });
  });

  it('a human rewrite overrides only the rewritten line; a deleted file deletes its lines', () => {
    write('a.ts', rows(1, 4));
    write('gone.ts', rows(1, 2));
    const x = commit('agent');
    agentNote(x, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 3 }] }, { path: 'gone.ts', ranges: [{ start_line: 1, end_line: 2 }] }]);
    write('a.ts', rows(1, 4).replace('Row 2\n', 'Row two\n'));
    git('rm', '-q', 'gone.ts');
    commit('human rewrites one line and deletes a file');
    expect(fates()).toEqual({ totalAiLines: 4, acceptedLines: 1, overriddenLines: 1, deletedLines: 2, unknownLines: 0, acceptanceRate: 0.25 });
  });

  it('one of two identical claimed lines deleted: neither is called accepted or overridden', () => {
    write('d.ts', 'start\nx = 1\nx = 1\nend\n');
    const x = commit('agent');
    agentNote(x, [{ path: 'd.ts', ranges: [{ start_line: 2, end_line: 3 }] }]);
    write('d.ts', 'start\nx = 1\nend\n');
    commit('human deletes one');
    expect(fates()).toEqual({ totalAiLines: 2, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 2, acceptanceRate: null });
  });

  it('per model: the same fates, and no invented 100% when nothing is known', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    agentNote(x, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 3 }] }]);
    write('a.ts', 'inserted\n' + rows(1, 4).replace('Row 3\n', 'Row three\n'));
    commit('human');
    const stats = computeAttributionStats(repo, `${base}..HEAD`);
    expect(stats.byModel.get('gpt-5.3-codex')).toMatchObject({ acceptedLines: 1, overriddenLines: 1, deletedLines: 0, unknownLines: 0, acceptanceRate: 0.5 });
    expect(stats.acceptance).toMatchObject({ totalAiLines: 2, acceptedLines: 1, overriddenLines: 1, acceptanceRate: 0.5 });

    write('d.ts', 'x = 1\nx = 1\n');
    const y = commit('agent duplicates');
    agentNote(y, [{ path: 'd.ts', ranges: [{ start_line: 1, end_line: 2 }] }]);
    write('d.ts', 'x = 1\n');
    commit('human');
    const onlyUnknown = computeAttributionStats(repo, `${x}..HEAD`);
    expect(onlyUnknown.acceptance).toMatchObject({ totalAiLines: 2, unknownLines: 2, acceptanceRate: null });
    expect(onlyUnknown.byModel.get('gpt-5.3-codex')).toMatchObject({ unknownLines: 2, acceptanceRate: null });
  });

  it('a commit-wide AI commit without a canonical claim tracks nothing', () => {
    write('a.ts', rows(1, 2));
    const x = commit('agent\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    note(x, { origin: { sessionId: 'legacy', model: 'gpt-5.3-codex' } });
    expect(fates()).toMatchObject({ totalAiLines: 0, acceptanceRate: null });
    expect(computeAttributionStats(repo, `${base}..HEAD`).byModel.get('gpt-5.3-codex')).toMatchObject({ acceptedLines: 0, overriddenLines: 0, acceptanceRate: null });
  });
});

// ─── Revision 2 of checkpoint 2 ─────────────────────────────────────────────

describe('origin why without a usable server card never guesses the prompt', () => {
  let x: string;
  beforeEach(() => {
    connected.on = true;
    write('a.ts', rows(1, 4));
    x = commit('agent');
    note(x, {
      origin: { sessionId: 'session-agent', model: 'gpt-5.3-codex', agent: 'codex', promptSummary: 'LEGACY SESSION SUMMARY' },
      attribution_record: record2(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: 2 }, { start_line: 3, end_line: 3 }] }]),
    });
    process.chdir(repo);
  });
  function record2(sha: string, files: Array<{ path: string; ranges: Range[] }>) {
    const rec = lineRecord(sha, files);
    expect(validateFull(rec).ok).toBe(true);
    return rec;
  }
  const prompt = (promptIndex: number, promptText: string) =>
    ({ promptIndex, promptText, filesChanged: ['a.ts'], diff: '@@ -0,0 +1,4 @@\n+Row 1\n+Row 2\n+Row 3\n+Row 4\n' });

  it('a single session prompt with another index is not shown, and the session-wide prompt neither', async () => {
    server.session = { promptChanges: [prompt(0, 'ONLY PROMPT OF THE SESSION')], prompt: 'SESSION-WIDE PROMPT' };
    await whyCommand('a.ts:1');
    const out = output();
    expect(out).toContain('Prompt #2: not available from Origin');
    for (const leaked of ['ONLY PROMPT OF THE SESSION', 'SESSION-WIDE PROMPT', 'LEGACY SESSION SUMMARY']) expect(out).not.toContain(leaked);
  });

  it('several prompts, one whose diff contains the line: only the exact canonical iteration is shown', async () => {
    server.card = { session: { id: 'someone-else' }, prompt: { index: 2, text: 'REJECTED CARD PROMPT' } };
    server.session = { promptChanges: [prompt(0, 'DIFF-MATCHING PROMPT'), prompt(2, 'EXACT ITERATION PROMPT'), prompt(3, 'LATER PROMPT')] };
    await whyCommand('a.ts:1');
    const out = output();
    expect(out).toContain('Prompt #2: "EXACT ITERATION PROMPT"');
    for (const leaked of ['DIFF-MATCHING PROMPT', 'LATER PROMPT', 'REJECTED CARD PROMPT']) expect(out).not.toContain(leaked);
  });

  it('two platform rows with the claimed index are not told apart: no prompt', async () => {
    server.session = { promptChanges: [prompt(2, 'TWIN ONE'), prompt(2, 'TWIN TWO')] };
    await whyCommand('a.ts:1');
    expect(output()).not.toMatch(/TWIN (ONE|TWO)/);
    expect(output()).toContain('Prompt #2: not available from Origin');
  });

  it('a claim that names no iteration shows the session only, whatever the platform has', async () => {
    server.session = { promptChanges: [prompt(0, 'ONLY PROMPT OF THE SESSION')] };
    await whyCommand('a.ts:3');
    const out = output();
    expect(out).toContain('Session session-');
    expect(out).toContain('Prompt: not recorded for this line');
    expect(out).not.toContain('ONLY PROMPT OF THE SESSION');
  });

  it('offline, the legacy note summary of the same session is not shown as the line prompt', async () => {
    connected.on = false;
    await whyCommand('a.ts:1');
    expect(output()).toContain('Session session-');
    expect(output()).not.toContain('LEGACY SESSION SUMMARY');
  });
});

describe('per-model acceptance comes from the canonical contribution', () => {
  it('a note with only a canonical record: overall and byModel see the same fates', () => {
    write('keep.txt', 'base\n');
    const base = commit('base');
    write('a.ts', rows(1, 4));
    const x = commit('agent, canonical record only');
    note(x, { attribution_record: lineRecord(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 4 }] }]) });
    write('a.ts', rows(1, 4).replace('Row 4\n', 'Row four\n'));
    commit('human');
    const stats = computeAttributionStats(repo, `${base}..HEAD`);
    const fates = { acceptedLines: 3, overriddenLines: 1, deletedLines: 0, unknownLines: 0, acceptanceRate: 0.75 };
    expect(stats.acceptance).toMatchObject({ totalAiLines: 4, ...fates });
    expect(stats.byModel.get('gpt-5.3-codex')).toMatchObject({ commits: 0, linesAdded: 0, ...fates });
  });
});

describe('declared claim ranges are bounded before they are walked', () => {
  let base: string;
  beforeEach(() => {
    write('keep.txt', 'base\n');
    base = commit('base');
  });
  const claim = (end: number, file = 'a.ts') => {
    write(file, rows(1, 4));
    const x = commit('agent');
    const rec = lineRecord(x, [{ path: file, ranges: [{ start_line: 1, end_line: end }] }]);
    expect(validateFull(rec).ok).toBe(true);
    note(x, { origin: { sessionId: 'session-agent', model: 'gpt-5.3-codex' }, attribution_record: rec });
    return x;
  };

  it('a schema-valid end_line of 2^53 − 1 is unavailable at once: no partial metrics', () => {
    claim(Number.MAX_SAFE_INTEGER);
    const started = performance.now();
    const m = computeAcceptanceMetrics(repo, `${base}..HEAD`);
    const stats = computeAttributionStats(repo, `${base}..HEAD`);
    expect(performance.now() - started).toBeLessThan(5_000);
    const unavailable = { totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null, unavailable: 'too_many_claim_lines' };
    expect(m).toEqual(unavailable);
    expect(stats.acceptance).toEqual(unavailable);
    expect(stats.byModel.get('gpt-5.3-codex')).toMatchObject({ acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null });
  });

  it('declared lines just past the bound across commits are unavailable too', () => {
    claim(MAX_TRACKED_CLAIM_LINES - 2, 'a.ts');
    claim(3, 'b.ts');
    expect(computeAcceptanceMetrics(repo, `${base}..HEAD`)).toMatchObject({ unavailable: 'too_many_claim_lines', acceptanceRate: null });
  });

  it('a range past the end of its source blob, within the bound, is tracked as unknown only', () => {
    claim(10);
    expect(computeAcceptanceMetrics(repo, `${base}..HEAD`)).toEqual({
      totalAiLines: 10, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 10, acceptanceRate: null,
    });
  });
});

// ─── Revision 3 of checkpoint 2 ─────────────────────────────────────────────

describe('origin compare and origin verify --json carry the whole acceptance object', () => {
  let base: string;
  beforeEach(() => {
    write('keep.txt', 'base\n');
    base = commit('base');
    process.chdir(repo);
  });
  const agentCommit = (end: number, file: string) => {
    write(file, rows(1, 4));
    const x = commit('agent');
    note(x, { origin: { sessionId: 'session-agent', model: 'gpt-5.3-codex' }, attribution_record: lineRecord(x, [{ path: file, ranges: [{ start_line: 1, end_line: end }] }]) });
  };
  const json = async (run: () => Promise<void>) => { logs = []; await run(); return JSON.parse(output()); };
  /**
   * verify reads the default range, HEAD~50..HEAD: pad the history to exactly
   * 51 commits, so HEAD~50 exists (it is `base`) and every later commit is in range.
   */
  const padHistory = () => {
    const have = Number(git('rev-list', '--count', 'HEAD').trim());
    for (let i = have; i < 51; i++) commit(`pad ${i}`);
    expect(git('rev-parse', 'HEAD~50').trim()).toBe(base);
  };

  it('a normal result', async () => {
    agentCommit(4, 'a.ts');
    write('a.ts', rows(1, 4).replace('Row 4\n', 'Row four\n'));
    commit('human');
    const expected = { totalAiLines: 4, acceptedLines: 3, overriddenLines: 1, deletedLines: 0, unknownLines: 0, acceptanceRate: 0.75 };

    const compared = await json(() => compareCommand(`${base}..HEAD`, undefined, { json: true }));
    expect(compared.acceptance).toEqual(expected);

    padHistory();
    const verified = await json(() => verifyCommand({ json: true }));
    expect(verified.attribution.acceptance).toEqual(expected);
  });

  it('a bounded failure says unavailable, not "no claims"', async () => {
    agentCommit(Number.MAX_SAFE_INTEGER, 'a.ts');
    const expected = {
      totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0,
      acceptanceRate: null, unavailable: 'too_many_claim_lines',
    };

    const compared = await json(() => compareCommand(`${base}..HEAD`, undefined, { json: true }));
    expect(compared.acceptance).toEqual(expected);

    padHistory();
    const verified = await json(() => verifyCommand({ json: true }));
    expect(verified.attribution.acceptance).toEqual(expected);
  });

  it('no canonical claims at all: an empty, available acceptance', async () => {
    commit('nothing claimed');
    const compared = await json(() => compareCommand(`${base}..HEAD`, undefined, { json: true }));
    expect(compared.acceptance).toEqual({ totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null });
    expect('unavailable' in compared.acceptance).toBe(false);
  });
});

// ─── CR1: the commit-confidence tier ────────────────────────────────────────

/** [authorship, confidence, sessionId, unknownReason] of each line. */
const tiers = (lines: Array<{ authorship: string; confidence?: string; sessionId?: string; unknownReason?: string }>) =>
  lines.map((l) => [l.authorship, l.confidence ?? null, l.sessionId ?? null, l.unknownReason ?? null]);

describe('CR1: commit evidence, by precedence', () => {
  it('a commit-level record of several contributions is [AI~] with no session, agent or model picked', () => {
    write('multi.ts', 'one\ntwo\n');
    const m = commit('two agents, one commit');
    const rec = lineRecord(m, null, 'session-a');
    rec.contributions.push({ evidence: 'session_capture', agent: { id: 'claude-code' }, model: { id: 'claude-opus-4-6' }, session: { id: 'session-b' } } as any);
    expect(validateFull(rec).ok).toBe(true);
    note(m, { origin: { sessionId: 'legacy-session', model: 'legacy-model' }, attribution_record: rec });
    expect(getLineBlame(repo, 'multi.ts')).toEqual([1, 2].map((n) => ({ lineNumber: n, authorship: 'ai', confidence: 'commit', author: 'Hannah Human', commitSha: m })));

    // Two contributions of ONE agent (a session id may name only one
    // contribution, rule S2): the shared agent stays; the session one of them
    // lacks and the differing model do not.
    write('same.ts', 'one\n');
    const s1 = commit('one agent, two models');
    const rec2 = lineRecord(s1, null, 'session-a');
    rec2.contributions.push({ evidence: 'imported', agent: { id: 'codex' }, model: { id: 'gpt-5.5' } } as any);
    expect(validateFull(rec2).ok).toBe(true);
    note(s1, { attribution_record: rec2 });
    expect(getLineBlame(repo, 'same.ts')[0]).toMatchObject({ authorship: 'ai', confidence: 'commit', agent: 'codex' });
    expect(getLineBlame(repo, 'same.ts')[0].sessionId).toBeUndefined();
    expect(getLineBlame(repo, 'same.ts')[0].model).toBeUndefined();
  });

  it('a squash aggregate of several sessions is [AI~] without a session', () => {
    write('sq.ts', 'one\n');
    const q = commit('squash');
    note(q, { origin: { version: 1, squashMerge: true, sessionIds: ['s1', 's2'], models: ['m1', 'm2'] } });
    expect(tiers(getLineBlame(repo, 'sq.ts'))).toEqual([['ai', 'commit', null, null]]);
  });

  it('a line-level record that claims the blamed line but cannot re-anchor it gives [AI~], not [AI]', () => {
    write('d.ts', 'start\nx = 1\nend\n');
    const d = commit('agent');
    canonical(d, [{ path: 'd.ts', ranges: [{ start_line: 2, end_line: 2 }] }]);
    // A later human commit duplicates the claimed line: blame still names d, the alignment cannot pin it.
    write('d.ts', 'start\nx = 1\nx = 1\nend\n');
    commit('human duplicate');
    const lines = getLineBlame(repo, 'd.ts', { view: 'head' });
    const fromD = lines.filter((l) => l.commitSha === d);
    expect(fromD.map((l) => l.confidence)).not.toContain('line');
    expect(fromD.some((l) => l.authorship === 'ai' && l.confidence === 'commit' && l.sessionId === 'session-agent')).toBe(true);
  });

  it('a broken, foreign or other-revision record is not evidence: unknown — unless the message is', () => {
    write('bad.ts', 'one\n');
    const b = commit('malformed record');
    note(b, { origin: { sessionId: 'legacy-beside-a-broken-record' }, attribution_record: { schema_version: '1.0', revision: { vcs: 'git', id: b } } });
    expect(tiers(getLineBlame(repo, 'bad.ts'))).toEqual([['unknown', null, null, 'record_invalid']]);

    write('other.ts', 'one\n');
    const o = commit('a record of another revision');
    note(o, { attribution_record: lineRecord('f'.repeat(40), null) });
    expect(tiers(getLineBlame(repo, 'other.ts'))).toEqual([['unknown', null, null, 'record_wrong_revision']]);

    write('garbage.ts', 'one\n');
    const g = commit('not json');
    git('notes', '--ref=origin', 'add', '-f', '-m', 'not json at all', g);
    expect(tiers(getLineBlame(repo, 'garbage.ts'))).toEqual([['unknown', null, null, 'no_record']]);

    // Independent evidence still counts: a trailer on a commit whose record is broken.
    write('bad2.ts', 'one\n');
    const t = commit('agent\n\nOrigin-Session: trailer-session');
    note(t, { attribution_record: { schema_version: '1.0' } });
    expect(tiers(getLineBlame(repo, 'bad2.ts'))).toEqual([['ai', 'commit', 'trailer-session', null]]);
  });
});

describe('R3: an active session owns only the commits its state recorded', () => {
  let base: string;
  let manual: string;
  beforeEach(() => {
    write('base.ts', rows(1, 2));
    base = commit('human base, where the session started');
    write('manual.ts', rows(1, 2));
    manual = commit('pulled human work, after the session started');
  });
  const human = (sha: string) => [1, 2].map((n) => ({ lineNumber: n, authorship: 'human', author: 'Hannah Human', commitSha: sha }));

  it('neither its start commit nor a later commit it did not record is its evidence', () => {
    activeSessions.list = [{ headShaAtStart: base, sessionId: 'long-review', model: 'live-model', sessionCommitShas: [] }];
    expect(getLineBlame(repo, 'base.ts')).toEqual(human(base));
    expect(getLineBlame(repo, 'manual.ts')).toEqual(human(manual));
    // Abbreviated, overlong, non-hex, zero and malformed entries name no commit.
    const zero = '0'.repeat(40);
    activeSessions.list = [{
      headShaAtStart: base, sessionId: 'long-review',
      sessionCommitShas: [manual.slice(0, 12), `${manual}a`, `${manual.slice(0, 39)}g`, zero, 'not a sha', 7 as any],
    }];
    expect(getLineBlame(repo, 'manual.ts')).toEqual(human(manual));
  });

  it('an exact recorded SHA is [AI~] with that session; recorded by two sessions, with none picked', () => {
    activeSessions.list = [
      { headShaAtStart: base, sessionId: 'maker', model: 'live-model', sessionCommitShas: [manual, manual] },
      { headShaAtStart: base, sessionId: 'bystander', model: 'other-model', sessionCommitShas: [] },
    ];
    expect(getLineBlame(repo, 'manual.ts')).toEqual([1, 2].map((n) => ({
      lineNumber: n, authorship: 'ai', confidence: 'commit', sessionId: 'maker', model: 'live-model', author: 'Hannah Human', commitSha: manual,
    })));
    expect(getLineBlame(repo, 'base.ts')).toEqual(human(base));

    // An upper-case copy is the same object id: the same owner, and one claim
    // with its lower-case twin, not two.
    for (const recorded of [[manual.toUpperCase()], [manual.toUpperCase(), manual]]) {
      activeSessions.list = [
        { headShaAtStart: base, sessionId: 'maker', model: 'live-model', sessionCommitShas: recorded },
        { headShaAtStart: base, sessionId: 'bystander', model: 'other-model', sessionCommitShas: [] },
      ];
      expect(getLineBlame(repo, 'manual.ts')).toEqual([1, 2].map((n) => ({
        lineNumber: n, authorship: 'ai', confidence: 'commit', sessionId: 'maker', model: 'live-model', author: 'Hannah Human', commitSha: manual,
      })));
    }

    activeSessions.list = [
      { headShaAtStart: base, sessionId: 'one', model: 'm1', sessionCommitShas: [manual] },
      { headShaAtStart: base, sessionId: 'two', model: 'm2', sessionCommitShas: [manual] },
    ];
    expect(getLineBlame(repo, 'manual.ts')).toEqual([1, 2].map((n) => ({
      lineNumber: n, authorship: 'ai', confidence: 'commit', author: 'Hannah Human', commitSha: manual,
    })));
  });

  it('a trailer-only commit stays [AI~] when no active state lists it', () => {
    write('trailer.ts', rows(1, 2));
    const t = commit('agent work\n\nOrigin-Session: trailer-session');
    activeSessions.list = [{ headShaAtStart: base, sessionId: 'long-review', sessionCommitShas: [manual] }];
    expect(tiers(getLineBlame(repo, 'trailer.ts'))).toEqual([1, 2].map(() => ['ai', 'commit', 'trailer-session', null]));
  });
});

describe('CR1: a late timeout keeps what earlier phases decided', () => {
  it('proven lines and commits already classified survive; only the undecided remainder times out', () => {
    write('a.ts', 'base\n');
    const h = commit('human base');
    write('a.ts', 'base\nproven\n');
    const x = commit('agent, line claim');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2 }] }]);
    write('a.ts', 'base\nproven\ncommit level\n');
    const c = commit('agent, commit-level');
    canonical(c, null, 'session-commit');
    write('a.ts', 'base\nproven\ncommit level\ntrailer\n');
    const t = commit('agent\n\nOrigin-Session: session-trailer');

    // Without a clock: the base line is human.
    expect(tiers(getLineBlame(repo, 'a.ts'))).toEqual([
      ['human', null, null, null],
      ['ai', 'line', 'session-agent', null],
      ['ai', 'commit', 'session-commit', null],
      ['ai', 'commit', 'session-trailer', null],
    ]);

    // The budget runs out in the last phase, the active-session check: even an
    // exact claim read past it decides nothing.
    let expired = false;
    activeSessions.list = [{ headShaAtStart: h, sessionId: 'late', sessionCommitShas: [h, t] }];
    activeSessions.onList = () => { expired = true; };
    const lines = getLineBlame(repo, 'a.ts', { deadline: { at: 1e9, now: () => (expired ? 2e9 : 0) } });
    expect(tiers(lines)).toEqual([
      ['unknown', null, null, 'timeout'],
      ['ai', 'line', 'session-agent', null],
      ['ai', 'commit', 'session-commit', null],
      ['ai', 'commit', 'session-trailer', null],
    ]);
    expect(lines[0]).toMatchObject({ commitSha: h });
    expect(lines.map((l) => l.commitSha)).toEqual([h, x, c, t]);
  });
});

describe('CR1: files past the line-proof bounds get commit evidence only', () => {
  const bigRows = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i + 1}`);
  let h: string;
  let x: string;
  let t: string;
  beforeEach(() => {
    write('big.ts', bigRows(4100).join('\n') + '\n');
    h = commit('human base');
    const agent = bigRows(4100);
    for (const k of [9, 10, 11, 12]) agent[k] = `agent ${k + 1}`;
    write('big.ts', agent.join('\n') + '\n');
    x = commit('agent');
    canonical(x, [{ path: 'big.ts', ranges: [{ start_line: 10, end_line: 12 }] }]);
    agent[19] = 'trailer line';
    write('big.ts', agent.join('\n') + '\n');
    t = commit('agent again\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  });

  it('more than 4000 lines: a commit-level AI / human mix, never line confidence', () => {
    for (const view of ['head', 'worktree'] as const) {
      const r = resolveLineAttribution(repo, 'big.ts', { view })!;
      expect(r.lines).toHaveLength(4100);
      expect(r.lines.some((l) => l.confidence === 'line')).toBe(false);
      expect(r.lines[0]).toEqual({ lineNumber: 1, authorship: 'human', author: 'Hannah Human', commitSha: h });
      // Claimed by the record, but no alignment runs here: commit-level.
      expect(tiers(r.lines.slice(9, 13))).toEqual([
        ['ai', 'commit', 'session-agent', null], ['ai', 'commit', 'session-agent', null], ['ai', 'commit', 'session-agent', null],
        ['unknown', null, null, 'no_line_claim'],
      ]);
      expect(r.lines[19]).toMatchObject({ authorship: 'ai', confidence: 'commit', agent: 'claude-code', commitSha: t });
    }
  });

  it('the worktree view numbers the disk text: an uncommitted line shifts the rest', () => {
    write('big.ts', 'dirty top\n' + fs.readFileSync(path.join(repo, 'big.ts'), 'utf-8'));
    const r = resolveLineAttribution(repo, 'big.ts')!;
    expect(r.text.startsWith('dirty top\n')).toBe(true);
    expect(r.lines).toHaveLength(4101);
    expect(r.lines[0]).toEqual({ lineNumber: 1, authorship: 'unknown', unknownReason: 'uncommitted' });
    expect(r.lines[10]).toMatchObject({ lineNumber: 11, authorship: 'ai', confidence: 'commit', commitSha: x });
    expect(r.lines[1]).toMatchObject({ authorship: 'human', commitSha: h });
  });

  it('more than 1 MiB in few lines: the same commit-only answer', () => {
    const wide = (k: number, tag = '') => `${String(k).padStart(4, '0')}${tag} ${'w'.repeat(4000)}`;
    write('wide.ts', Array.from({ length: 300 }, (_, k) => wide(k)).join('\n') + '\n');
    const base = commit('human wide');
    const changed = Array.from({ length: 300 }, (_, k) => wide(k, k === 4 ? ' agent' : ''));
    write('wide.ts', changed.join('\n') + '\n');
    const l = commit('agent, legacy');
    note(l, { origin: { sessionId: 'legacy-wide', model: 'm', agent: 'codex' } });
    expect(Buffer.byteLength(fs.readFileSync(path.join(repo, 'wide.ts')))).toBeGreaterThan(1024 * 1024);
    const lines = getLineBlame(repo, 'wide.ts', { view: 'head' });
    expect(lines).toHaveLength(300);
    expect(lines[4]).toMatchObject({ authorship: 'ai', confidence: 'commit', sessionId: 'legacy-wide', commitSha: l });
    expect(lines[0]).toMatchObject({ authorship: 'human', commitSha: base });
    expect(lines.some((x) => x.confidence === 'line')).toBe(false);
  });

  it('an untracked text past the line bound is all uncommitted, never blame_unreadable', () => {
    write('untracked.ts', bigRows(4100).join('\n') + '\n');
    const lines = getLineBlame(repo, 'untracked.ts');
    expect(lines).toHaveLength(4100);
    expect(new Set(lines.map((l) => `${l.authorship}:${l.unknownReason}`))).toEqual(new Set(['unknown:uncommitted']));
  });

  it('a disk file past the bounds over a small HEAD: its claimed lines are commit-level there, proven at HEAD', () => {
    write('small.ts', rows(1, 10));
    const s = commit('agent small');
    canonical(s, [{ path: 'small.ts', ranges: [{ start_line: 2, end_line: 3 }] }]);
    write('small.ts', rows(1, 10) + bigRows(4100).map((r) => `tail ${r}`).join('\n') + '\n');
    expect(tiers(getLineBlame(repo, 'small.ts', { view: 'head' }).slice(1, 3))).toEqual([['ai', 'line', 'session-agent', null], ['ai', 'line', 'session-agent', null]]);
    const wt = getLineBlame(repo, 'small.ts');
    expect(wt).toHaveLength(4110);
    expect(tiers(wt.slice(1, 3))).toEqual([['ai', 'commit', 'session-agent', null], ['ai', 'commit', 'session-agent', null]]);
    expect(wt[10]).toEqual({ lineNumber: 11, authorship: 'unknown', unknownReason: 'uncommitted' });
  });

  it('each cap of the commit-only path, once passed, answers unknown or no view — never a partial guess', () => {
    const reasons = (lines: Array<{ authorship: string; unknownReason?: string }>) => new Set(lines.map((l) => `${l.authorship}:${l.unknownReason}`));
    expect(reasons(getLineBlame(repo, 'big.ts', { commitOnlyLimits: { maxLines: 4000 } }))).toEqual(new Set(['unknown:oversized']));
    expect(reasons(getLineBlame(repo, 'big.ts', { commitOnlyLimits: { maxBlameBytes: 256 } }))).toEqual(new Set(['unknown:blame_unreadable']));
    expect(getLineBlame(repo, 'big.ts', { commitOnlyLimits: { maxBlameBytes: 256 } })).toHaveLength(4100);
    // The 'head' view reads HEAD's blob only within its cap; past it there is no view.
    expect(resolveLineAttribution(repo, 'big.ts', { view: 'head', commitOnlyLimits: { maxTextBytes: 1024 } })).toBeNull();
    // A binary large file stays unknown.
    write('bin.dat', 'x'.repeat(1024 * 1024) + '\u0000' + 'y\n');
    commit('binary');
    expect(reasons(getLineBlame(repo, 'bin.dat'))).toEqual(new Set(['unknown:non_text']));
  });
});

describe('CR1: consumers show the split and keep strict gates strict', () => {
  let x: string;
  let c: string;
  let h: string;
  beforeEach(() => {
    write('a.ts', rows(1, 4));
    x = commit('agent');
    canonical(x, [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
    write('a.ts', rows(1, 4) + 'commit level tail\n');
    c = commit('agent, commit-level');
    canonical(c, null, 'session-commit');
    write('a.ts', rows(1, 4) + 'commit level tail\nhuman tail\n');
    h = commit('human');
  });

  it('the resolver: [AI] on the claim, [AI~] on the commit-level line, the uncovered lines unknown', () => {
    expect(tiers(getLineBlame(repo, 'a.ts'))).toEqual([
      ['ai', 'line', 'session-agent', null],
      ['unknown', null, null, 'no_line_claim'], ['unknown', null, null, 'no_line_claim'], ['unknown', null, null, 'no_line_claim'],
      ['ai', 'commit', 'session-commit', null],
      ['human', null, null, null],
    ]);
  });

  it('origin blame --json names the confidence; the sessions map stays line-proven only', async () => {
    process.chdir(repo);
    await blameCommand('a.ts', { json: true });
    const parsed = JSON.parse(output());
    expect(parsed.lines.map((l: any) => [l.authorship, l.confidence ?? null])).toEqual([
      ['ai', 'line'], ['unknown', null], ['unknown', null], ['unknown', null], ['ai', 'commit'], ['human', null],
    ]);
    expect(parsed.lines[4]).toMatchObject({ sessionId: 'session-commit', content: 'commit level tail' });
    expect(Object.keys(parsed.sessions)).not.toContain('session-commit');
  });

  it('origin blame pretty tags [AI~] and splits the AI total', async () => {
    process.chdir(repo);
    await blameCommand('a.ts', {});
    const out = output();
    expect(out).toMatch(/\[AI~\].*commit level tail/);
    expect(out).toContain('AI: 2 (33%) [AI] line-proven: 1, [AI~] commit-level: 1');
    expect(out).toContain('Unknown: 3 (50%)');
  });

  it('origin why <file> and <file>:<line> never call a commit-level line line-proven', async () => {
    process.chdir(repo);
    await whyCommand('a.ts');
    let out = output();
    expect(out).toContain('33% AI (2) [1 line-proven, 1 commit-level attribution — no line-level proof]');
    expect(out).toMatch(/1 lines\s+17%\s+session session-\s+\(commit-level attribution, no line-level proof\)/);
    logs = [];
    await whyCommand('a.ts:5');
    out = output();
    expect(out).toContain('commit-level attribution');
    expect(out).toContain('no line-level proof');
    expect(out).not.toContain('Written by');
    expect(out).not.toContain('Prompt');
  });

  it('file and commit attribution keep the AI total and add the split; acceptance tracks only line claims', () => {
    expect(computeFileAttribution(repo, 'a.ts')).toMatchObject({
      totalLines: 6, aiLines: 2, lineProvenAiLines: 1, commitConfidenceAiLines: 1, humanLines: 1, unknownLines: 3,
    });
    expect(computeCommitAttribution(repo, c)).toMatchObject({ aiLines: 2, lineProvenAiLines: 1, commitConfidenceAiLines: 1 });
    expect(computeAcceptanceMetrics(repo, `${x}..HEAD`)).toEqual({
      totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null,
    });
  });

  it('the hook context says commit-level for [AI~] ranges', () => {
    const ctx = buildFileAttributionContext(repo, path.join(repo, 'a.ts'))!;
    expect(ctx).toContain('33% AI-generated (2/6 lines — 1 line-proven, 1 commit-level attribution (no line-level proof))');
    expect(ctx).toContain('Line 5: codex (gpt-5.3-codex) — commit-level attribution, no line-level proof');
    expect(ctx).toContain('Line 1: codex (gpt-5.3-codex)\n');
  });

  it('pre-review counts [AI~] apart and takes sessions from proven lines only', () => {
    const summary = summarizeBlame('a.ts', getLineBlame(repo, 'a.ts'));
    expect(summary).toEqual({ file: 'a.ts', aiLines: 2, commitLevelAiLines: 1, humanLines: 1, mixedLines: 0, unknownLines: 3, sessionIds: ['session-agent'] });
    const prompt = buildReviewPrompt({ base: 'main', diff: '', files: [summary], sessions: new Map() });
    expect(prompt.user).toContain('AI lines: 2 (1 line-proven, 1 commit-level attribution — no line-level proof)');
  });

  it('Agent Trace exports [AI~] as unknown: no session range, nothing an import could turn into a claim', () => {
    // A dirty file puts a.ts in the export's scope; its ranges are HEAD's.
    write('a.ts', rows(1, 4) + 'commit level tail\nhuman tail\ndirty\n');
    const trace = exportAgentTrace(repo);
    const file = trace.files.find((f) => f.path === 'a.ts')!;
    expect(file.conversations.map((cv) => [cv.url, cv.contributor.type, cv.ranges])).toEqual([
      ['origin://session/session-agent', 'ai', [{ start_line: 1, end_line: 1 }]],
      ['origin://unknown', 'unknown', [{ start_line: 2, end_line: 5 }]],
      ['origin://unknown', 'human', [{ start_line: 6, end_line: 6 }]],
    ]);
    expect(JSON.stringify(exportAgentTrace(repo, 'session-commit'))).not.toContain('session-commit');

    importAgentTrace(repo, { ...trace, vcs: { type: 'git', revision: h } });
    const imported = JSON.parse(git('notes', '--ref=origin', 'show', h)).origin.attribution.files['a.ts'];
    expect(imported.aiLines).toEqual([1]);
    expect(imported.humanLines).toEqual([6]);
  });
});
