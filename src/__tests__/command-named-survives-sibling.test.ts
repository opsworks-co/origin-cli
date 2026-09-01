/**
 * The behaviour the `command_named` tier exists for.
 *
 * `uncommittedExcludeUnion` subtracts any file a live sibling claims unless we
 * can show it is ours. Shell-written files could not show that: they reach the
 * ledger only as inferred entries, which (correctly) stopped counting as
 * ownership. So on a checkout where a file is contested, the turn that
 * genuinely wrote it lost it.
 *
 * That is not hypothetical here — thirteen sessions in this repo claim
 * `packages/cli/src/commands/hooks.ts`. It never appeared on a single turn of
 * session 6e9947a5 despite being edited on nearly all of them, and that is why
 * every turn's line count was short: +122 recorded against +142 committed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uncommittedExcludeUnion } from '../commands/hooks.js';

const CONTESTED = 'packages/cli/src/commands/hooks.ts';

describe('a command_named edit survives a sibling claim', () => {
  let repo: string;
  let gitDir: string;

  const writeState = (tag: string, state: Record<string, unknown>) => {
    fs.writeFileSync(path.join(gitDir, `origin-session-${tag}.json`), JSON.stringify(state));
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-named-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    gitDir = path.join(repo, '.git');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const sibling = () => writeState('theirs', {
    sessionId: 'theirs', sessionTag: 'theirs', repoPath: repo,
    completedPromptMappings: [{ promptIndex: 0, filesChanged: [CONTESTED] }],
  });

  const ledger = (evidence: string) => [{
    promptIndex: 0,
    toolName: '__shell_probe__',
    capturedAt: new Date().toISOString(),
    edits: [{ file: CONTESTED, op: 'write', source: 'uncommitted', evidence }],
  }];

  it('keeps the file when our command NAMED it', () => {
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: ledger('command_named'),
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    sibling();

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(CONTESTED);
  });

  it('still drops it when the evidence is only the window', () => {
    // `command_probe` means the file changed while one of our commands ran —
    // which a sibling writing concurrently also produces. Unchanged behaviour.
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: ledger('command_probe'),
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    sibling();

    expect(uncommittedExcludeUnion(ours as any)).toContain(CONTESTED);
  });

  it('turn_window evidence is still the weakest and still drops', () => {
    const ours = {
      sessionId: 'ours', sessionTag: 'ours', repoPath: repo,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
      liveEdits: ledger('turn_window'),
      completedPromptMappings: [],
    };
    writeState('ours', ours);
    sibling();

    expect(uncommittedExcludeUnion(ours as any)).toContain(CONTESTED);
  });
});
