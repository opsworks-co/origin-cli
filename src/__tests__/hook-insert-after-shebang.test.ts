// A repo-local git hook the user already had gets Origin's block right after
// its shebang, not appended. A user hook ending in `exit 0` (or `exec …`)
// never reached an appended line, so Origin's post-commit never ran and the
// repo's commits went uncaptured with no error anywhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  installGitPreCommitHook,
  installGitCommitMsgHook,
  installGitPrepareCommitMsgHook,
  installGitPostCommitHook,
  installGitPrePushHook,
} from '../commands/enable.js';
import { installRewriteHooks } from '../history-preservation.js';
import { insertHookBlockAfterShebang } from '../utils/hook-insert.js';

const HOOKS = [
  { file: 'pre-commit', marker: '# origin-pre-commit', install: installGitPreCommitHook },
  { file: 'commit-msg', marker: '# origin-commit-msg', install: installGitCommitMsgHook },
  { file: 'prepare-commit-msg', marker: '# origin-prepare-commit-msg', install: installGitPrepareCommitMsgHook },
  { file: 'post-commit', marker: '# origin-post-commit', install: installGitPostCommitHook },
  { file: 'pre-push', marker: '# origin-pre-push', install: installGitPrePushHook },
  { file: 'post-checkout', marker: '# origin-post-checkout', install: installRewriteHooks },
];

const USER_HOOK = '#!/bin/sh\n# USER_LOGIC\necho "user ran" >> "$USER_EVIDENCE"\nexit 0\n';

describe('insertHookBlockAfterShebang', () => {
  it('puts the block on the line after the shebang', () => {
    expect(insertHookBlockAfterShebang('#!/bin/sh\necho hi\nexit 0\n', '# o\nrun\n'))
      .toBe('#!/bin/sh\n# o\nrun\necho hi\nexit 0\n');
  });
  it('puts the block first when there is no shebang', () => {
    expect(insertHookBlockAfterShebang('echo hi\n', '# o\nrun\n')).toBe('# o\nrun\necho hi\n');
  });
  it('handles a shebang with no trailing newline', () => {
    expect(insertHookBlockAfterShebang('#!/bin/sh', '# o\nrun\n')).toBe('#!/bin/sh\n# o\nrun\n');
  });
});

describe('repo-local hooks: an existing user hook ending in `exit 0`', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-hook-shebang-'));
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  const hookPath = (file: string) => path.join(repo, '.git', 'hooks', file);
  const writeUserHook = (file: string) => {
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(hookPath(file), USER_HOOK, { mode: 0o755 });
  };

  it.each(HOOKS)('$file: Origin\'s block sits before the user\'s `exit 0`', ({ file, marker, install }) => {
    writeUserHook(file);
    install(repo);
    install(repo); // re-running enable must not duplicate the block

    const final = fs.readFileSync(hookPath(file), 'utf-8');
    expect(final.startsWith(`#!/bin/sh\n${marker}\n`)).toBe(true);
    expect(final.split(marker).length - 1).toBe(1);
    // The user's script is intact, in order, after Origin's block.
    expect(final.endsWith(USER_HOOK.slice('#!/bin/sh\n'.length))).toBe(true);
  });

  // Run the hook for real with Origin's command pointed at a stub: Origin's
  // line must fire, and the user's own lines must still run after it.
  const posix = process.platform !== 'win32';
  it.runIf(posix).each(HOOKS)('$file: Origin\'s command runs and the user\'s lines still run', async ({ file, install }) => {
    writeUserHook(file);
    install(repo);

    const fired = path.join(repo, 'origin-fired');
    const stub = path.join(repo, 'origin-stub');
    fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${fired}"\n`, { mode: 0o755 });
    const hp = hookPath(file);
    fs.writeFileSync(hp, fs.readFileSync(hp, 'utf-8').replace(/\borigin hooks /g, `${stub} hooks `));

    const evidence = path.join(repo, 'user-evidence');
    const r = spawnSync('sh', [hp, 'a', 'b', '1'], {
      cwd: repo, input: '', env: { ...process.env, USER_EVIDENCE: evidence },
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(evidence, 'utf-8')).toBe('user ran\n');

    // post-commit and post-checkout background the capture — wait for it.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(fired) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 25));
    expect(fs.readFileSync(fired, 'utf-8')).toContain(`git-${file}`);
  });

  // pre-commit, commit-msg and pre-push block by exiting non-zero. Run first, a failure
  // must still abort the hook rather than be swallowed by the user's `exit 0`.
  it.runIf(posix).each(HOOKS.filter((h) => h.file === 'pre-commit' || h.file === 'commit-msg' || h.file === 'pre-push'))(
    '$file: a blocking Origin exit still fails the hook',
    ({ file, install }) => {
      writeUserHook(file);
      install(repo);
      const stub = path.join(repo, 'origin-stub');
      fs.writeFileSync(stub, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const hp = hookPath(file);
      fs.writeFileSync(hp, fs.readFileSync(hp, 'utf-8').replace(/\borigin hooks /g, `${stub} hooks `));

      const evidence = path.join(repo, 'user-evidence');
      const r = spawnSync('sh', [hp], { cwd: repo, input: '', env: { ...process.env, USER_EVIDENCE: evidence } });
      expect(r.status).toBe(1);
    },
  );
});
