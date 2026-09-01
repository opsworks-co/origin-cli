// The CLI's idea of its own entry point must not depend on how it was launched.
//
// Real failure (reported 2026-08-25): `origin status` warned "2 hook configs
// point at an old origin path" after EVERY upgrade, `origin hooks repair`
// cleared it, and the next upgrade brought it straight back.
//
// cliEntryScript() read process.argv[1] and gave up unless it ended in `.js`.
// npm's global `origin` is a symlink with no extension, so:
//
//   origin hooks repair               → entry '' → powershell `& '<bin>/origin' …`
//   node <dist/index.js> hooks repair → entry ok → powershell `& '<node>' '<entry>' …`
//
// `origin upgrade` shells out using the second form (upgrade.ts ~207) while
// `origin status` / `origin doctor` run as whatever the user typed. So the two
// writers disagreed permanently about the same file and each "fixed" the
// other's output. Verified on the real install: the same config read
// `All 8 hook configs match this CLI` through the launcher and
// `2 of 8 hook configs out of date` through `node <entry>`, with no write in
// between.
//
// On macOS only the `powershell` field differs and nothing executes it. On
// Windows it decides whether every hook fire spawns a visible cmd window —
// which is why `node <entry>` is the form worth converging on.

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolveCliEntry } from '../commands/enable.js';

// A realistic installed layout: dist/index.js with dist/commands/enable.js
// beside it, reached through a bin symlink with no extension.
const DIST = path.resolve('/opt/node/lib/node_modules/@origin/cli/dist');
const ENTRY = path.join(DIST, 'index.js');
const MODULE_DIR = path.join(DIST, 'commands');
const BIN_SHIM = '/opt/node/bin/origin';

const onDisk = (present: string[]) => (p: string) => present.includes(p);

describe('resolveCliEntry — the answer cannot depend on the launcher', () => {
  it('agrees whether launched via the bin shim or via node <entry>', () => {
    const exists = onDisk([ENTRY]);

    // `node <dist/index.js> hooks repair` — what `origin upgrade` shells out as.
    const viaNode = resolveCliEntry(ENTRY, MODULE_DIR, exists);
    // `origin hooks repair` — argv[1] is the extensionless npm shim.
    const viaShim = resolveCliEntry(BIN_SHIM, MODULE_DIR, exists);

    // The regression: viaShim was '' here, so the two callers wrote different
    // powershell commands and reported each other as drift forever.
    expect(viaShim).toBe(viaNode);
    expect(viaShim).toBe(ENTRY);
  });

  it('resolves from the module directory when argv[1] is missing entirely', () => {
    expect(resolveCliEntry(undefined, MODULE_DIR, onDisk([ENTRY]))).toBe(ENTRY);
  });

  it('prefers a usable argv[1] over the module-relative guess', () => {
    // A dev running a different checkout's dist — argv[1] is the truth.
    const other = path.resolve('/somewhere/else/dist/index.js');
    expect(resolveCliEntry(other, MODULE_DIR, onDisk([other, ENTRY]))).toBe(other);
  });

  it('finds index.js sitting directly in the module directory', () => {
    // Flat build output: enable.js and index.js in the same dir.
    const flatEntry = path.join(DIST, 'index.js');
    expect(resolveCliEntry(BIN_SHIM, DIST, onDisk([flatEntry]))).toBe(flatEntry);
  });

  it('still gives up when nothing resolves, so the caller falls back to the shim', () => {
    expect(resolveCliEntry(BIN_SHIM, MODULE_DIR, onDisk([]))).toBe('');
    expect(resolveCliEntry(undefined, '', onDisk([]))).toBe('');
  });

  it('does not trust an argv[1] that is not a real .js file', () => {
    // A .cmd shim or bundler stub must never be hard-coded into a hook.
    expect(resolveCliEntry('/opt/node/bin/origin.cmd', MODULE_DIR, onDisk([ENTRY]))).toBe(ENTRY);
    // Named .js but absent from disk — not trustworthy either.
    expect(resolveCliEntry('/ghost/index.js', MODULE_DIR, onDisk([ENTRY]))).toBe(ENTRY);
  });
});
