// Unit tests for the live-capture core: turning a PostToolUse payload into
// PromptEdits, folding the ledger into per-prompt captures, and merging it
// with the transcript capture. These are the pure functions behind the
// real-time blame ledger — no IO, so they pin behavior directly.

import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractEditsFromToolCall,
  anchorEditPositions,
  buildCapturesFromLedger,
  mergeLedgerWithTranscript,
  type LiveEditEntry,
} from '../prompt-capture/index.js';
import type { PromptCapture, PromptEdit } from '../prompt-capture/types.js';

const REPO = '/repo';

describe('extractEditsFromToolCall', () => {
  it('maps an Edit tool call to one edit with exact old/new content', () => {
    const out = extractEditsFromToolCall('Edit', {
      file_path: '/repo/src/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    }, REPO);
    expect(out).toEqual([{
      file: 'src/app.ts',
      op: 'edit',
      oldContent: 'const a = 1;',
      newContent: 'const a = 2;',
      source: 'tool_call',
    }]);
  });

  it('maps a Write tool call to a single write edit', () => {
    const out = extractEditsFromToolCall('Write', {
      file_path: '/repo/README.md',
      content: '# Title\n',
    }, REPO);
    expect(out).toEqual([{
      file: 'README.md',
      op: 'write',
      newContent: '# Title\n',
      source: 'tool_call',
    }]);
  });

  it('expands a MultiEdit into one edit per change', () => {
    const out = extractEditsFromToolCall('MultiEdit', {
      file_path: '/repo/a.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'p', new_string: 'q' },
      ],
    }, REPO);
    expect(out).toHaveLength(2);
    expect(out.map((e) => [e.oldContent, e.newContent])).toEqual([['x', 'y'], ['p', 'q']]);
    expect(out.every((e) => e.file === 'a.ts' && e.op === 'edit')).toBe(true);
  });

  it('parses an apply_patch payload into per-file edits', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/x.ts',
      '@@',
      '-old line',
      '+new line',
      '*** End Patch',
    ].join('\n');
    const out = extractEditsFromToolCall('apply_patch', { input: patch }, REPO);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].file).toBe('src/x.ts');
  });

  it('returns nothing for a non-edit tool (Bash) and for missing file paths', () => {
    expect(extractEditsFromToolCall('Bash', { command: 'ls' }, REPO)).toEqual([]);
    expect(extractEditsFromToolCall('Edit', { old_string: 'a', new_string: 'b' }, REPO)).toEqual([]);
    expect(extractEditsFromToolCall('', {}, REPO)).toEqual([]);
  });
});

describe('buildCapturesFromLedger', () => {
  it('groups ledger entries by prompt index, preserving order', () => {
    const ledger: LiveEditEntry[] = [
      { promptIndex: 0, toolName: 'Edit', edits: [{ file: 'a.ts', op: 'edit', oldContent: '1', newContent: '2', source: 'tool_call' }] },
      { promptIndex: 1, toolName: 'Write', edits: [{ file: 'b.ts', op: 'write', newContent: 'x', source: 'tool_call' }] },
      { promptIndex: 0, toolName: 'Edit', edits: [{ file: 'c.ts', op: 'edit', oldContent: '3', newContent: '4', source: 'tool_call' }] },
    ];
    const caps = buildCapturesFromLedger(ledger);
    expect(caps.map((c) => c.promptIndex)).toEqual([0, 1]);
    expect(caps[0].edits.map((e) => e.file)).toEqual(['a.ts', 'c.ts']);
    expect(caps[1].edits.map((e) => e.file)).toEqual(['b.ts']);
    expect(caps.every((c) => c.agent === 'claude' && c.commits.length === 0)).toBe(true);
  });

  it('skips empty entries and returns [] for an empty ledger', () => {
    expect(buildCapturesFromLedger([])).toEqual([]);
    expect(buildCapturesFromLedger([{ promptIndex: 0, edits: [] }])).toEqual([]);
  });
});

describe('mergeLedgerWithTranscript', () => {
  const ledgerEdit = { file: 'a.ts', op: 'edit' as const, oldContent: '1', newContent: '2', source: 'tool_call' as const };

  it('passes the transcript through unchanged when the ledger is empty', () => {
    const transcript: PromptCapture[] = [
      { promptIndex: 0, promptText: 'do it', agent: 'claude', edits: [ledgerEdit], commits: ['abc'] },
    ];
    expect(mergeLedgerWithTranscript([], transcript)).toBe(transcript);
  });

  it('dedupes the identical tool-call edit and takes promptText + commits from the transcript', () => {
    const ledger: PromptCapture[] = [
      { promptIndex: 0, promptText: '', agent: 'claude', edits: [ledgerEdit], commits: [] },
    ];
    const transcript: PromptCapture[] = [
      { promptIndex: 0, promptText: 'fix the bug', agent: 'claude', edits: [ledgerEdit], commits: ['sha1'] },
    ];
    const merged = mergeLedgerWithTranscript(ledger, transcript);
    expect(merged).toHaveLength(1);
    expect(merged[0].edits).toHaveLength(1); // not double-counted
    expect(merged[0].promptText).toBe('fix the bug');
    expect(merged[0].commits).toEqual(['sha1']);
  });

  it('keeps a transcript shell/commit edit for a DIFFERENT file the ledger never saw', () => {
    const ledger: PromptCapture[] = [
      { promptIndex: 0, promptText: '', agent: 'claude', edits: [ledgerEdit], commits: [] },
    ];
    const shellEdit = { file: 'gen.sh', op: 'write' as const, newContent: '#!/bin/sh\n', source: 'commit' as const, commitSha: 'sha9' };
    const transcript: PromptCapture[] = [
      { promptIndex: 0, promptText: 'p', agent: 'claude', edits: [shellEdit], commits: ['sha9'] },
    ];
    const merged = mergeLedgerWithTranscript(ledger, transcript);
    expect(merged[0].edits.map((e) => e.file).sort()).toEqual(['a.ts', 'gen.sh']);
  });

  it('drops a transcript commit edit for a file the ledger already covers with a tool_call (no double count)', () => {
    const ledger: PromptCapture[] = [
      { promptIndex: 0, promptText: '', agent: 'claude', edits: [ledgerEdit], commits: [] },
    ];
    // Same file (a.ts) but the transcript backfilled it whole-file from a commit.
    const commitWholeFile = { file: 'a.ts', op: 'write' as const, newContent: 'whole file\n', source: 'commit' as const, commitSha: 'sha2' };
    const transcript: PromptCapture[] = [
      { promptIndex: 0, promptText: 'p', agent: 'claude', edits: [commitWholeFile], commits: ['sha2'] },
    ];
    const merged = mergeLedgerWithTranscript(ledger, transcript);
    expect(merged[0].edits).toHaveLength(1);
    expect(merged[0].edits[0].source).toBe('tool_call');
    expect(merged[0].commits).toEqual(['sha2']); // commit linkage still carried
  });

  it('re-homes resume-collided ledger edits to the transcript prompt that authored them (prod e0d3ddc9)', () => {
    // After a resume the live counter reset, so turn 4's edit was filed under
    // index 0 and turn 5's whole-file write under index 1 — colliding with the
    // chat-only turn 0 and turn 1's create. The transcript (parsed from the
    // full conversation) has the correct per-prompt structure.
    const create = { file: 'pups', op: 'write' as const, newContent: ['r1','r2','r3','r4','r5','r6','r7','r8','r9','r10'].join('\n'), source: 'tool_call' as const };
    const write12 = { file: 'pups', op: 'write' as const, newContent: Array.from({ length: 12 }, (_, i) => `w${i}`).join('\n'), source: 'tool_call' as const };
    const edit5 = { file: 'pups', op: 'edit' as const, oldContent: 'w11', newContent: 'w11\ne1\ne2\ne3\ne4\ne5', source: 'tool_call' as const };
    const edit4 = { file: 'pups', op: 'edit' as const, oldContent: 'w5', newContent: 'w5\nf1\nf2\nf3\nf4', source: 'tool_call' as const };
    const write19 = { file: 'pups', op: 'write' as const, newContent: Array.from({ length: 19 }, (_, i) => `x${i}`).join('\n'), source: 'tool_call' as const };
    // Ledger grouped by the COLLIDED indices (buildCapturesFromLedger output).
    const ledger: PromptCapture[] = [
      { promptIndex: 0, promptText: '', agent: 'claude', edits: [edit4], commits: [] },              // turn 4 mis-filed
      { promptIndex: 1, promptText: '', agent: 'claude', edits: [create, write19], commits: [] },     // turn 1 create + turn 5 write mis-filed
      { promptIndex: 2, promptText: '', agent: 'claude', edits: [write12], commits: [] },
      { promptIndex: 3, promptText: '', agent: 'claude', edits: [edit5], commits: [] },
    ];
    // Transcript: correct absolute structure across all six turns.
    const transcript: PromptCapture[] = [
      { promptIndex: 0, promptText: 'check uncommitted', agent: 'claude', edits: [], commits: [] },
      { promptIndex: 1, promptText: 'create pups', agent: 'claude', edits: [create], commits: [] },
      { promptIndex: 2, promptText: 'remove 2 add 4', agent: 'claude', edits: [write12], commits: [] },
      { promptIndex: 3, promptText: 'add 5', agent: 'claude', edits: [edit5], commits: [] },
      { promptIndex: 4, promptText: 'add 4', agent: 'claude', edits: [edit4], commits: [] },
      { promptIndex: 5, promptText: 'add 3 remove 5', agent: 'claude', edits: [write19], commits: [] },
    ];
    const merged = mergeLedgerWithTranscript(ledger, transcript);
    const byIdx = new Map(merged.map((c) => [c.promptIndex, c]));
    expect(byIdx.get(0)!.edits).toHaveLength(0);                          // no P4 edit welded onto chat turn
    expect(byIdx.get(1)!.edits.map((e) => e.newContent)).toEqual([create.newContent]); // ONLY the create, no P5 write
    expect(byIdx.get(2)!.edits.map((e) => e.newContent)).toEqual([write12.newContent]);
    expect(byIdx.get(3)!.edits.map((e) => e.newContent)).toEqual([edit5.newContent]);
    expect(byIdx.get(4)!.edits.map((e) => e.newContent)).toEqual([edit4.newContent]);
    expect(byIdx.get(5)!.edits.map((e) => e.newContent)).toEqual([write19.newContent]);
  });

  it('carries a transcript-only prompt the ledger has no entry for', () => {
    const ledger: PromptCapture[] = [
      { promptIndex: 0, promptText: '', agent: 'claude', edits: [ledgerEdit], commits: [] },
    ];
    const transcript: PromptCapture[] = [
      { promptIndex: 1, promptText: 'second prompt', agent: 'claude', edits: [
        { file: 'z.ts', op: 'edit', oldContent: 'a', newContent: 'b', source: 'tool_call' },
      ], commits: [] },
    ];
    const merged = mergeLedgerWithTranscript(ledger, transcript);
    expect(merged.map((c) => c.promptIndex)).toEqual([0, 1]);
    expect(merged[1].promptText).toBe('second prompt');
  });
});

describe('anchorEditPositions', () => {
  // anchorEditPositions reads the on-disk file (the post-edit state at
  // PostToolUse time) to stamp each edit with the real line it begins at,
  // so the server's synthesized diff no longer anchors every hunk at
  // line 1. We create a real temp repo to exercise the file read.
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-anchor-'));
  });

  it('stamps the real 1-based line of an edit deep in a file', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[22] = 'TARGET marker here'; // file line 23 (0-based 22)
    fs.writeFileSync(path.join(repo, 'first-file.txt'), lines.join('\n') + '\n');
    const edits: PromptEdit[] = [
      {
        file: 'first-file.txt',
        op: 'edit',
        oldContent: 'old text',
        newContent: 'TARGET marker here',
        source: 'tool_call',
      },
    ];
    anchorEditPositions(edits, repo);
    expect(edits[0].newStart).toBe(23);
    expect(edits[0].oldStart).toBe(23);
  });

  it('anchors a whole-file write at line 1', () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'a\nb\nc\n');
    const edits: PromptEdit[] = [
      { file: 'new.txt', op: 'write', newContent: 'a\nb\nc\n', source: 'tool_call' },
    ];
    anchorEditPositions(edits, repo);
    expect(edits[0].newStart).toBe(1);
  });

  it('leaves the edit unanchored when the file is unreadable', () => {
    const edits: PromptEdit[] = [
      { file: 'does-not-exist.txt', op: 'edit', oldContent: 'x', newContent: 'y', source: 'tool_call' },
    ];
    anchorEditPositions(edits, repo);
    expect(edits[0].newStart).toBeUndefined();
    expect(edits[0].oldStart).toBeUndefined();
  });

  it('skips deletions (their content is gone) without throwing', () => {
    fs.writeFileSync(path.join(repo, 'd.txt'), 'kept\n');
    const edits: PromptEdit[] = [
      { file: 'd.txt', op: 'delete', oldContent: 'removed line', source: 'tool_call' },
    ];
    anchorEditPositions(edits, repo);
    expect(edits[0].newStart).toBeUndefined();
  });
});
