/**
 * The verifier reads a turn's own writes off the state file's `liveEdits`, so
 * an emptied row is a finding on the gate and not only in a unit test.
 *
 * Driven through `verifyCaptureCommand` over a real state file, like
 * verify-capture-relaunched-session-header.test.ts, so `collectSessions` and
 * the local-to-server row mapping are covered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyCaptureCommand } from '../commands/verify-capture.js';
import { serializeFence, serializeRecord, serializeTurnMark } from '../write-journal.js';
import { hashContent } from '../write-journal-store.js';

const SESSION_ID = 'deadbeef-0000-4000-8000-00000000cb54';
const FILE = 'packages/cli/src/antigravity-transcript.ts';
const H0 = 'a'.repeat(64);
const H1 = 'b'.repeat(64);

const edit = (over: Record<string, unknown> = {}) => ({
  file: FILE, op: 'edit', oldContent: 'inputChars += req.length;', newContent: 'inputChars += req.length * 2;',
  source: 'tool_call', evidence: 'tool_call', ...over,
});

describe('verify-capture — an emptied row against the turn\'s own writes', () => {
  let repo: string;
  const origCwd = process.cwd();

  const state = (over: Record<string, unknown>) => ({
    sessionId: SESSION_ID,
    sessionTag: 'emptied',
    agentSlug: 'claude-code',
    startedAt: new Date().toISOString(),
    status: 'ENDED',
    endedAt: new Date().toISOString(),
    activeTurn: null,
    prompts: ['next task from the list'],
    promptTurnIds: ['t_turn0'],
    completedPromptMappings: [{ promptIndex: 0, filesChanged: [], diff: '', uncommittedDiff: '', chatOnly: true }],
    liveEdits: [{ promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(), edits: [edit()] }],
    ...over,
  });

  const write = (s: Record<string, unknown>) =>
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-emptied.json'), JSON.stringify({ ...s, repoPath: repo }, null, 2));

  const run = async () => {
    const out: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    const before = process.exitCode;
    process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await verifyCaptureCommand({ session: SESSION_ID, failOnContradiction: true, json: true });
    } finally {
      process.stdout.write = real;
    }
    const failed = process.exitCode === 1;
    process.exitCode = before;
    const body = JSON.parse(out.join('\n'));
    const codes = (body.sessions[0]?.violations || []).map((v: { promptIndex: number; code: string }) => `${v.promptIndex}:${v.code}`);
    return { failed, codes };
  };

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gate-emptied-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('a chat-only row over a turn whose Edit succeeded fails the gate and names the file', async () => {
    write(state({}));
    expect(await run()).toEqual({ failed: true, codes: ['0:emptied_row_with_own_writes'] });
  });

  it('the same row is honest when the turn put the file back (discardedFiles)', async () => {
    write(state({ completedPromptMappings: [{ promptIndex: 0, filesChanged: [], diff: '', uncommittedDiff: '', discardedFiles: [FILE] }] }));
    expect(await run()).toEqual({ failed: false, codes: [] });
  });

  it('…and when the journal saw it put back, for a row an older binary wrote without discardedFiles', async () => {
    const journal = path.join(repo, '.git', 'emptied.jsonl');
    fs.writeFileSync(journal,
      serializeRecord({ file: FILE, at: 1, hash: H0, retained: true })
      + serializeTurnMark({ at: 2, turnId: 't_turn0' })
      + serializeRecord({ file: FILE, at: 3, hash: H1, retained: true })
      + serializeRecord({ file: FILE, at: 4, hash: H0, retained: true }));
    write(state({ writeJournalPath: journal }));
    expect(await run()).toEqual({ failed: false, codes: [] });
  });

  it('…and when the journal never saw the file before, but the turn left it at the baseline\'s bytes', async () => {
    // b300fdf0 turn 10 as an older binary stored it: the file's first write
    // this session, `git checkout --` after, no discardedFiles. One git read
    // of the turn's baseline answers it.
    const base = 'inputChars += req.length;\n';
    fs.mkdirSync(path.join(repo, path.dirname(FILE)), { recursive: true });
    fs.writeFileSync(path.join(repo, FILE), base);
    execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=e', 'add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=e', 'commit', '-q', '-m', 'base'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const journal = path.join(repo, '.git', 'emptied.jsonl');
    fs.writeFileSync(journal,
      serializeTurnMark({ at: 2, turnId: 't_turn0' })
      + serializeRecord({ file: FILE, at: 3, hash: H1, retained: true })
      + serializeRecord({ file: FILE, at: 4, hash: hashContent(base), retained: true }));
    write(state({ writeJournalPath: journal, headShaAtStart: head }));
    expect(await run()).toEqual({ failed: false, codes: [] });
    // Left at OTHER bytes, it is a write the row lost.
    fs.writeFileSync(journal,
      serializeTurnMark({ at: 2, turnId: 't_turn0' })
      + serializeRecord({ file: FILE, at: 3, hash: H1, retained: true }));
    write(state({ writeJournalPath: journal, headShaAtStart: head }));
    expect(await run()).toEqual({ failed: true, codes: ['0:emptied_row_with_own_writes'] });
  });

  it('…and when a checkout inside the turn left the file at the head it switched to', async () => {
    // b300fdf0 turn 10 in full: edits, `git checkout -- <file>`, then
    // `git checkout -B sync-main origin/main`, whose version of the file
    // differs from the turn's baseline. The journal's fence names both heads.
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=e', ...a], { cwd: repo, encoding: 'utf-8' }).trim();
    fs.mkdirSync(path.join(repo, path.dirname(FILE)), { recursive: true });
    fs.writeFileSync(path.join(repo, FILE), 'old branch\n');
    g('add', '.'); g('commit', '-q', '-m', 'branch');
    const from = g('rev-parse', 'HEAD');
    const mains = 'main version\n';
    fs.writeFileSync(path.join(repo, FILE), mains);
    g('commit', '-q', '-am', 'main');
    const to = g('rev-parse', 'HEAD');
    const journal = path.join(repo, '.git', 'emptied.jsonl');
    fs.writeFileSync(journal,
      serializeTurnMark({ at: 2, turnId: 't_turn0' })
      + serializeRecord({ file: FILE, at: 3, hash: H1, retained: true })
      + serializeFence(4, from, to)
      + serializeRecord({ file: FILE, at: 5, hash: hashContent(mains), retained: true }));
    write(state({ writeJournalPath: journal, headShaAtStart: from, promptShadows: [{ promptIndex: 0, shadowSha: from, capturedAt: new Date().toISOString() }] }));
    expect(await run()).toEqual({ failed: false, codes: [] });
  });

  it('a file the turn created and removed again is not a write the row lost', async () => {
    // 773b6ab3 turn 14: a scratch test written by the Write tool and deleted.
    const journal = path.join(repo, '.git', 'emptied.jsonl');
    fs.writeFileSync(journal,
      serializeTurnMark({ at: 2, turnId: 't_turn0' })
      + serializeRecord({ file: FILE, at: 3, hash: H1, retained: true })
      + serializeRecord({ file: FILE, at: 4, gone: true }));
    write(state({ writeJournalPath: journal }));
    expect(await run()).toEqual({ failed: false, codes: [] });
  });

  it('a no-op edit, a watched-only edit and an edit of the open turn are not own writes', async () => {
    write(state({
      liveEdits: [
        { promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(), edits: [edit({ newContent: 'inputChars += req.length;' })] },
        { promptIndex: 0, toolName: 'Bash', capturedAt: new Date().toISOString(), edits: [edit({ file: 'src/probe.ts', evidence: 'command_probe' })] },
      ],
    }));
    expect(await run()).toEqual({ failed: false, codes: [] });
    write(state({ activeTurn: { index: 0, turnId: 't_turn0', promptText: 'next task from the list', openedAt: new Date().toISOString() }, status: 'RUNNING', endedAt: null }));
    expect((await run()).codes).toEqual([]);
  });

  it('a file capture ignores by design is not one the row lost — the agent\'s own Write of .claude/launch.json', async () => {
    // 0ad438e9 turn 5 (2026-09-28): the agent wrote the launch config with its
    // Write tool to open the Browser pane; Stop left it out, as it must.
    const launch = { file: '.claude/launch.json', op: 'write', newContent: '{"version":"0.0.1","configurations":[]}\n', source: 'tool_call', evidence: 'tool_call' };
    write(state({ liveEdits: [{ promptIndex: 0, toolName: 'Write', capturedAt: new Date().toISOString(), edits: [launch] }] }));
    expect(await run()).toEqual({ failed: false, codes: [] });
    // …while a real file written beside it still grades.
    write(state({ liveEdits: [{ promptIndex: 0, toolName: 'Write', capturedAt: new Date().toISOString(), edits: [launch, edit()] }] }));
    expect(await run()).toEqual({ failed: true, codes: ['0:emptied_row_with_own_writes'] });
  });

  it('maps live edits from the launch\'s local numbering onto the server row', async () => {
    // A re-launched conversation: this launch's turn 0 is server row 23.
    write(state({
      promptIndexBase: 23,
      completedPromptMappings: [{ promptIndex: 23, filesChanged: [], diff: '', uncommittedDiff: '', chatOnly: true }],
    }));
    expect(await run()).toEqual({ failed: true, codes: ['23:emptied_row_with_own_writes'] });
  });
});
