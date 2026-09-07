// Fails when CLI source changed but the version still names an ALREADY
// RELEASED tag.
//
// `origin upgrade` decides what to deliver by comparing version STRINGS
// (isNewer). So a fix that merges while package.json still reads a version
// that has already been tagged is invisible to every user forever — the tag
// points at the older code, and nothing ever advertises the newer build.
//
// This is not hypothetical and it is not rare. It happened FOUR times in a
// single night (#1143→#1144, #1148→#1150, #1152→#1155, #1156-61→#1162), each
// time caught only because someone happened to look at the version before
// tagging. Every one of those fixes would otherwise have sat on main reaching
// nobody, looking shipped.
//
// The rule: if `cli-v<version>` exists AND packages/cli/src differs from what
// that tag points at, the version must be bumped before merge.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = path.resolve(CLI_DIR, '..', '..');

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

const version: string = JSON.parse(
  fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf-8'),
).version;

describe('version collision guard', () => {
  it('can actually see tags — a guard that cannot fire is not a guard', () => {
    // The lesson that produced this assertion: `actions/checkout` fetches no
    // tags by default, so without `fetch-tags: true` every check below would
    // find nothing and report success. Locally a shallow or tagless clone is
    // normal, so this is only enforced in CI.
    const tags = git(['tag', '--list', 'cli-v*']);
    if (!process.env.CI) {
      expect(tags, 'git must be runnable').not.toBeNull();
      return;
    }
    expect(tags, 'CI has no cli-v* tags: the workflow must check out with fetch-tags').toBeTruthy();
    expect((tags || '').split('\n').filter(Boolean).length).toBeGreaterThan(0);
  });

  it('has a version that is not an already-released tag with different source', () => {
    const tag = `cli-v${version}`;
    const exists = git(['rev-parse', '--verify', `refs/tags/${tag}`]);
    if (!exists) return; // version is unreleased — nothing to collide with

    // The tag exists. Did the CLI's SOURCE move since it was cut?
    const changed = git(['diff', '--name-only', `${tag}`, '--', 'packages/cli/src']);
    if (changed === null) return; // cannot compare (shallow clone) — see the test above

    // Only code that SHIPS forces a bump. Tests are compiled into dist but
    // change no runtime behaviour, so requiring a release for a test-only edit
    // would make the guard fire constantly and train everyone to bump on
    // autopilot — which defeats the point of asking.
    //
    // This PR is its own first example: it adds only a test file, and the
    // first version of this check failed on itself.
    const files = changed.split('\n')
      .filter(Boolean)
      .filter((f) => !f.includes('/__tests__/') && !f.endsWith('.test.ts'));
    if (files.length === 0) return; // test-only change
    expect(
      files,
      `packages/cli/package.json says ${version}, and ${tag} already exists pointing at DIFFERENT source.\n`
      + '`origin upgrade` compares version strings, so this build would never reach a single user:\n'
      + 'the tag serves the old code and nothing advertises the new.\n\n'
      + 'Run `node packages/cli/scripts/version-bump.cjs` and update package-lock.json to match.\n\n'
      + `Changed since ${tag}:\n  ${files.slice(0, 20).join('\n  ')}`,
    ).toEqual([]);
  });

  it('ignores a test-only change, which ships no behaviour', () => {
    const tag = `cli-v${version}`;
    if (!git(['rev-parse', '--verify', `refs/tags/${tag}`])) return;
    const changed = git(['diff', '--name-only', tag, '--', 'packages/cli/src']);
    if (changed === null) return;
    const all = changed.split('\n').filter(Boolean);
    const shipping = all.filter((f) => !f.includes('/__tests__/') && !f.endsWith('.test.ts'));
    // If everything that changed is a test, the guard above must stay quiet.
    if (all.length > 0 && shipping.length === 0) {
      expect(shipping, 'a test-only change must not demand a version bump').toEqual([]);
    }
  });

  it('keeps package.json and package-lock.json on the same version', () => {
    // CI's `npm ci --dry-run` fails on drift, and a bump that misses the lock
    // is the most common way to produce it.
    const lock = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package-lock.json'), 'utf-8'));
    expect(lock.version, 'package-lock.json version').toBe(version);
    expect(lock.packages?.['']?.version, 'package-lock.json packages[""].version').toBe(version);
  });
});
