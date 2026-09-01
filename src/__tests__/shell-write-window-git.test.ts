/**
 * The shell-write window against a REAL git repo.
 *
 * The unit tests pin the decision logic with fake deps; this one pins the
 * wiring that actually has to hold in production — `createShadowCommit` →
 * `filesChangedSinceShadow` → `readFileAtRev` — because the whole design
 * rests on the claim that a turn's baseline shadow plus the current tree
 * yields exactly that turn's work, untracked files included.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createShadowCommit, filesChangedSinceShadow, readFileAtRev } from '../git-capture.js';
import { shellWindowEdits, SHELL_WINDOW_SOURCE, type ShellWindowDeps } from '../shell-write-capture.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

describe('shell-write window over real git state', () => {
  let dir: string;
  let deps: ShellWindowDeps;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shellwin-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    deps = {
      listChangedFiles: (sha) => filesChangedSinceShadow(dir, sha),
      readAtRev: (sha, file) => readFileAtRev(dir, sha, file),
      readWorking: (file) => {
        const abs = path.join(dir, file);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
      },
    };
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // Exactly what user-prompt-submit stores as the turn's baseline: a shadow
  // commit when the tree is dirty, plain HEAD when it's clean
  // (createShadowCommit returns null for a clean tree — no shadow needed).
  const baseline = (): string => {
    const sha = createShadowCommit(dir, 'test-baseline') || gitIn(dir, ['rev-parse', 'HEAD']).trim();
    expect(sha).toBeTruthy();
    return sha;
  };

  it('captures a heredoc-written file as a create, with its real content', () => {
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    const baselineSha = baseline();

    // What `cat > zakuski.py <<'PYEOF'` leaves behind: an untracked file.
    fs.writeFileSync(path.join(dir, 'zakuski.py'), 'print("herring")\n');

    const { edits } = shellWindowEdits(deps, { baselineSha });
    expect(edits).toEqual([{
      file: 'zakuski.py',
      op: 'create',
      oldContent: '',
      newContent: 'print("herring")\n',
      source: 'uncommitted',
      // Window edits are INFERENCE — pinned so the label cannot be dropped.
      evidence: 'turn_window',
      backfillSource: SHELL_WINDOW_SOURCE,
    }]);
  });

  it('captures an in-place patch as an edit carrying both sides', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), 'a\nb\nc\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    const baselineSha = baseline();

    fs.writeFileSync(path.join(dir, 'next.config.ts'), 'a\nB\nc\n');

    const { edits } = shellWindowEdits(deps, { baselineSha });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      file: 'next.config.ts',
      op: 'edit',
      oldContent: 'a\nb\nc\n',
      newContent: 'a\nB\nc\n',
    });
  });

  it('still sees the work after the turn COMMITTED it', () => {
    // The upplabs shape: a turn restores files, then commits them in the same
    // turn. The window is baseline→worktree, so the commit doesn't hide it.
    fs.writeFileSync(path.join(dir, 'blog.ts'), 'one\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    const baselineSha = baseline();

    fs.writeFileSync(path.join(dir, 'blog.ts'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'clutch.svg'), '<svg/>\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'Restore source lost between commit and release']);

    const { edits } = shellWindowEdits(deps, { baselineSha });
    expect(edits.map((e) => [e.file, e.op])).toEqual([
      ['blog.ts', 'edit'],
      ['clutch.svg', 'create'],
    ]);
    expect(edits.find((e) => e.file === 'blog.ts')?.oldContent).toBe('one\n');
  });

  it('excludes work that was already there when the turn started', () => {
    // Pre-session dirt lives in the BASELINE, so it can never appear in the
    // window — this is the structural half of the #528 guarantee.
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'left over from a previous session\n');
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\nedited before this turn\n');

    const baselineSha = baseline();          // turn starts here — dirt included
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'this turn wrote this\n');

    const { edits } = shellWindowEdits(deps, { baselineSha });
    expect(edits.map((e) => e.file)).toEqual(['mine.txt']);
  });

  it('reports a deletion the turn performed', () => {
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    const baselineSha = baseline();

    fs.rmSync(path.join(dir, 'gone.txt'));

    const { edits } = shellWindowEdits(deps, { baselineSha });
    expect(edits).toEqual([{
      file: 'gone.txt',
      op: 'delete',
      oldContent: 'bye\n',
      newContent: '',
      source: 'uncommitted',
      // Window edits are INFERENCE — pinned so the label cannot be dropped.
      evidence: 'turn_window',
      backfillSource: SHELL_WINDOW_SOURCE,
    }]);
  });

  it('produces nothing for a turn that changed nothing', () => {
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    const baselineSha = baseline();

    const { edits } = shellWindowEdits(deps, { baselineSha });
    expect(edits).toEqual([]);
  });
});
