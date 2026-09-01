// The four context-window costs Origin was paying every turn.
//
// Measured on a live session: the SessionStart block, the per-prompt block and
// the always-loaded CLAUDE.md carried overlapping copies of the same facts, and
// the prompt-scoped retrieval fired on a coincidence. Each item below is one of
// those, pinned so it cannot come back quietly.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSessionMemory, searchMemoryForPrompt } from '../memory.js';
import {
  agentFileCarriesFramework,
  siblingReadsContextFromHook,
  writeAgentRulesFile,
  durableRulesFileMessage,
} from '../commands/hooks.js';

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ctxcost-')));
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
  summary: 'Made the daily brief stop blocking the dashboard on the LLM',
  filesChanged: ['apps/api/src/routes/today-brief.ts'],
  promptCount: 4,
  linesAdded: 120,
  linesRemoved: 30,
  openTodos: [],
  ...over,
});

const FRAMEWORK = 'Origin authoring framework — when there is real signal';
const DIGEST = 'Prior work in this repo (recent sessions):\nRecent focus: everything volatile.';

// ── 4. generic words must not clear the retrieval threshold ────────────────
describe('prompt-scoped retrieval: coincidence vs signal', () => {
  it('does NOT fire on four common words', () => {
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      // The live failure: `origin, memory, every, expensive` scored 4 x 2 = 8,
      // which WAS the bar, and returned the today-brief record above — a
      // different performance problem entirely.
      expect(searchMemoryForPrompt(repo, 'is checking origin memory on every prompt expensive or not?'))
        .toEqual([]);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('still retrieves from distinctive prose with no path or symbol', () => {
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry({
        summary: 'Reworked the notes refspec so a fresh clone fetches them',
        filesChanged: ['packages/cli/src/git-notes.ts'],
      }) as any);
      // The recall capability this must not cost: five distinctive words.
      const hits = searchMemoryForPrompt(repo, 'so a fresh clone fetches the notes refspec');
      expect(hits.length).toBe(1);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('still retrieves when the prompt names the file', () => {
    const repo = makeRepo();
    try {
      writeSessionMemory(repo, entry() as any);
      const hits = searchMemoryForPrompt(repo, 'what happened in today-brief.ts?');
      expect(hits.length).toBe(1);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

// ── 2. the framework has ONE home per context, not two ────────────────────
describe('authoring framework delivery', () => {
  it('reports absent when the rules file does not exist yet', () => {
    const repo = makeRepo();
    try {
      // First session in a repo: the file is written by this very hook, AFTER
      // the harness loaded its context. The hook copy is the only one.
      expect(agentFileCarriesFramework('claude-code', repo)).toBe(false);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('reports present once CLAUDE.md carries it', () => {
    const repo = makeRepo();
    try {
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), `<!-- origin-managed -->\n${FRAMEWORK} …\n<!-- origin-managed -->\n`);
      expect(agentFileCarriesFramework('claude-code', repo)).toBe(true);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('never suppresses for an agent that reads its context from a FILE', () => {
    const repo = makeRepo();
    try {
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), `<!-- origin-managed -->\n${FRAMEWORK} …\n<!-- origin-managed -->\n`);
      // Codex gets no hook payload at all — suppressing there would deliver
      // the framework nowhere.
      expect(agentFileCarriesFramework('codex', repo)).toBe(false);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

// ── 3. a sibling refresh must not plant a volatile digest ─────────────────
describe('sibling rules-file refresh', () => {
  it('classifies hook-reading siblings apart from file-driven ones', () => {
    expect(siblingReadsContextFromHook('CLAUDE.md')).toBe(true);
    expect(siblingReadsContextFromHook('GEMINI.md')).toBe(true);
    // AGENTS.md is Codex/Antigravity — their only delivery channel.
    expect(siblingReadsContextFromHook('AGENTS.md')).toBe(false);
    expect(siblingReadsContextFromHook(path.join('.devin', 'rules', 'origin.md'))).toBe(false);
  });

  it('THE BUG: a Cursor session must not write the digest into CLAUDE.md', () => {
    const repo = makeRepo();
    try {
      const full = `Origin: Session tracking active.\n\n${DIGEST}\n\n${FRAMEWORK} …`;
      const durable = durableRulesFileMessage(full, DIGEST, 'cursor');
      expect(durable).toBeTruthy();

      // Pre-existing managed files, as a repo used by several agents has.
      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        fs.writeFileSync(path.join(repo, f), '<!-- origin-managed -->\nold\n<!-- origin-managed -->\n');
      }

      // Cursor is running: CLAUDE.md is a SIBLING, not its own file.
      writeAgentRulesFile('cursor', full, repo, durable);

      const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
      // The next Claude session loads this file as always-on context. It must
      // not find a digest written for someone else's task — which by then is
      // also stale, and disagrees with the fresh one the hook delivers.
      expect(claude).not.toContain('Prior work in this repo');
      expect(claude).toContain('Origin authoring framework');

      // AGENTS.md keeps the full text: it is Codex's ONLY channel.
      expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toContain('Prior work in this repo');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
