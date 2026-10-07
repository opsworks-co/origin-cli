import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { splitMarkersByTurn, markersOfCommitTurns, readMarkerTurns } from '../origin-markers.js';
import { commitEvidence, commitTurnDecisions, committedSessionMarkers, withTurnDiffs } from '../committed-markers.js';
import { writeCommitMemory, writeSessionMemory, type CommitMemoryEntry, type SessionMemoryEntry } from '../memory.js';

// Claude Code JSONL, the shape of session 46b82050 (2026-09-30 → 10-01): a
// design tried on localhost with a decision about it, the user rejecting it
// ("commit only video change, design change is not approved"), then commits
// that never touched the design. The design's decision used to be recorded on
// every one of those commits.
const user = (ts: string, text: string) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const said = (ts: string, text: string) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolResult = (ts: string) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '[Origin: Decision] read from a file' }] }, toolUseResult: {} });
const meta = (ts: string) => JSON.stringify({ type: 'user', isMeta: true, timestamp: ts, message: { role: 'user', content: 'reminder' } });

const transcript = [
  user('2026-09-30T20:49:01Z', 'go with C, build it on the landing page on localhost'),
  toolResult('2026-09-30T20:50:00Z'),
  said('2026-09-30T20:55:07Z', 'Built.\n[Origin: Decision] The logo became white with a cyan dot — purple would be the only purple left'),
  user('2026-10-01T12:14:43Z', 'correct, but commit only video change, design change is not approved'),
  meta('2026-10-01T12:14:44Z'),
  toolResult('2026-10-01T12:15:43Z'),
  said('2026-10-01T12:15:55Z', 'Committed.\n[Origin: Decision] The video autoplays with no poster — the poster hid the first frame\n[Origin: Verify] Check the video starts on load'),
  user('2026-10-01T14:02:40Z', 'the fix is shit, just remove one field'),
  said('2026-10-01T14:04:30Z', 'Removed it.'),
].join('\n');

const at = (iso: string) => Date.parse(iso);

describe('splitMarkersByTurn', () => {
  it('splits at real prompts — not tool results, not meta injections — and keeps each turn its own markers', () => {
    const turns = splitMarkersByTurn(transcript);
    // preamble + three prompts
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.startedAt)).toEqual([null, at('2026-09-30T20:49:01Z'), at('2026-10-01T12:14:43Z'), at('2026-10-01T14:02:40Z')]);
    expect(turns[1].markers?.decision).toEqual(['The logo became white with a cyan dot — purple would be the only purple left']);
    expect(turns[2].markers?.decision).toEqual(['The video autoplays with no poster — the poster hid the first frame']);
    expect(turns[3].markers).toBeUndefined();
  });

  it('cannot place anything in a transcript with no prompt in it', () => {
    expect(splitMarkersByTurn('[Origin: Decision] free text')).toEqual([]);
  });
});

describe('markersOfCommitTurns', () => {
  const turns = splitMarkersByTurn(transcript);

  it('gives a commit only the turn that made it — the rejected design stays out', () => {
    // 1abd0603, the video commit, made in the "commit only video change" turn.
    expect(commitTurnDecisions(turns, '2026-10-01T12:15:48Z')).toEqual([
      'The video autoplays with no poster — the poster hid the first frame',
    ]);
    // 3335f98, made in a turn that wrote no decision at all.
    expect(commitTurnDecisions(turns, '2026-10-01T14:04:24Z')).toEqual([]);
  });

  it('a commit in the same second as its prompt (git dates truncate) still lands in that turn', () => {
    expect(commitTurnDecisions(turns, '2026-10-01T12:14:42.500Z')).toEqual([
      'The video autoplays with no poster — the poster hid the first frame',
    ]);
  });

  it('merges every committing turn, all buckets but closes', () => {
    const m = markersOfCommitTurns(turns, [at('2026-10-01T12:15:48Z'), at('2026-10-01T14:04:24Z')]);
    expect(m?.decision).toEqual(['The video autoplays with no poster — the poster hid the first frame']);
    expect(m?.verify).toEqual(['Check the video starts on load']);
  });

  it('a transcript with no times places only the running turn, and only with the hook\'s turn start', () => {
    // Cursor: {role, message} and no timestamps.
    const cursor = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'try a new logo' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '[Origin: Decision] Logo is cyan' }] } }),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'commit the video fix only' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '[Origin: Decision] Video autoplays' }] } }),
    ].join('\n');
    const t = splitMarkersByTurn(cursor);
    expect(t.every((x) => x.startedAt === null)).toBe(true);
    // No turn start known → nothing can be placed.
    expect(commitTurnDecisions(t, 5_000)).toEqual([]);
    // Commit after the running turn's prompt → the last turn.
    expect(commitTurnDecisions(t, 5_000, { currentTurnStartedAt: 4_000 })).toEqual(['Video autoplays']);
    // Commit from before the running turn → cannot be placed.
    expect(commitTurnDecisions(t, 2_000, { currentTurnStartedAt: 4_000 })).toEqual([]);
  });

  it('reads Codex rollouts and Antigravity steps', () => {
    const codex = [
      JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'try X' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:01:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Origin: Decision] X tried' }] } }),
      JSON.stringify({ timestamp: '2026-10-01T11:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'commit Y' } }),
      JSON.stringify({ timestamp: '2026-10-01T11:01:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Origin: Decision] Y committed' }] } }),
    ].join('\n');
    expect(commitTurnDecisions(splitMarkersByTurn(codex), '2026-10-01T11:00:30Z')).toEqual(['Y committed']);

    const agy = [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-10-01T10:00:00Z', content: '<USER_REQUEST>\ntry X\n</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-10-01T10:01:00Z', content: '[Origin: Decision] X tried' }),
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-10-01T11:00:00Z', content: '<USER_REQUEST>\ncommit Y\n</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-10-01T11:01:00Z', content: '[Origin: Decision] Y committed' }),
    ].join('\n');
    expect(commitTurnDecisions(splitMarkersByTurn(agy), '2026-10-01T11:00:30Z')).toEqual(['Y committed']);
  });
});

describe('committedSessionMarkers', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-committed-markers-'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'], { cwd: repo, env });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const commit = (c: Partial<CommitMemoryEntry>): CommitMemoryEntry => ({
    commitSha: 'x', sessionId: 's1', agentSlug: 'claude-code', message: 'm', filesChanged: [],
    linesAdded: 0, linesRemoved: 0, branch: null, committedAt: new Date().toISOString(), ...c,
  });
  const session = (sessionId: string): SessionMemoryEntry => ({
    sessionId, agentSlug: 'claude-code', model: 'm', startedAt: '2026-09-30T20:00:00Z', endedAt: '2026-10-01T15:00:00Z',
    branch: null, summary: 's', filesChanged: [], promptCount: 3, linesAdded: 0, linesRemoved: 0, openTodos: [],
  });

  it('holds the committing turns\' markers and what the commit records already say — never the rejected turn\'s', () => {
    writeSessionMemory(repo, session('s1'));
    writeCommitMemory(repo, commit({ commitSha: 'v1', committedAt: '2026-10-01T12:15:48Z' }));
    writeCommitMemory(repo, commit({ commitSha: 'f1', committedAt: '2026-10-01T14:04:24Z', decisions: ['recorded at commit time'] }));
    const m = committedSessionMarkers({ repoPath: repo, sessionId: 's1', turns: splitMarkersByTurn(transcript) });
    expect(m?.decision).toEqual([
      'The video autoplays with no poster — the poster hid the first frame',
      'recorded at commit time',
    ]);
    expect(JSON.stringify(m)).not.toMatch(/logo/i);
  });

  it('a session with no commits remembers no markers', () => {
    writeSessionMemory(repo, session('s2'));
    expect(committedSessionMarkers({ repoPath: repo, sessionId: 's2', turns: splitMarkersByTurn(transcript) })).toBeUndefined();
  });
});

// The other half of "memory is what was committed": the agent made and
// explained the change in one turn, and the user said "commit it" in the next.
describe('an earlier turn whose work is in the commit', () => {
  const edit = (ts: string, file: string, text: string) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: 'x', new_string: text } }] },
  });
  const video = 'const autoplay = true;\nvideo.removeAttribute("poster");\nvideo.play().catch(() => undefined);';
  const logo = 'const logoColor = "white";\nconst dotColor = "cyan";\nexport const LOGO_VERSION = 2;';
  const t = [
    user('2026-10-01T10:00:00Z', 'make the video autoplay'),
    edit('2026-10-01T10:01:00Z', 'Landing.tsx', video),
    said('2026-10-01T10:02:00Z', '[Origin: Decision] No poster — it hid the first frame'),
    user('2026-10-01T10:10:00Z', 'try a white logo'),
    edit('2026-10-01T10:11:00Z', 'Logo.tsx', logo),
    said('2026-10-01T10:12:00Z', '[Origin: Decision] The logo became white with a cyan dot'),
    user('2026-10-01T10:20:00Z', 'commit only the video change'),
    said('2026-10-01T10:21:00Z', 'Committed.'),
  ].join('\n');
  const turns = splitMarkersByTurn(t);
  const lines = (text: string) => new Set(text.split('\n').map((l) => l.trim()));

  it('rides along when most of what it wrote is in the commit; the rejected turn does not', () => {
    const added = lines(video);
    expect(commitTurnDecisions(turns, '2026-10-01T10:20:30Z', { added })).toEqual(['No poster — it hid the first frame']);
  });

  it('without the commit\'s lines only the committing turn counts', () => {
    expect(commitTurnDecisions(turns, '2026-10-01T10:20:30Z')).toEqual([]);
  });

  it('a turn half of whose work was left out does not ride along', () => {
    // The commit took one of the logo turn's three lines.
    const added = new Set([...lines(video), 'const logoColor = "white";']);
    expect(commitTurnDecisions(turns, '2026-10-01T10:20:30Z', { added })).toEqual(['No poster — it hid the first frame']);
  });

  it('a turn AFTER the commit never rides along, even with the same lines', () => {
    const later = [t, user('2026-10-01T10:29:00Z', 'redo it'), edit('2026-10-01T10:30:00Z', 'Landing.tsx', video), said('2026-10-01T10:31:00Z', '[Origin: Decision] later')].join('\n');
    expect(commitTurnDecisions(splitMarkersByTurn(later), '2026-10-01T10:20:30Z', { added: lines(video) })).toEqual(['No poster — it hid the first frame']);
  });

  it('generic lines prove nothing', () => {
    const generic = [
      user('2026-10-01T10:00:00Z', 'tidy'),
      edit('2026-10-01T10:01:00Z', 'a.ts', '});\n}\n</div>\nreturn;'),
      said('2026-10-01T10:02:00Z', '[Origin: Decision] tidy'),
      user('2026-10-01T10:20:00Z', 'commit'),
    ].join('\n');
    expect(splitMarkersByTurn(generic)[1].written).toEqual([]);
    expect(commitTurnDecisions(splitMarkersByTurn(generic), '2026-10-01T10:20:30Z', { added: new Set(['});']) })).toEqual([]);
  });

  it('reads what each agent\'s tool calls wrote, never what a tool returned', () => {
    const rec = (o: unknown) => JSON.stringify(o);
    const all = [
      user('2026-10-01T10:00:00Z', 'go'),
      // Claude Code Write + a Read result carrying file text.
      rec({ type: 'assistant', timestamp: '2026-10-01T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'w.ts', content: 'export const writtenByWrite = 1;' } }] } }),
      rec({ type: 'user', timestamp: '2026-10-01T10:00:02Z', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'export const onlyRead = 1;' }] } }),
      // Codex apply_patch.
      rec({ timestamp: '2026-10-01T10:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: p.py\n+def added_by_patch():\n*** End Patch\n' } }),
      // Antigravity, double-encoded.
      rec({ type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-10-01T10:00:04Z', tool_calls: [{ name: 'write_to_file', args: { CodeContent: JSON.stringify('agy_written = "yes"') } }] }),
    ].join('\n');
    expect(splitMarkersByTurn(all)[1].written!.sort()).toEqual(['agy_written = "yes"', 'def added_by_patch():', 'export const writtenByWrite = 1;']);
  });

  it('a turn that wrote through the shell is credited from its captured diff', () => {
    const shell = [
      user('2026-10-01T10:00:00Z', 'make the video autoplay'),
      said('2026-10-01T10:02:00Z', '[Origin: Decision] No poster — it hid the first frame'),
      user('2026-10-01T10:20:00Z', 'commit it'),
    ].join('\n');
    const raw = splitMarkersByTurn(shell);
    expect(commitTurnDecisions(raw, '2026-10-01T10:20:30Z', { added: lines(video) })).toEqual([]);
    const withDiffs = withTurnDiffs(raw, {
      promptSubmittedAt: ['2026-10-01T10:00:00.300Z', '2026-10-01T10:20:00.200Z'],
      completedPromptMappings: [{ promptIndex: 0, diff: '+++ b/Landing.tsx\n' + video.split('\n').map((l) => '+' + l).join('\n') }],
    });
    expect(commitTurnDecisions(withDiffs, '2026-10-01T10:20:30Z', { added: lines(video) })).toEqual(['No poster — it hid the first frame']);
  });
});

describe('commitEvidence', () => {
  it('reads each commit\'s time and added lines in one call, and skips shas git does not know', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-evidence-'));
    try {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_COMMITTER_DATE: '2026-10-01T10:20:00Z' };
      const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, env, encoding: 'utf-8' }).trim();
      g('init', '-q');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'const autoplay = true;\n});\n');
      g('add', '.');
      g('commit', '-qm', 'video');
      const sha = g('rev-parse', 'HEAD');
      const ev = commitEvidence(repo, [sha.slice(0, 9), 'deadbeef']);
      expect(ev.get('deadbeef')).toBeUndefined();
      expect(ev.get(sha.slice(0, 9))?.at).toBe(Date.parse('2026-10-01T10:20:00Z'));
      expect([...(ev.get(sha)?.added || [])]).toEqual(['const autoplay = true;']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('long sessions', () => {
  // Session 46b82050: a background task's notice arrived as a user record
  // between the commit (15:37) and the decision about it (15:40).
  it('a task notification mid-turn does not start a turn', () => {
    const t = [
      user('2026-10-01T15:07:04Z', 'start on the index'),
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T15:38:41Z', message: { role: 'user', content: '<task-notification>\n<task-id>b0vk96l8f</task-id>\n<status>completed</status>\n</task-notification>' } }),
      said('2026-10-01T15:40:13Z', '[Origin: Decision] Ranking is plain TypeScript — built-in SQLite needs Node 22.5'),
    ].join('\n');
    expect(commitTurnDecisions(splitMarkersByTurn(t), '2026-10-01T15:37:40Z')).toEqual(['Ranking is plain TypeScript — built-in SQLite needs Node 22.5']);
  });

  it('reads past the 4 MB tail: a decision hours back still belongs to its commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-long-transcript-'));
    try {
      const big = 'x'.repeat(100_000);
      const filler = Array.from({ length: 60 }, (_, i) => JSON.stringify({ type: 'user', timestamp: '2026-10-01T11:00:00Z', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(i), content: big }] } }));
      const f = path.join(dir, 't.jsonl');
      fs.writeFileSync(f, [
        user('2026-10-01T10:00:00Z', 'make the video autoplay and commit it'),
        said('2026-10-01T10:05:00Z', '[Origin: Decision] No poster — it hid the first frame'),
        ...filler,
        user('2026-10-01T12:00:00Z', 'next'),
      ].join('\n'));
      expect(fs.statSync(f).size).toBeGreaterThan(4 * 1024 * 1024);
      expect(commitTurnDecisions(readMarkerTurns(f), '2026-10-01T10:04:00Z')).toEqual(['No poster — it hid the first frame']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Cursor's transcript has no times. The hook records when each prompt was sent
// (promptSubmittedAt), so the transcript's turns can take those times by
// position — and then an earlier turn whose work a later "commit it" turn
// committed is placed like any other agent's (TODO f2d0717c).
describe('a Cursor transcript (no times) and the hook\'s prompt times', () => {
  const said = (role: 'user' | 'assistant', text: string) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
  const wrote = (content: string) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: 'Landing.tsx', contents: content } }] } });
  const work = 'const autoplayVideo = true;\nconst posterHidesFirstFrame = false;\nexport function LandingVideo() {';
  const cursor = [
    said('user', 'try a cyan logo'),
    said('assistant', '[Origin: Decision] Logo is cyan'),
    said('user', 'make the video autoplay'),
    wrote(work),
    said('assistant', '[Origin: Decision] No poster — it hid the first frame'),
    said('user', 'commit it'),
    said('assistant', 'Committed.'),
    said('user', 'thanks'),
  ].join('\n');
  const submitted = ['2026-10-01T10:00:00.000Z', '2026-10-01T10:10:00.000Z', '2026-10-01T10:20:00.000Z', '2026-10-01T10:30:00.000Z'];
  const added = new Set(work.split('\n').map((l) => l.trim()));
  const COMMITTED = '2026-10-01T10:20:30Z';

  it('the earlier turn whose work is in the commit rides along; the rejected logo does not', () => {
    const raw = splitMarkersByTurn(cursor);
    // Before: read from a later turn (session end, the late-marker backfill),
    // a commit made before the running turn cannot be placed at all.
    expect(commitTurnDecisions(raw, COMMITTED, { added, currentTurnStartedAt: Date.parse(submitted[3]) })).toEqual([]);
    const timed = withTurnDiffs(raw, { promptSubmittedAt: submitted });
    expect(timed.map((t) => t.startedAt)).toEqual([null, ...submitted.map(Date.parse)]);
    expect(commitTurnDecisions(timed, COMMITTED, { added })).toEqual(['No poster — it hid the first frame']);
  });

  it('a shell-only turn is credited from its captured diff', () => {
    const shellOnly = cursor.replace(wrote(work) + '\n', '');
    // Before: the running turn's commit, but the shell turn shows no work.
    expect(commitTurnDecisions(splitMarkersByTurn(shellOnly).slice(0, 4), COMMITTED, { added, currentTurnStartedAt: Date.parse(submitted[2]) })).toEqual([]);
    const turns = withTurnDiffs(splitMarkersByTurn(shellOnly), {
      promptSubmittedAt: submitted,
      completedPromptMappings: [{ promptIndex: 1, diff: work.split('\n').map((l) => '+' + l).join('\n') }],
    });
    expect(commitTurnDecisions(turns, COMMITTED, { added })).toEqual(['No poster — it hid the first frame']);
  });

  it('a resumed conversation lines up through promptIndexBase', () => {
    // This launch recorded the last two prompts; the first came before it.
    const turns = withTurnDiffs(splitMarkersByTurn(cursor), { promptSubmittedAt: submitted.slice(1), promptIndexBase: 1 });
    expect(turns.map((t) => t.startedAt)).toEqual([null, null, ...submitted.slice(1).map(Date.parse)]);
    expect(commitTurnDecisions(turns, COMMITTED, { added })).toEqual(['No poster — it hid the first frame']);
  });

  it('takes no times when the transcript and the hook count different prompts', () => {
    // The transcript has not written the running prompt yet: every time would
    // land one turn early, and the logo decision would ride on the commit.
    const short = splitMarkersByTurn(cursor.split('\n').slice(0, 5).join('\n'));
    expect(withTurnDiffs(short, { promptSubmittedAt: submitted }).every((t) => t.startedAt === null)).toBe(true);
  });

  it('keeps a transcript\'s own times', () => {
    const own = splitMarkersByTurn(transcript);
    expect(withTurnDiffs(own, { promptSubmittedAt: ['2020-01-01T00:00:00Z', '2020-01-01T00:00:01Z', '2020-01-01T00:00:02Z'] })).toEqual(own);
  });

  it('a commit the caller pairs with a turn is placed with no times at all (the watcher)', () => {
    const raw = splitMarkersByTurn(cursor);
    expect(commitTurnDecisions(raw, COMMITTED, { added })).toEqual([]);
    expect(commitTurnDecisions(raw, COMMITTED, { added, turn: 3 })).toEqual(['No poster — it hid the first frame']);
    // With no `added`, the named turn's own markers only.
    expect(commitTurnDecisions(raw, COMMITTED, { turn: 2 })).toEqual(['No poster — it hid the first frame']);
    // Out of range places nothing.
    expect(commitTurnDecisions(raw, COMMITTED, { turn: 9 })).toEqual([]);
  });

  it('the watcher files diffs by position when nobody has times and the counts agree', () => {
    const shellOnly = splitMarkersByTurn(cursor.replace(wrote(work) + '\n', ''));
    const mappings = [{ promptIndex: 1, diff: work.split('\n').map((l) => '+' + l).join('\n') }];
    const filed = withTurnDiffs(shellOnly, { promptSubmittedAt: ['', '', '', ''], completedPromptMappings: mappings });
    expect(commitTurnDecisions(filed, COMMITTED, { added, turn: 3 })).toEqual(['No poster — it hid the first frame']);
    // Counts disagree → nothing filed.
    const unfiled = withTurnDiffs(shellOnly, { promptSubmittedAt: ['', '', ''], completedPromptMappings: mappings });
    expect(commitTurnDecisions(unfiled, COMMITTED, { added, turn: 3 })).toEqual([]);
  });
});
