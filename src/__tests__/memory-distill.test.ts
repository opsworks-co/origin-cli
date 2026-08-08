// Cross-session memory injection must carry SIGNAL, not a raw prompt log. The
// old buildMemoryContext dumped the last 3 prompts verbatim, so a bake-off
// sandbox (or any repo with throwaway turns) injected pure noise ("say hello in
// one word") into every real session. These cover the three guards: bake-off/
// ignored repos are skipped, trivial benchmark prompts are filtered, and what
// remains is distilled.
import { describe, it, expect } from 'vitest';
import { isBakeoffRepo, isSubstantiveMemory, repoRelativeFiles, hasFileExtension, summarizeFromCommitSubjects, type SessionMemoryEntry } from '../memory.js';

const entry = (over: Partial<SessionMemoryEntry>): SessionMemoryEntry => ({
  sessionId: 's', agentSlug: 'claude-code', model: 'claude', startedAt: '', endedAt: new Date().toISOString(),
  branch: null, summary: '', filesChanged: [], promptCount: 1, linesAdded: 0, linesRemoved: 0, openTodos: [],
  ...over,
});

describe('repoRelativeFiles (cross-platform separators)', () => {
  it('keeps repo-relative paths, drops foreign ones — POSIX and Windows shapes', () => {
    expect(repoRelativeFiles(['src/auth.ts', 'README.md'])).toEqual(['src/auth.ts', 'README.md']);
    // POSIX-absolute foreign path — path.isAbsolute catches it on every platform.
    expect(repoRelativeFiles(['/Users/x/copilot-worktrees/repo/data.txt'])).toEqual([]);
    // Windows shapes: filtered via the normalized marker check on ANY platform
    // (on POSIX, C:\ isn't "absolute", so the marker match is what saves us).
    expect(repoRelativeFiles(['C:\\Users\\x\\.origin\\bakeoff-repos\\repo\\data.txt'])).toEqual([]);
    expect(repoRelativeFiles(['sub\\repo-bakeoff-ab12-codex\\notes.txt'])).toEqual([]);
    expect(repoRelativeFiles(['x\\copilot-worktrees\\repo\\y.txt'])).toEqual([]);
  });
});

describe('summarizeFromCommitSubjects (heuristic summary from commit messages)', () => {
  it('joins real commit subjects; a vague opening prompt is no longer the summary', () => {
    const subjects = ['Add interactive colorful calculator script', 'Add bouncing ball terminal script', 'Add terminal digital clock script'];
    expect(summarizeFromCommitSubjects(subjects)).toBe('Add interactive colorful calculator script; Add bouncing ball terminal script; Add terminal digital clock script');
  });
  it('caps at 3 with a "+N more" tail', () => {
    const out = summarizeFromCommitSubjects(['Add a', 'Add b', 'Add c', 'Add d', 'Add e'])!;
    expect(out).toBe('Add a; Add b; Add c; +2 more');
  });
  it('filters Origin shadow/notes commits and dedupes', () => {
    expect(summarizeFromCommitSubjects([
      'origin shadow agy-sync-8bd2d1fa-8 2026-08-07', "Notes added by 'git notes add'", 'Add calculator', 'Add calculator',
    ])).toBe('Add calculator');
  });
  it('returns null when nothing real remains', () => {
    expect(summarizeFromCommitSubjects([])).toBeNull();
    expect(summarizeFromCommitSubjects(["Notes added by 'git notes add'", 'origin shadow x'])).toBeNull();
    expect(summarizeFromCommitSubjects(undefined)).toBeNull();
  });
});

describe('hasFileExtension (scratch-file de-prioritization)', () => {
  it('true for real source/config, false for extensionless throwaways', () => {
    for (const f of ['auth.ts', 'README.md', 'eleven-rows-new.txt', 'package.json']) expect(hasFileExtension(f)).toBe(true);
    for (const f of ['oneoneone', 'gandon', 'stvol', 'pushlash']) expect(hasFileExtension(f)).toBe(false);
    // a leading dot alone is not an extension (matches Node path.extname)
    expect(hasFileExtension('.gitignore')).toBe(false);
  });
});

describe('isBakeoffRepo', () => {
  it('flags bake-off arm worktrees and the runner clone dir', () => {
    expect(isBakeoffRepo('/Users/x/Documents/origin-demo-1-bakeoff-ab12-codex')).toBe(true);
    expect(isBakeoffRepo('/Users/x/.origin/bakeoff-repos/origin-demo-1')).toBe(true);
  });
  it('does NOT flag a normal repo', () => {
    expect(isBakeoffRepo('/Users/x/Documents/origin-demo-1')).toBe(false);
    expect(isBakeoffRepo('')).toBe(false);
    expect(isBakeoffRepo(undefined)).toBe(false);
  });
});

describe('isSubstantiveMemory', () => {
  it('drops distinctive benchmark / smoke-test prompts', () => {
    for (const s of [
      'Say hello in one word.',
      'Reply with the single word: done.',
      'print the word hello',
      'In one sentence, what is version control?',
      'In two sentences, describe what a README file is for.',
      'create a file stopdedup.txt containing the number 42',
      'add 5 more and commit',
    ]) {
      expect(isSubstantiveMemory(entry({ summary: s, filesChanged: s.includes('create') ? ['stopdedup.txt'] : [], linesAdded: 1 }))).toBe(false);
    }
  });

  it('drops ultra-trivial no-op turns', () => {
    expect(isSubstantiveMemory(entry({ summary: 'ok', linesAdded: 0, filesChanged: [] }))).toBe(false);
    expect(isSubstantiveMemory(entry({ summary: '', linesAdded: 50 }))).toBe(false);
  });

  it('drops bake-off / other-agent work that recorded FOREIGN absolute paths', () => {
    // A bake-off arm committed to its own worktree; those files aren't this repo.
    expect(isSubstantiveMemory(entry({
      summary: 'Done! Created data.txt with 5 rows of random text',
      filesChanged: ['/Users/x/copilot-worktrees/origin-demo-1/artemdolobanko-fluffy-waffle/data.txt'],
      linesAdded: 5,
    }))).toBe(false);
    expect(isSubstantiveMemory(entry({
      summary: 'made changes and committed them',
      filesChanged: ['/Users/x/Documents/origin-demo-1-bakeoff-ab12-codex/notes.txt'],
      linesAdded: 70,
    }))).toBe(false);
  });

  it('KEEPS real work — even short prompts with actual changes', () => {
    expect(isSubstantiveMemory(entry({ summary: 'fix the auth redirect bug in login flow', filesChanged: ['auth.ts'], linesAdded: 12 }))).toBe(true);
    expect(isSubstantiveMemory(entry({ summary: 'refactor the pricing table into a shared module', filesChanged: ['pricing.ts', 'transcript.ts'], linesAdded: 40, linesRemoved: 30 }))).toBe(true);
    // short but real, with a diff → kept
    expect(isSubstantiveMemory(entry({ summary: 'fix login', filesChanged: ['auth.ts'], linesAdded: 8 }))).toBe(true);
  });
});
