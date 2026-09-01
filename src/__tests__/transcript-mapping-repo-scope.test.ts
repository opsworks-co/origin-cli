import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPromptFileMappings, parseTranscript, scopeCapturedPath } from '../transcript.js';

// Prod session 97c78829, turn 1: the transcript pass reported exactly ONE
// changed file — `/Users/…/.claude/projects/…/memory/multi-account-discover-
// import.md`, a note Origin's own memory step wrote — while the five source
// files the turn committed were nowhere. The live (PostToolUse) ledger has
// filtered out-of-repo writes since isInsideRepo landed; the transcript pass
// took `tool_input.file_path` verbatim.
//
// The same pass left IN-repo paths absolute, so turn 4 recorded
// `/Users/…/worktrees/…/apps/api/src/__tests__/routes/sessions-list-null-branch.test.ts`
// — a string that matches nothing in a git diff.

const REPO = '/repo';

// With no roots supplied the contract is that paths travel VERBATIM — which on
// Windows means native separators (`C:\…\memory\note.md`), so a hard-coded
// `includes('memory/note.md')` matched on Linux and macOS and nowhere else.
// The assertion is what needs to be separator-agnostic: normalising inside
// scopeCapturedPath would contradict the `toBe(p)` identity pinned below and
// turn a documented pass-through into a rewrite.
const slash = (f: string) => f.replace(/\\/g, '/');

describe('scopeCapturedPath', () => {
  it('drops a file outside every root', () => {
    expect(scopeCapturedPath([REPO], '/home/u/.claude/projects/p/memory/note.md')).toBeNull();
  });

  it('relativises a file inside a root', () => {
    expect(scopeCapturedPath([REPO], '/repo/src/x.ts')).toBe('src/x.ts');
  });

  it('leaves an already-relative path alone', () => {
    expect(scopeCapturedPath([REPO], 'src/x.ts')).toBe('src/x.ts');
  });

  it('keeps a file belonging to a SECOND root of a multi-repo session', () => {
    expect(scopeCapturedPath([REPO, '/other'], '/other/lib/y.ts')).toBe('lib/y.ts');
  });

  it('passes everything through when no roots are supplied', () => {
    const p = '/home/u/.claude/projects/p/memory/note.md';
    expect(scopeCapturedPath(undefined, p)).toBe(p);
    expect(scopeCapturedPath([], p)).toBe(p);
  });
});

describe('extractPromptFileMappings — repo scoping', () => {
  let dir: string;
  let repo: string;
  let transcript: string;

  const line = (o: unknown) => JSON.stringify(o) + '\n';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-scope-'));
    repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'apps'), { recursive: true });
    transcript = path.join(dir, 'session.jsonl');
    const memoryNote = path.join(dir, 'home', '.claude', 'projects', 'p', 'memory', 'note.md');
    fs.writeFileSync(transcript,
      line({ type: 'user', message: { role: 'user', content: 'add the account picker' } })
      + line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'apps', 'repos.ts'), old_string: 'a', new_string: 'b' } },
            { type: 'tool_use', name: 'Write', input: { file_path: memoryNote, content: 'remembered\n' } },
          ],
        },
      }));
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('drops the out-of-repo memory note and relativises the repo file', () => {
    const [turn] = extractPromptFileMappings(transcript, { repoRoots: [repo] });
    expect(turn.filesChanged).toEqual(['apps/repos.ts']);
    expect((turn.edits || []).map((e) => e.file)).toEqual(['apps/repos.ts']);
  });

  it('keeps the dropped file out of the turn diff too, not just the file list', () => {
    const [turn] = extractPromptFileMappings(transcript, { repoRoots: [repo] });
    expect(turn.diff).not.toContain('memory/note.md');
    expect(turn.diff).toContain('apps/repos.ts');
  });

  it('is unchanged for callers that supply no roots', () => {
    const [turn] = extractPromptFileMappings(transcript);
    expect(turn.filesChanged).toHaveLength(2);
    expect(turn.filesChanged.some((f) => slash(f).includes('memory/note.md'))).toBe(true);
  });
});

// The SESSION-level file list is a second producer with the same gap. It is
// what renders as "N files changed" in the session header, and prod d0cec15e
// showed 26 for a session whose own turns touched 12 — carrying an absolute
// in-repo path and an agent memory note under ~/.claude among them.
describe('parseTranscript — repo scoping of filesChanged', () => {
  let dir: string;
  let repo: string;
  let transcript: string;

  const line = (o: unknown) => JSON.stringify(o) + '\n';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-scope-parse-'));
    repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'apps'), { recursive: true });
    transcript = path.join(dir, 'session.jsonl');
    const note = path.join(dir, 'home', '.claude', 'projects', 'p', 'memory', 'note.md');
    fs.writeFileSync(transcript,
      line({ type: 'user', message: { role: 'user', content: 'do the thing' } })
      + line({
        type: 'assistant',
        message: {
          role: 'assistant', model: 'claude-opus-5',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'apps', 'a.ts'), old_string: 'x', new_string: 'y' } },
            { type: 'tool_use', name: 'Write', input: { file_path: note, content: 'remembered\n' } },
          ],
        },
      }));
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('drops the out-of-repo note and relativises the repo file', () => {
    const parsed = parseTranscript(transcript, { repoRoots: [repo] });
    expect(parsed.filesChanged).toEqual(['apps/a.ts']);
  });

  it('is unchanged for callers that supply no roots', () => {
    const parsed = parseTranscript(transcript);
    expect(parsed.filesChanged).toHaveLength(2);
    expect(parsed.filesChanged.some((f) => slash(f).includes('memory/note.md'))).toBe(true);
  });
});
