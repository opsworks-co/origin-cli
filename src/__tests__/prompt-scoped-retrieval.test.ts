// End-to-end for the retrieval half: real git notes in a real repo, searched
// with a real prompt.
//
// The tokenizer is unit-tested next door; what this covers is everything after
// it — that the scoring reaches into the fields that actually carry the signal
// (files, intent, decisions, open TODOs, not just the summary), that the
// threshold rejects a prompt with nothing to retrieve, and that the
// already-seen filter stops a multi-turn conversation about one file from being
// handed the same record every prompt.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSessionMemory, searchMemoryForPrompt, buildPromptScopedMemoryContext } from '../memory.js';

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-retrieval-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

const entry = (over: Record<string, any> = {}) => ({
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  agentSlug: 'claude-code',
  model: 'claude-opus-5',
  startedAt: '2026-08-20T10:00:00.000Z',
  endedAt: '2026-08-20T12:00:00.000Z',
  branch: 'main',
  summary: 'Reworked the notes refspec so a fresh clone fetches them',
  filesChanged: ['packages/cli/src/git-notes.ts'],
  promptCount: 4,
  linesAdded: 120,
  linesRemoved: 30,
  openTodos: [],
  ...over,
});

describe('searchMemoryForPrompt', () => {
  it('retrieves the session that touched the file the prompt names', () => {
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      writeSessionMemory(repo, entry({
        sessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
        summary: 'Restyled the dashboard header',
        filesChanged: ['apps/web/src/Header.tsx'],
      }) as any);

      const hits = searchMemoryForPrompt(repo, 'fix a bug in packages/cli/src/git-notes.ts');
      expect(hits.length).toBe(1);
      expect(hits[0].key).toBe('s:aaaaaaaa-1111-2222-3333-444444444444');
      expect(hits[0].matched).toContain('packages/cli/src/git-notes.ts');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches a partial path against the full one recorded in the note', () => {
    // The prompt says `src/git-notes.ts`; the note recorded
    // `packages/cli/src/git-notes.ts`. Neither string contains the other, and
    // this is how people actually refer to files.
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      const hits = searchMemoryForPrompt(repo, 'why did src/git-notes.ts change');
      expect(hits.length).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('surfaces an open TODO and a decision, not just the summary', () => {
    // These are the fields worth retrieving — the ones a reviewer said the
    // digest leaves out and that cannot be recovered from the diff.
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry({
        openTodos: ['The receive-side refspec still needs a guard against clobbering the live ref'],
        decisions: ['Used a staging ref rather than mapping remote notes onto the live ref — a force-map loses local sessions'],
      }) as any);
      const block = buildPromptScopedMemoryContext(repo, 'work on packages/cli/src/git-notes.ts')!;
      expect(block.block).toContain('Still open:');
      expect(block.block).toContain('Decision:');
      expect(block.block).toContain('staging ref');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns nothing for a prompt with nothing to retrieve', () => {
    // A weak best-effort list here is worse than an empty one: it re-injects the
    // digest the agent already has and teaches it to skim the block.
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      expect(searchMemoryForPrompt(repo, 'thanks, continue')).toEqual([]);
      expect(searchMemoryForPrompt(repo, 'ok')).toEqual([]);
      expect(buildPromptScopedMemoryContext(repo, 'looks good to me')).toBeNull();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not re-inject a record this session already received', () => {
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      const first = buildPromptScopedMemoryContext(repo, 'edit packages/cli/src/git-notes.ts')!;
      expect(first.keys).toHaveLength(1);
      const second = buildPromptScopedMemoryContext(repo, 'now also fix packages/cli/src/git-notes.ts', first.keys);
      expect(second).toBeNull();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('bails before touching git when no entry could clear the threshold', () => {
    // The early-out must be SOUND, not a heuristic: it may only skip the read
    // when the best conceivable score is still under the bar. These prompts
    // returned nothing before the early-out existed too — it made the same
    // answer instant, it did not change it.
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      expect(searchMemoryForPrompt(repo, 'ok thanks continue')).toEqual([]);
      // Three plain words: ceiling 6, threshold 8. Unreachable, so the read is
      // provably wasted and must not happen.
      expect(searchMemoryForPrompt(repo, 'maybe revisit those numbers')).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('retrieves from prose alone, with no path or identifier in the prompt', () => {
    // The recall fix, end to end. This prompt names no file and no symbol — it
    // is how someone actually asks about prior work — and it must still find
    // the session whose summary is about exactly this.
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      const hits = searchMemoryForPrompt(repo, 'so a fresh clone fetches the notes refspec');
      expect(hits.length).toBe(1);
      expect(hits[0].key).toBe('s:aaaaaaaa-1111-2222-3333-444444444444');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still retrieves when the ceiling clears the bar', () => {
    // The other half of the early-out: a guard that skips too eagerly would
    // silently kill the whole feature, and every test above would still pass if
    // it only ever checked that weak prompts return nothing.
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      expect(searchMemoryForPrompt(repo, 'edit packages/cli/src/git-notes.ts').length).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is empty on a repo with no memory at all', () => {
    const repo = makeRepo();
    try {
      expect(searchMemoryForPrompt(repo, 'edit packages/cli/src/git-notes.ts')).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
