/**
 * Tests for writeAgentRulesFile — the session-start writer that refreshes
 * Origin's `<!-- origin-managed -->` blocks in the repo's agent-context files.
 *
 * The bug: the writer resolved exactly ONE target from the running agent's
 * slug (claude-code → CLAUDE.md, codex → AGENTS.md, gemini → GEMINI.md) and
 * wrote only that. A repo used mostly by one agent therefore kept N context
 * files where exactly one was current and the rest were frozen at whenever
 * that other agent last ran. In the Origin repo itself, on 2026-08-07:
 * CLAUDE.md was same-day, GEMINI.md was stamped 2026-04-16, and AGENTS.md
 * 2026-03-29 — still listing policies that had since been deleted.
 *
 * The contract now: the running agent's own file is created if missing, and
 * EVERY other file already carrying the marker is refreshed on the same
 * trigger — but no file is ever *created* for an agent this repo doesn't use.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeAgentRulesFile, ORIGIN_MANAGED_MARKER } from '../commands/hooks.js';

const M = ORIGIN_MANAGED_MARKER;

let repo: string;
let fakeHome: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;

/** A managed file as it looks after a session that ran months ago. */
const staleBlock = (stamp: string) =>
  `${M}\nOrigin: Session tracking active.\nRecent AI activity: ${stamp}\n${M}\n`;

const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf-8');
const write = (rel: string, body: string) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-managed-'));
  // HOME isolation is not optional here: the cursor branch writes to
  // ~/.cursor/rules/origin.md, and an unisolated run would clobber the
  // developer's real Cursor rules file.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('writeAgentRulesFile — multi-file refresh', () => {
  it('refreshes EVERY origin-managed file, not just the running agent\'s', () => {
    write('CLAUDE.md', staleBlock('2026-03-01'));
    write('AGENTS.md', staleBlock('2026-03-29'));
    write('GEMINI.md', staleBlock('2026-04-16'));
    write('.devin/rules/origin.md', staleBlock('2026-02-10'));
    write('.github/copilot-instructions.md', staleBlock('2026-01-05'));

    // One claude-code session runs. Before the fix this refreshed CLAUDE.md
    // alone and left the other four frozen.
    writeAgentRulesFile('claude-code', 'FRESH CONTEXT 2026-08-07', repo);

    for (const f of [
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.devin/rules/origin.md',
      '.github/copilot-instructions.md',
    ]) {
      expect(read(f), `${f} should carry the fresh block`).toContain('FRESH CONTEXT 2026-08-07');
      expect(read(f), `${f} should not carry stale activity`).not.toContain('Recent AI activity');
    }
  });

  it('refreshes siblings for every agent, not only claude-code', () => {
    write('CLAUDE.md', staleBlock('old'));
    write('AGENTS.md', staleBlock('old'));
    write('GEMINI.md', staleBlock('old'));

    // gemini's own file is GEMINI.md — CLAUDE.md and AGENTS.md are siblings.
    writeAgentRulesFile('gemini', 'FROM GEMINI', repo);
    expect(read('CLAUDE.md')).toContain('FROM GEMINI');
    expect(read('AGENTS.md')).toContain('FROM GEMINI');
    expect(read('GEMINI.md')).toContain('FROM GEMINI');

    // codex's own file is AGENTS.md.
    writeAgentRulesFile('codex', 'FROM CODEX', repo);
    expect(read('CLAUDE.md')).toContain('FROM CODEX');
    expect(read('AGENTS.md')).toContain('FROM CODEX');
    expect(read('GEMINI.md')).toContain('FROM CODEX');
  });

  it('refreshes the legacy .windsurfrules file when the repo still has one', () => {
    write('.windsurfrules', staleBlock('pre-rebrand'));
    writeAgentRulesFile('claude-code', 'FRESH', repo);
    expect(read('.windsurfrules')).toContain('FRESH');
  });

  it('creates the running agent\'s file when absent, but never a sibling', () => {
    // Fresh repo, nothing on disk.
    writeAgentRulesFile('claude-code', 'FRESH', repo);

    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(true);
    // A repo that has never run codex/gemini/copilot must not sprout their
    // context files — that would be Origin littering every repo it touches.
    expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'GEMINI.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.github/copilot-instructions.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.windsurfrules'))).toBe(false);
  });

  it('skips a same-named file that has no origin-managed marker', () => {
    // A hand-written AGENTS.md that Origin has never claimed stays untouched.
    const handWritten = '# Contributor guide\n\nRun `pnpm test` before pushing.\n';
    write('AGENTS.md', handWritten);
    write('CLAUDE.md', staleBlock('old'));

    writeAgentRulesFile('claude-code', 'FRESH', repo);

    expect(read('AGENTS.md')).toBe(handWritten);
    expect(read('CLAUDE.md')).toContain('FRESH');
  });

  it('preserves user content outside the managed block in every file', () => {
    write('CLAUDE.md', `# House rules\n\nNo force-pushes.\n\n${staleBlock('old')}`);
    write('GEMINI.md', `${staleBlock('old')}\n## Notes\n\nKeep this.\n`);

    writeAgentRulesFile('claude-code', 'FRESH', repo);

    expect(read('CLAUDE.md')).toContain('No force-pushes.');
    expect(read('CLAUDE.md')).toContain('FRESH');
    expect(read('GEMINI.md')).toContain('Keep this.');
    expect(read('GEMINI.md')).toContain('FRESH');
  });

  it('refreshes siblings even when the running agent is unknown', () => {
    // finalAgentSlug is passed as '' when detection failed. The repo's
    // context files are still stale and still worth refreshing.
    write('CLAUDE.md', staleBlock('old'));
    write('AGENTS.md', staleBlock('old'));

    writeAgentRulesFile('', 'FRESH', repo);

    expect(read('CLAUDE.md')).toContain('FRESH');
    expect(read('AGENTS.md')).toContain('FRESH');
  });

  it('leaves exactly one marker pair per file across repeated runs', () => {
    write('AGENTS.md', staleBlock('old'));
    writeAgentRulesFile('claude-code', 'ONE', repo);
    writeAgentRulesFile('claude-code', 'TWO', repo);
    writeAgentRulesFile('claude-code', 'THREE', repo);

    const body = read('AGENTS.md');
    expect(body.split(M).length - 1).toBe(2);
    expect(body).toContain('THREE');
    expect(body).not.toContain('ONE');
    expect(body).not.toContain('TWO');
  });

  it('still refreshes repo siblings when the running agent writes to $HOME', () => {
    // cursor's own target is ~/.cursor/rules/origin.md (no marker, Origin owns
    // the whole file). That must not short-circuit the repo-side refresh.
    write('CLAUDE.md', staleBlock('old'));
    writeAgentRulesFile('cursor', 'FRESH', repo);

    expect(read('CLAUDE.md')).toContain('FRESH');
    expect(fs.readFileSync(path.join(fakeHome, '.cursor/rules/origin.md'), 'utf-8')).toBe('FRESH');
    expect(fs.existsSync(path.join(repo, '.cursor'))).toBe(false);
  });
});
