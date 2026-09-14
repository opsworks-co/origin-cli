import { git } from '../../utils/exec.js';
import { compareVersions } from '../../version-check.js';

/** The same numeric ordering as `origin upgrade`, limited to stable release
 * tags. Git's lexical ordering gets unpadded HHmm components wrong. */
export function latestCliRelease(tags: string[]): string | undefined {
  return tags.filter(tag => /^cli-v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => compareVersions(b.slice(5), a.slice(5)))[0];
}

/** Repo-aware CI check, also exercised against disposable real repositories.
 * Git errors must fail the check: missing comparison evidence is not success.
 */
export function assertCliReleaseVersion(repo: string, version: string, requireTags = false): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid stable CLI version: ${version}`);
  const opts = { cwd: repo, timeoutMs: 10_000 };
  const tags = git(['tag', '--list', 'cli-v*'], opts).trim().split('\n').filter(Boolean);
  const latest = latestCliRelease(tags);
  if (!latest) {
    if (requireTags) throw new Error('CI has no stable cli-v* tags: checkout must fetch tags and full history');
    return;
  }
  const exact = `cli-v${version}`;
  const comparisons = new Set<string>();
  if (tags.includes(exact)) comparisons.add(exact);
  const relativeToLatest = compareVersions(version, latest.slice(5));
  if (relativeToLatest <= 0) comparisons.add(latest);
  for (const tag of comparisons) {
    // Ref-qualified so a branch with the same name cannot change the baseline.
    const changed = git(['diff', '--name-only', `refs/tags/${tag}`, '--', 'packages/cli/src'], opts);
    const shipping = changed.split('\n').filter(Boolean)
      .filter(file => !file.includes('/__tests__/') && !file.endsWith('.test.ts'));
    if (!shipping.length) continue;
    const reason = tag === exact ? 'already exists with different source'
      : relativeToLatest === 0 ? 'has the same numeric version with different source'
        : 'is newer than this package version';
    throw new Error(`CLI version ${version} cannot deliver these changes: ${tag} ${reason}.\n`
      + '`origin upgrade` requires a newer version to deliver new runtime code.\n'
      + 'Run `node packages/cli/scripts/version-bump.cjs` and update package-lock.json to match.\n'
      + `Changed since ${tag}:\n  ${shipping.slice(0, 20).join('\n  ')}`);
  }
}
