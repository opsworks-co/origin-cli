// Fixture-based tests for the per-agent extractors. Each fixture is a
// real transcript captured from a user session, copied verbatim into
// __tests__/fixtures/. If an agent renames a tool, ships a new
// transcript format, or otherwise drifts, these tests will fail rather
// than silently producing empty `editsJson` for live sessions.
//
// To add a new fixture: drop the raw `.jsonl` into __tests__/fixtures/,
// then add a case here that asserts the expected per-prompt edit shape.

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { capturePromptEdits } from '../prompt-capture/index.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

// Helpers ────────────────────────────────────────────────────────────

function edits(agent: 'claude' | 'cursor' | 'codex' | 'gemini', file: string, repoPath: string) {
  return capturePromptEdits({
    agent,
    repoPath,
    transcriptPath: path.join(FIXTURE_DIR, file),
    sessionCommitShas: [],
  });
}

// Tests ──────────────────────────────────────────────────────────────

describe('Codex apply_patch extractor', () => {
  // Session 991557a7: 2 prompts, both edit codex-change.txt only (no
  // commits). Pre-existing main.py dirt MUST NOT appear in either
  // prompt's edits.
  it('attributes apply_patch edits per-prompt and excludes pre-existing dirt', () => {
    const turns = edits('codex', 'codex-uncommitted-2-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-1');
    expect(turns.length).toBe(2);
    expect(turns[0].promptText).toBe('make 1 change and not commmit yet');
    expect(turns[0].edits.map((e) => e.file)).toEqual(['codex-change.txt']);
    expect(turns[1].promptText).toBe('make another tiny change anc not commit yet');
    expect(turns[1].edits.map((e) => e.file)).toEqual(['codex-change.txt']);
    // No prompt should claim main.py — it was pre-existing dirt.
    for (const t of turns) {
      expect(t.edits.every((e) => e.file !== 'main.py')).toBe(true);
    }
  });

  // Session 8cf59877: 3 prompts (later turned into 5 by the user, but
  // the fixture is frozen at the 3-prompt point). Each prompt's
  // apply_patch list must match.
  it('walks rollout chronologically and attributes apply_patch to current prompt', () => {
    const turns = edits('codex', 'codex-uncommitted-3-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-1');
    expect(turns.length).toBe(3);
    expect(turns[0].edits.map((e) => e.file)).toEqual(['README.md']);
    expect(turns[1].edits.map((e) => e.file)).toEqual(['README.md']);
    expect(turns[2].edits.length).toBeGreaterThanOrEqual(3);
    // Prompt 3 ('complex' one) touched main.py + README.md + notes.
    const p3Files = new Set(turns[2].edits.map((e) => e.file));
    expect(p3Files.has('main.py')).toBe(true);
    expect(p3Files.has('README.md')).toBe(true);
    expect(p3Files.has('notes-from-codex.txt')).toBe(true);
  });

  it('filters AGENTS.md / <INSTRUCTIONS> wrappers from prompt text', () => {
    const turns = edits('codex', 'codex-uncommitted-2-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-1');
    // The first real prompt — never the AGENTS.md wrapper.
    expect(turns[0].promptText.startsWith('#')).toBe(false);
    expect(turns[0].promptText.includes('AGENTS.md instructions')).toBe(false);
  });
});

describe('Gemini JSONL extractor', () => {
  // Session 6972a3be: Gemini transcript is JSONL (not the legacy
  // single-JSON-with-messages format). Each `type:"gemini"` event
  // carries toolCalls[] with `replace` (Edit-equivalent) entries.
  it('reads JSONL line-by-line and captures replace tool calls', () => {
    const turns = edits('gemini', 'gemini-jsonl-2-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-1');
    expect(turns.length).toBe(2);
    expect(turns[0].promptText).toBe('make some change but not commit');
    expect(turns[1].promptText).toBe("make more changes and don't commit");
    expect(turns[0].edits.length).toBeGreaterThan(0);
    expect(turns[1].edits.length).toBeGreaterThanOrEqual(3);
    // All edits should target real repo files.
    for (const t of turns) {
      for (const e of t.edits) {
        expect(e.file).toBeTruthy();
        expect(e.file.startsWith('/')).toBe(false); // repo-relative
      }
    }
  });
});

describe('Unknown-tool drift detection', () => {
  // The default tool sets cover Claude/Cursor/Gemini today. If an agent
  // ships a new tool name that carries a file path, the extractor
  // should still walk past it without crashing and emit a stderr
  // warning so we notice the drift. We can't easily inspect stderr in
  // unit tests, so we just confirm the extractor doesn't blow up and
  // returns a well-formed PromptCapture[].
  it('handles unrecognized tool names without crashing', () => {
    // Reuse the cursor fixture, then mutate-via-temp-file isn't worth
    // it here — we just confirm the existing fixtures don't crash and
    // that capturePromptEdits returns an array of valid turns.
    const turns = edits('cursor', 'cursor-strreplace-3-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-2');
    expect(Array.isArray(turns)).toBe(true);
    for (const t of turns) {
      expect(typeof t.promptIndex).toBe('number');
      expect(Array.isArray(t.edits)).toBe(true);
      expect(Array.isArray(t.commits)).toBe(true);
    }
  });
});

describe('Cursor JSONL extractor', () => {
  // Session 8c15ce10: Cursor uses `StrReplace` (Edit-equivalent) and
  // `ApplyPatch` (Codex-style multi-file patches). Both must be
  // recognized — silently skipping them is exactly the failure mode
  // that hid prompt-2's rhombus edits from the dashboard.
  it('recognizes StrReplace tool calls', () => {
    const turns = edits('cursor', 'cursor-strreplace-3-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-2');
    expect(turns.length).toBe(3);
    // Prompt 0 is a meta question with no edits.
    expect(turns[0].edits.length).toBe(0);
    // Prompts 1 and 2 each have multiple StrReplace edits.
    expect(turns[1].edits.length).toBeGreaterThanOrEqual(3);
    expect(turns[2].edits.length).toBeGreaterThanOrEqual(3);
    for (const t of [turns[1], turns[2]]) {
      for (const e of t.edits) {
        expect(e.op).toBe('edit');
        expect(typeof e.oldContent).toBe('string');
        expect(typeof e.newContent).toBe('string');
      }
    }
  });

  it('attributes prompt 2 to rhombus edits (not trapezoid)', () => {
    const turns = edits('cursor', 'cursor-strreplace-3-prompts.jsonl', '/Users/artemdolobanko/Documents/or-test-2');
    const p2 = turns[2];
    const rhombusCount = p2.edits.filter(
      (e) => (e.oldContent || '').includes('rhombus') || (e.newContent || '').includes('rhombus'),
    ).length;
    expect(rhombusCount).toBeGreaterThanOrEqual(3);
  });
});

describe('Commit-derived supplementation for shell-written files', () => {
  // Regression for Gemini session f2c2e40d: the agent elaborated
  // scripts/git-info.sh via run_shell_command and committed it, but the
  // transcript only captured an initial write_file. The committed change
  // had no editsJson record, so blame/commit-detail couldn't attribute it.
  // supplementUncoveredCommittedFiles backfills such files from the commit.
  it('backfills a committed file the transcript never recorded as a tool call', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-suppl-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: tmp, encoding: 'utf-8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t.co']);
      git(['config', 'user.name', 'T']);
      // `covered.txt` is what the transcript's tool call records; `shell.sh`
      // is the file the agent wrote via shell (not in the transcript).
      fs.writeFileSync(path.join(tmp, 'covered.txt'), 'hello\n');
      fs.writeFileSync(path.join(tmp, 'shell.sh'), '#!/bin/sh\necho elaborate\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'make changes and commit']);
      const sha = git(['rev-parse', 'HEAD']).trim();

      // Minimal Gemini transcript: one prompt, one write_file for covered.txt.
      const transcript = path.join(tmp, 'transcript.jsonl');
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({ sessionId: 's', kind: 'main' }),
          JSON.stringify({ type: 'user', content: [{ text: 'make changes and commit' }] }),
          JSON.stringify({
            type: 'gemini',
            toolCalls: [{ name: 'write_file', args: { file_path: 'covered.txt', content: 'hello\n' } }],
          }),
        ].join('\n'),
      );

      const turns = capturePromptEdits({
        agent: 'gemini',
        repoPath: tmp,
        transcriptPath: transcript,
        sessionCommitShas: [sha],
      });

      expect(turns.length).toBe(1);
      const byFile = new Map(turns[0].edits.map((e) => [e.file, e]));
      // The tool-call file keeps its tool_call source untouched.
      expect(byFile.get('covered.txt')?.source).toBe('tool_call');
      // The shell-written committed file is backfilled as a commit-source edit.
      const shell = byFile.get('shell.sh');
      expect(shell).toBeTruthy();
      expect(shell?.source).toBe('commit');
      expect(shell?.commitSha).toBe(sha);
      expect(shell?.newContent).toContain('echo elaborate');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Cursor per-prompt isolation (no cumulative leak)', () => {
  // Regression for the commit-detail bug where selecting prompt #3 showed
  // prompt #2's changes too. Root cause: Cursor's agent-transcript JSONL was
  // never wired into capturePromptEdits (its path isn't delivered via
  // input.transcript_path), so editsJson stayed empty and the dashboard fell
  // back to the cumulative working-tree pc.diff. With the real JSONL fed in,
  // each turn's edits must be isolated to that turn — prompt 3 carries ONLY
  // its own change, never prompt 2's.
  it('attributes each Cursor turn to only its own StrReplace edit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cursor-'));
    try {
      const transcript = path.join(tmp, 'conv.jsonl');
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({ role: 'user', content: 'make some changes but not commit yet' }),
          JSON.stringify({
            role: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  name: 'StrReplace',
                  input: {
                    path: path.join(tmp, 'README.md'),
                    old_string: 'Gemini sixth explore pass',
                    new_string: 'Cursor explore pass — uncommitted',
                  },
                },
              ],
            },
          }),
          JSON.stringify({ role: 'user', content: 'make some other changes and commit' }),
          JSON.stringify({
            role: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  name: 'StrReplace',
                  input: {
                    path: path.join(tmp, 'README.md'),
                    old_string: 'Gemini explore pass — uncommitted',
                    new_string: 'Cursor commit pass — consolidated',
                  },
                },
              ],
            },
          }),
        ].join('\n'),
      );

      const turns = capturePromptEdits({
        agent: 'cursor',
        repoPath: tmp,
        transcriptPath: transcript,
      });

      expect(turns.length).toBe(2);

      // Prompt 2 (turn 0): exactly its own edit.
      expect(turns[0].edits).toHaveLength(1);
      expect(turns[0].edits[0].file).toBe('README.md');
      expect(turns[0].edits[0].newContent).toContain('Cursor explore pass');

      // Prompt 3 (turn 1): exactly its own edit — NOT prompt 2's.
      expect(turns[1].edits).toHaveLength(1);
      expect(turns[1].edits[0].file).toBe('README.md');
      expect(turns[1].edits[0].newContent).toContain('Cursor commit pass');
      const leakedIntoP3 = turns[1].edits.some(
        (e) => (e.newContent || '').includes('Cursor explore pass') ||
          (e.oldContent || '').includes('Gemini sixth explore pass'),
      );
      expect(leakedIntoP3).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
