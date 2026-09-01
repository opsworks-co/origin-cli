/**
 * The concurrent-attribution feedback loop, re-armed through a different door.
 *
 * `uncommittedExcludeUnion` breaks the original loop by sourcing ownership
 * from the live ledger instead of from completedPromptMappings: mappings are
 * the surface a leak corrupts, so trusting them to define ownership lets one
 * bad attribution disable the guard that would have caught the next one. Its
 * comment says the ledger "cannot feed that loop back: it only ever records a
 * tool call WE made."
 *
 * That premise expired. The shell capture paths write to the same ledger, and
 * they INFER their file lists from a bare baseline..working-tree diff —
 * `__shell_probe__` per command, `origin:shell-window` per turn. On a shared
 * checkout that diff is precisely the sibling work the exclusion exists to
 * subtract, so an inferred entry is the exclusion's own OUTPUT being fed back
 * in as its INPUT. `evidence: 'command_probe'` reads like proof and is not: it
 * means the tree moved while one of our commands ran, which with five sibling
 * agents on one checkout says nothing about authorship.
 *
 * Measured on session 6e9947a5 (origin repo, six concurrent RUNNING sessions).
 * Its entire ledger was the two inferred entries reproduced below, both naming
 * `apps/api/src/services/reconstructed-commits.ts` — a file that session never
 * opened, written by the sibling that went on to commit it as 981db358. The
 * file was therefore "ours", the exclusion skipped it, and the session's own
 * turn was credited with it while the file it DID write went unrecorded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uncommittedExcludeUnion } from '../commands/hooks.js';

const FOREIGN = 'apps/api/src/services/reconstructed-commits.ts';
const OURS = 'apps/web/src/pages/Policies.tsx';

describe('uncommittedExcludeUnion — inferred ledger entries are not ownership', () => {
  let repo: string;
  let gitDir: string;

  const writeState = (tag: string, state: Record<string, unknown>) => {
    fs.writeFileSync(path.join(gitDir, `origin-session-${tag}.json`), JSON.stringify(state));
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-inf-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    gitDir = path.join(repo, '.git');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // Verbatim shape of 6e9947a5's two ledger entries.
  const inferredLedger = () => [
    {
      promptIndex: 0,
      toolName: '__shell_probe__',
      capturedAt: new Date().toISOString(),
      edits: [{ file: FOREIGN, op: 'write', source: 'uncommitted', evidence: 'command_probe' }],
    },
    {
      promptIndex: 0,
      toolName: 'origin:shell-window',
      capturedAt: new Date().toISOString(),
      edits: [{
        file: FOREIGN, op: 'edit', source: 'uncommitted',
        evidence: 'turn_window', backfillSource: 'shell-window',
      }],
    },
  ];

  const theirs = (files: string[]) => ({
    sessionId: 'theirs',
    sessionTag: 'theirs',
    repoPath: repo,
    completedPromptMappings: [{ promptIndex: 0, filesChanged: files }],
  });

  it("a tree-inferred shell entry does NOT make a sibling's file ours", () => {
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: inferredLedger(),
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    writeState('theirs', theirs([FOREIGN]));

    expect(uncommittedExcludeUnion(ours as any)).toContain(FOREIGN);
  });

  it('a real tool-call entry still makes the file ours', () => {
    // The filter must not swing the other way: a genuine Edit/Write is proof,
    // and a sibling claiming the same file must not take it from us.
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: [{
        promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(),
        edits: [{ file: OURS, op: 'edit', source: 'tool_call', oldContent: 'a', newContent: 'b' }],
      }],
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    writeState('theirs', theirs([OURS]));

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(OURS);
  });

  it('an entry with no source at all is still ours (pre-field captures)', () => {
    // `source` became required later; a state file written by an older CLI has
    // tool-call entries without it. Those must keep counting, or upgrading the
    // CLI would blank an in-flight session's ownership.
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: [{
        promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(),
        edits: [{ file: OURS, op: 'edit', oldContent: 'a', newContent: 'b' }],
      }],
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    writeState('theirs', theirs([OURS]));

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(OURS);
  });

  it('an inferred-only ledger falls through to the mappings fallback', () => {
    // A shell-only session must not end up with an EMPTY ownership set and
    // watch its own work subtracted. Once inferred entries stop counting the
    // ledger is empty for ownership purposes, so ownEditedFiles falls back to
    // our mappings — the documented path for a session with no tool-call
    // ledger at all (ORIGIN_LIVE_CAPTURE=0, or an older state file).
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: inferredLedger(),
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [OURS] }],
    };
    writeState('ours', ours);
    writeState('theirs', theirs([OURS, FOREIGN]));

    const exclude = uncommittedExcludeUnion(ours as any);
    expect(exclude).toContain(FOREIGN);   // theirs, no longer laundered as ours
    expect(exclude).not.toContain(OURS);  // still defended by the fallback
  });

  it("a 'commit'-source entry stays ours — it went through the trailer check", () => {
    // Deliberately narrower than the shell-window capture's own
    // `!source || source === 'tool_call'` test. A `source:'commit'` edit is
    // appended for a sha that dropForeignCommitsFromCapture already vetted by
    // trailer and committer identity; that is a real ownership check, whereas
    // a tree diff is none.
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: [{
        promptIndex: 0, toolName: 'origin:commit', capturedAt: new Date().toISOString(),
        edits: [{ file: OURS, op: 'edit', source: 'commit', commitSha: 'a'.repeat(40) }],
      }],
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    writeState('theirs', theirs([OURS]));

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(OURS);
  });
});
