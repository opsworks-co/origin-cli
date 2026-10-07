import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The local prompt DB and the API are other sources `origin search` reads;
// keep them empty so a match can only have come from the git notes.
vi.mock('../local-db.js', () => ({ searchPrompts: () => [] }));
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  isConnectedMode: () => false,
}));

import { searchCommand, searchGitNotes } from '../commands/search.js';

// Exercises the real git-notes read path against a throwaway repo — no
// mocking of git, so a wrong note shape fails here, not in prod.

let repo: string;
let gitConfig: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: gitConfig,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).toString();
}

function commitFile(file: string, content: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  git(['add', file]);
  git(['commit', '-m', `edit ${file}`]);
  return git(['rev-parse', 'HEAD']).trim();
}

function addNote(sha: string, note: unknown): void {
  git(['notes', '--ref=origin', 'add', '-f', '-m', typeof note === 'string' ? note : JSON.stringify(note), sha]);
}

const opts = { limit: 20 };

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-search-notes-'));
  gitConfig = path.join(repo, '.gitconfig-isolated');
  fs.writeFileSync(gitConfig, '[init]\n  defaultBranch = main\n');
  git(['init']);

  // Current shape: everything nested under `origin`, as buildNoteObject writes it.
  addNote(commitFile('a.ts', 'a\n'), {
    origin: {
      version: 1,
      sessionId: 'sess-nested',
      model: 'claude-opus-5-5',
      agent: 'claude-code',
      promptSummary: 'summary only',
      prompts: [
        { index: 0, text: 'rename the zebrafish helper — ünïcödé', timestamp: '2026-09-30T10:00:00.000Z', files: ['a.ts'] },
        { index: 1, text: 'unrelated follow-up' },
      ],
      timestamp: '2026-09-30T11:00:00.000Z',
    },
    attribution_record: { version: 1 },
  });
  // Current shape without a prompts array: falls back to fullPrompt.
  addNote(commitFile('b.ts', 'b\n'), {
    origin: { sessionId: 'sess-full', model: 'gpt-5', fullPrompt: 'make the platypus importer faster', timestamp: '2026-09-29T00:00:00.000Z' },
  });
  // Prompt text withheld: nothing to match, and nothing to crash on.
  addNote(commitFile('c.ts', 'c\n'), {
    origin: { sessionId: 'sess-withheld', promptTextWithheld: true, prompts: [{ index: 0 }], timestamp: '2026-09-29T00:00:00.000Z' },
  });
  // Legacy flat shape still works.
  addNote(commitFile('d.ts', 'd\n'), {
    sessionId: 'sess-flat', model: 'claude', startedAt: '2026-01-01T00:00:00.000Z', prompts: ['flat narwhal prompt'],
  });
  // Plain-text note.
  addNote(commitFile('e.ts', 'e\n'), 'hand-written note about the axolotl');
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('searchGitNotes', () => {
  it('finds a prompt in a current note nested under `origin`', () => {
    const r = searchGitNotes(repo, 'ZEBRAFISH', opts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      sessionId: 'sess-nested',
      agentName: 'claude-code',
      timestamp: '2026-09-30T10:00:00.000Z',
      filesChanged: ['a.ts'],
      promptText: 'rename the zebrafish helper — ünïcödé',
    });
  });

  it('falls back to fullPrompt and the note timestamp when there is no prompts array', () => {
    const r = searchGitNotes(repo, 'platypus', opts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sessionId: 'sess-full', timestamp: '2026-09-29T00:00:00.000Z' });
  });

  it('applies --from to the nested timestamp', () => {
    expect(searchGitNotes(repo, 'zebrafish', { limit: 20, from: new Date('2026-10-01T00:00:00Z') })).toHaveLength(0);
    expect(searchGitNotes(repo, 'zebrafish', { limit: 20, from: new Date('2026-09-01T00:00:00Z') })).toHaveLength(1);
  });

  it('applies --agent to the nested agent slug', () => {
    expect(searchGitNotes(repo, 'zebrafish', { limit: 20, agent: 'cursor' })).toHaveLength(0);
    expect(searchGitNotes(repo, 'zebrafish', { limit: 20, agent: 'claude' })).toHaveLength(1);
  });

  it('still reads legacy flat notes and plain-text notes', () => {
    expect(searchGitNotes(repo, 'narwhal', opts)[0]).toMatchObject({ sessionId: 'sess-flat', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(searchGitNotes(repo, 'axolotl', opts)[0].promptText).toBe('hand-written note about the axolotl');
  });
});

describe('origin search', () => {
  it('prints a prompt that lives only in a current nested note', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      await searchCommand('zebrafish', { repo });
    } finally {
      spy.mockRestore();
    }
    const out = lines.join('\n');
    expect(out).toContain('Found 1 match');
    expect(out).toContain('sess-nes');
  });
});
