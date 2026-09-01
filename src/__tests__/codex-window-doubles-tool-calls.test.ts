/**
 * One authoring, captured twice — and five changes captured once.
 *
 * Prod session c09242d4 (repo vodka, Codex gpt-5.6-terra). One apply_patch
 * changed night.py and zakuski.py by +11/-11; Codex's own UI agreed. The
 * dashboard read +18/-18 in the header and +7/-11 on the turn.
 *
 * Two independent faults, both here:
 *
 *  1. DOUBLE. Codex writes through `apply_patch`, which no live hook sees, so
 *     the live ledger is empty during the turn and `shouldRunShellWindow` lets
 *     the shell-window capture claim the WHOLE turn window as `turn_window`
 *     whole-file edits. The rollout extractor then records the same change
 *     again as proof-grade `tool_call` edits. `mergeLedgerWithTranscript` only
 *     guarded the mirror case (a transcript COMMIT edit for a file the ledger
 *     already proved), so both survived and the file was billed twice.
 *
 *  2. COLLAPSE. That one patch rewrote five identical
 *     `pour="chilled vodka, neat",` rows to `pour=NEAT_POUR,`. The merge's
 *     `seen` set grew with transcript keys as it went, turning a
 *     ledger-vs-transcript check into a transcript-vs-transcript dedupe, so
 *     nine extracted edits were stored as five.
 *
 * Both are agent-agnostic: any agent whose tool calls are invisible to the
 * live ledger (hookless, or sandboxed away from ~/.origin) takes this path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeLedgerWithTranscript, anchorEditPositions } from '../prompt-capture/index.js';
import { SHELL_WINDOW_SOURCE } from '../shell-write-capture.js';
import type { PromptCapture, PromptEdit } from '../prompt-capture/types.js';

const NEAT_OLD = '        pour="chilled vodka, neat",';
const NEAT_NEW = '        pour=NEAT_POUR,';

/** The whole-turn git window the shell-window capture records for a file. */
function windowEdit(file: string): PromptEdit {
  return {
    file,
    op: 'edit',
    oldContent: 'whole file, before\n',
    newContent: 'whole file, after\n',
    source: 'uncommitted',
    evidence: 'turn_window',
    backfillSource: SHELL_WINDOW_SOURCE,
  };
}

function patchEdit(file: string, oldContent: string, newContent: string): PromptEdit {
  return { file, op: 'edit', oldContent, newContent, source: 'tool_call' };
}

describe('a turn_window guess must not be billed alongside the tool call that proves it', () => {
  it('drops the window edit for a file the transcript covers with tool calls', () => {
    const ledger: PromptCapture[] = [{
      promptIndex: 2, promptText: '', agent: 'codex', commits: [],
      edits: [windowEdit('night.py'), windowEdit('zakuski.py')],
    }];
    const transcript: PromptCapture[] = [{
      promptIndex: 2, promptText: 'whatever', agent: 'codex', commits: [],
      edits: [
        patchEdit('zakuski.py', 'ICE = "x"', 'ICE = "x"\n\nNEAT_POUR = "chilled vodka, neat"'),
        patchEdit('night.py', 'from zakuski import SPREAD', 'from zakuski import NEAT_POUR, SPREAD'),
      ],
    }];

    const merged = mergeLedgerWithTranscript(ledger, transcript);

    expect(merged).toHaveLength(1);
    // Only the proof survives — the window edits described the same change.
    expect(merged[0].edits.map((e) => e.source)).toEqual(['tool_call', 'tool_call']);
    expect(merged[0].edits.some((e) => e.evidence === 'turn_window')).toBe(false);
  });

  it('keeps the window edit for a file no tool call explains', () => {
    // The shell-write case the capture exists for: a `sed -i` on notes.md
    // alongside an apply_patch on night.py. Only night.py has proof.
    const ledger: PromptCapture[] = [{
      promptIndex: 0, promptText: '', agent: 'codex', commits: [],
      edits: [windowEdit('night.py'), windowEdit('notes.md')],
    }];
    const transcript: PromptCapture[] = [{
      promptIndex: 0, promptText: 'patch it and note it', agent: 'codex', commits: [],
      edits: [patchEdit('night.py', 'a', 'b')],
    }];

    const merged = mergeLedgerWithTranscript(ledger, transcript);

    expect(merged[0].edits.map((e) => e.file).sort()).toEqual(['night.py', 'notes.md']);
    const kept = merged[0].edits.find((e) => e.file === 'notes.md')!;
    expect(kept.evidence).toBe('turn_window');
    expect(merged[0].edits.filter((e) => e.file === 'night.py')).toHaveLength(1);
  });

  it('still drops a transcript COMMIT edit for a file the ledger already proved', () => {
    // The pre-existing guard, pinned so this change does not loosen it.
    const ledger: PromptCapture[] = [{
      promptIndex: 0, promptText: '', agent: 'claude', commits: [],
      edits: [{ file: 'app.ts', op: 'edit', oldContent: 'a', newContent: 'b', source: 'tool_call' }],
    }];
    const transcript: PromptCapture[] = [{
      promptIndex: 0, promptText: 'go', agent: 'claude', commits: ['bed0aa15'],
      edits: [{ file: 'app.ts', op: 'edit', oldContent: 'older', newContent: 'b', source: 'commit' }],
    }];

    const merged = mergeLedgerWithTranscript(ledger, transcript);
    expect(merged[0].edits).toHaveLength(1);
    expect(merged[0].edits[0].source).toBe('tool_call');
  });
});

describe('one patch, the same replacement five times', () => {
  it('keeps every occurrence instead of folding them into one', () => {
    const transcript: PromptCapture[] = [{
      promptIndex: 2, promptText: 'whatever', agent: 'codex', commits: [],
      edits: Array.from({ length: 5 }, () => patchEdit('zakuski.py', NEAT_OLD, NEAT_NEW)),
    }];
    const ledger: PromptCapture[] = [{
      promptIndex: 2, promptText: '', agent: 'codex', commits: [],
      edits: [windowEdit('zakuski.py')],
    }];

    const merged = mergeLedgerWithTranscript(ledger, transcript);

    // Five rows changed, so five edits — not the one the shared `seen` set left.
    expect(merged[0].edits).toHaveLength(5);
  });

  it('anchors the five at five successive rows, not all at the first', () => {
    // Identical anchors are what let the server's (oldContent, newContent)
    // dedupe treat five changes as one re-emit.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-anchor-'));
    try {
      const rows = Array.from({ length: 5 }, (_, i) => [
        `    Zakuska(`,
        `        name="plate ${i}",`,
        NEAT_NEW,
        `    ),`,
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'zakuski.py'), `HEADER = 1\n${rows.join('\n')}\n`);

      const edits = Array.from({ length: 5 }, () => patchEdit('zakuski.py', NEAT_OLD, NEAT_NEW));
      anchorEditPositions(edits, dir);

      const starts = edits.map((e) => e.newStart);
      expect(new Set(starts).size).toBe(5);
      expect(starts).toEqual([...starts].sort((a, b) => (a || 0) - (b || 0)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a single edit anchored where it always was', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-anchor-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.py'), 'one\ntwo\nthree\n');
      const edits = [patchEdit('a.py', 'x', 'two')];
      anchorEditPositions(edits, dir);
      expect(edits[0].newStart).toBe(2);
      expect(edits[0].oldStart).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
