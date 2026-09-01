/**
 * A `<dir>/**` ignore pattern must also match `<dir>` itself.
 *
 * Every directory entry in DEFAULT_IGNORE_PATTERNS is written `**\/<dir>/**`,
 * which compiles to `^(?:.+/)?<dir>/.*$` — a regex requiring a trailing slash
 * and something after it. So the patterns covered a directory's CONTENTS and
 * never the directory:
 *
 *   packages/cli/node_modules          -> false
 *   packages/cli/node_modules/foo.js   -> true
 *
 * That is a distinction on paper until a capture path records a directory as
 * a single entry, which several do. The shell probe stamps whatever the tree
 * walk hands it, and git reports a submodule or a symlinked directory as one
 * path with no children. Measured on session 6e9947a5: `packages/cli/node_modules`
 * (a symlink) reached a turn's shellProbes stamps unfiltered.
 */
import { describe, it, expect } from 'vitest';
import { shouldIgnoreFile } from '../ignore-patterns.js';

describe('shouldIgnoreFile — a directory pattern covers the directory itself', () => {
  it('ignores a nested directory that IS the ignore target', () => {
    expect(shouldIgnoreFile('packages/cli/node_modules')).toBe(true);
    expect(shouldIgnoreFile('apps/web/dist')).toBe(true);
    expect(shouldIgnoreFile('apps/api/build')).toBe(true);
    expect(shouldIgnoreFile('third_party/vendor')).toBe(true);
  });

  it('ignores the bare directory name at the repo root', () => {
    expect(shouldIgnoreFile('node_modules')).toBe(true);
    expect(shouldIgnoreFile('dist')).toBe(true);
  });

  it('still ignores everything inside — the half that always worked', () => {
    expect(shouldIgnoreFile('packages/cli/node_modules/foo.js')).toBe(true);
    expect(shouldIgnoreFile('apps/web/dist/index.js')).toBe(true);
    expect(shouldIgnoreFile('a/b/__snapshots__/x.snap')).toBe(true);
  });

  it('does not start swallowing real files that merely share a prefix', () => {
    // The fix strips a trailing `/**`, it does not loosen the anchoring: the
    // regex is still ^…$ over the whole path.
    expect(shouldIgnoreFile('src/node_modules_helper.ts')).toBe(false);
    expect(shouldIgnoreFile('src/distance.ts')).toBe(false);
    expect(shouldIgnoreFile('src/dist-utils/index.ts')).toBe(false);
    expect(shouldIgnoreFile('apps/web/src/pages/Policies.tsx')).toBe(false);
    expect(shouldIgnoreFile('packages/cli/src/commands/hooks.ts')).toBe(false);
  });

  it('leaves non-directory patterns alone', () => {
    // These have no trailing `/**`, so the new branch never fires for them.
    expect(shouldIgnoreFile('package-lock.json')).toBe(true);
    expect(shouldIgnoreFile('app.min.js')).toBe(true);
    expect(shouldIgnoreFile('src/index.ts')).toBe(false);
  });

  it('applies to a custom directory pattern too', () => {
    expect(shouldIgnoreFile('tmp/scratch', ['**/scratch/**'])).toBe(true);
    expect(shouldIgnoreFile('tmp/scratch/a.txt', ['**/scratch/**'])).toBe(true);
    expect(shouldIgnoreFile('tmp/scratchpad.md', ['**/scratch/**'])).toBe(false);
  });
});
