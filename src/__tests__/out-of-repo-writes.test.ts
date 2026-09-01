// A turn that wrote only OUTSIDE the repo captures no diff — correctly, since
// nothing in the repo changed. But it renders identically to a capture that
// broke: "0 files changed". Every report of the latter so far has turned out
// to be the former (an agy session whose file went to
// ~/.gemini/antigravity/brain/<id>/scratch/ prompted this).
//
// outOfRepoWrites() records what was dropped so the turn can say why it is
// empty. It must never guess: no root means no verdict.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { outOfRepoWrites, abbreviateHome, MAX_OUT_OF_REPO_FILES } from '../paths.js';
import { parseAntigravityTranscript } from '../antigravity-transcript.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-transcript-double-encoded.jsonl');

describe('outOfRepoWrites', () => {
  const root = '/repo';

  it('keeps a write that landed outside the root', () => {
    expect(outOfRepoWrites(root, ['/tmp/scratch.py'])).toEqual(['/tmp/scratch.py']);
  });

  it('drops a write inside the root — that one IS the diff', () => {
    expect(outOfRepoWrites(root, ['/repo/src/index.ts'])).toEqual([]);
  });

  it('separates the two in one list', () => {
    expect(outOfRepoWrites(root, ['/repo/a.ts', '/tmp/b.py', '/repo/c.ts', '/other/d.md']))
      .toEqual(['/tmp/b.py', '/other/d.md']);
  });

  it('does not treat a sibling whose path merely shares a prefix as inside', () => {
    expect(outOfRepoWrites('/repo', ['/repo-other/x.ts'])).toEqual(['/repo-other/x.ts']);
  });

  it('returns [] with no root rather than calling every write out-of-repo', () => {
    // The dangerous default: without a root there is no "outside", and
    // guessing would slap the explanation onto every turn in the session.
    expect(outOfRepoWrites('', ['/tmp/a.py'])).toEqual([]);
    expect(outOfRepoWrites(null, ['/tmp/a.py'])).toEqual([]);
    expect(outOfRepoWrites(undefined, ['/tmp/a.py'])).toEqual([]);
  });

  it('skips relative paths — those are already expressed against the root', () => {
    expect(outOfRepoWrites(root, ['src/index.ts', '../escape.ts'])).toEqual([]);
  });

  it('ignores non-strings and empties without throwing', () => {
    expect(outOfRepoWrites(root, ['', null as unknown as string, undefined as unknown as string, '/tmp/a']))
      .toEqual(['/tmp/a']);
    expect(outOfRepoWrites(root, null)).toEqual([]);
  });

  it('dedups repeated writes to the same file', () => {
    expect(outOfRepoWrites(root, ['/tmp/a.py', '/tmp/a.py', '/tmp/a.py'])).toEqual(['/tmp/a.py']);
  });

  it('caps the list so a runaway loop cannot send megabytes', () => {
    const many = Array.from({ length: MAX_OUT_OF_REPO_FILES + 25 }, (_, i) => `/tmp/f${i}.py`);
    expect(outOfRepoWrites(root, many)).toHaveLength(MAX_OUT_OF_REPO_FILES);
  });

  it('collapses the home directory, so the account name is not stored', () => {
    const f = path.join(os.homedir(), '.gemini', 'scratch', 'x.py');
    const [only] = outOfRepoWrites(root, [f]);
    expect(only.startsWith('~/')).toBe(true);
    // Against the NORMALIZED home. outOfRepoWrites emits forward slashes, so
    // on Windows the raw `C:\Users\…` spelling can never appear in `only` and
    // this assertion passed without testing anything — the account name is
    // exactly what it exists to keep out.
    expect(only).not.toContain(os.homedir().replace(/\\/g, '/'));
    expect(only.endsWith('/.gemini/scratch/x.py')).toBe(true);
  });

  it('resolves a symlinked root rather than calling its own files foreign', () => {
    // macOS: os.tmpdir() is /var/... symlinked to /private/var/... A raw
    // prefix check here would report every file in the repo as out-of-repo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-oor-'));
    try {
      const inside = path.join(fs.realpathSync.native(dir), 'a.ts');
      expect(outOfRepoWrites(dir, [inside])).toEqual([]);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('abbreviateHome', () => {
  it('leaves a path outside home alone', () => {
    expect(abbreviateHome('/tmp/a.py')).toBe('/tmp/a.py');
  });
  it('does not abbreviate a sibling of home that shares its prefix', () => {
    // The claim under test is that no `~` is substituted — NOT that the string
    // comes back byte-identical. abbreviateHome always normalizes separators
    // (the very next test asserts exactly that), and on Windows os.homedir()
    // is backslash-spelled, so comparing against the raw input made this test
    // contradict its own neighbour and fail on every Windows run.
    const sibling = os.homedir() + '-backup/a.py';
    expect(abbreviateHome(sibling)).toBe(sibling.replace(/\\/g, '/'));
  });
  it('normalizes backslashes to forward slashes', () => {
    expect(abbreviateHome('C:\\tmp\\a.py')).toBe('C:/tmp/a.py');
  });
});

describe('against the real agy transcript', () => {
  const parsed = parseAntigravityTranscript(fs.readFileSync(FIXTURE, 'utf-8'));

  // Derive the worktree root from the FIXTURE, not from os.homedir(): the
  // suite redirects HOME to a per-worker temp dir (see setup/isolate-home.ts),
  // so the real `/Users/...` paths baked into the transcript would never match
  // a homedir()-built root. Home abbreviation is covered by its own unit test
  // above, where the isolated HOME is the one being exercised.
  const worktreeWrite = parsed.promptFilesEdited[2][0];
  const workRoot = worktreeWrite.slice(0, worktreeWrite.indexOf('/my_shit_project'));

  it('classifies the scratch-dir write as out-of-repo for the session workRoot', () => {
    // The exact session that prompted this feature: the agent wrote
    // shit_code.py into agy's own brain/scratch dir, so the repo genuinely did
    // not change — and the turn genuinely rendered "0 files changed".
    const outside = outOfRepoWrites(workRoot, parsed.promptFilesEdited[0]);
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain('/brain/');
    expect(outside[0].endsWith('/scratch/shit_code.py')).toBe(true);
  });

  it('reports nothing out-of-repo for the turn that wrote INTO the worktree', () => {
    // Same session, later turn: this write DID land in the repo tree, so it
    // belongs to the diff and must not be explained away as out-of-repo.
    expect(outOfRepoWrites(workRoot, parsed.promptFilesEdited[2])).toEqual([]);
  });
});
