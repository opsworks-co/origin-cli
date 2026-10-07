/**
 * A big file's small change reaches the ledger as evidence.
 *
 * recordProbedShellEdits — the slot Cursor's edit hook, the shell probe and
 * the write journal all record through — measured LIVE_EDIT_CONTENT_MAX
 * (96 KB) against the whole file, old + new, and dropped anything over it.
 * Prod 2ecac40a turn 2 edited a 153 KB `session-state.ts`: the hook named it,
 * the ledger declined it, and the turn's content for that file never existed
 * (Origin TODO eea76ca6). The shell window had solved the same thing in #1379
 * by trimming the pair to its changed region before the cap; this is the same
 * trim, in the same shape (an `edit` anchored at the region's first line), for
 * the evidence slot. Driven against real git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordProbedShellEdits } from '../commands/hooks/stop.js';
import { LIVE_EDIT_CONTENT_MAX } from '../commands/hooks.js';

let repo: string;
let baseline: string;
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

// ~90 KB each side, so old + new is ~180 KB: well over the cap as a pair,
// while the one-line change trims to a few hundred bytes.
const FILLER = Array.from({ length: 1500 }, (_, i) => `# filler line ${i} ${'x'.repeat(40)}`);
const BIG_BEFORE = [...FILLER.slice(0, 700), 'VALUE = "before"', ...FILLER.slice(700)].join('\n') + '\n';
const BIG_AFTER = [...FILLER.slice(0, 700), 'VALUE = "after"', ...FILLER.slice(700)].join('\n') + '\n';

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-big-evidence-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  write('big.py', BIG_BEFORE);
  write('small.py', 'a = 1\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  baseline = git(['rev-parse', 'HEAD']);
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

const state = () => ({ sessionId: '11111111-2222-4333-8444-555555555555', repoPath: repo, prompts: ['go'], liveEdits: [] }) as any;
const edits = (s: any) => ((s.liveEdits || []) as any[]).flatMap((e) => e.edits);

describe('a big file edited through an evidence slot keeps its change', () => {
  it('records the changed region as an anchored edit instead of dropping the file', () => {
    expect(BIG_BEFORE.length + BIG_AFTER.length).toBeGreaterThan(LIVE_EDIT_CONTENT_MAX);
    write('big.py', BIG_AFTER);
    const s = state();
    const changed = recordProbedShellEdits(s, repo, baseline, 0, ['big.py'],
      { toolLabel: 'origin:edit-hook', evidence: 'edit_hook' });
    expect(changed, 'the only file of the observation was dropped').toBe(true);
    const [e] = edits(s);
    expect(e.file).toBe('big.py');
    expect(e.op).toBe('edit');
    expect(e.evidence).toBe('edit_hook');
    expect(e.oldContent).toContain('VALUE = "before"');
    expect(e.newContent).toContain('VALUE = "after"');
    expect(e.oldContent.length + e.newContent.length).toBeLessThanOrEqual(LIVE_EDIT_CONTENT_MAX);
    // The region starts three context lines above the changed line (1-based).
    expect(e.oldStart).toBe(701 - 3);
    expect(e.newStart).toBe(e.oldStart);
  });

  it('leaves a small file exactly as before: a whole-file write, no anchor', () => {
    write('small.py', 'a = 2\n');
    const s = state();
    recordProbedShellEdits(s, repo, baseline, 0, ['small.py'],
      { toolLabel: 'origin:write-journal', evidence: 'write_journal' });
    const [e] = edits(s);
    expect(e.op).toBe('write');
    expect(e.oldContent).toBe('a = 1\n');
    expect(e.newContent).toBe('a = 2\n');
    expect(e.oldStart).toBeUndefined();
  });

  it('still drops a change that is genuinely too large after trimming, and says so with a false', () => {
    // Every line changes, so there is nothing to shed.
    write('big.py', FILLER.map((l) => l.replace('filler', 'rewritten')).join('\n') + '\n');
    const s = state();
    const changed = recordProbedShellEdits(s, repo, baseline, 0, ['big.py'],
      { toolLabel: 'origin:edit-hook', evidence: 'edit_hook' });
    expect(changed).toBe(false);
    expect(edits(s)).toEqual([]);
  });

  it('still drops an oversized create: a new file is all change', () => {
    // Twice the filler: a create has no old side, so one copy would fit.
    write('huge-new.py', [...FILLER, ...FILLER].join('\n') + '\n');
    const s = state();
    const changed = recordProbedShellEdits(s, repo, baseline, 0, ['huge-new.py'],
      { toolLabel: 'origin:write-journal', evidence: 'write_journal' });
    expect(changed).toBe(false);
    expect(edits(s)).toEqual([]);
  });
});
