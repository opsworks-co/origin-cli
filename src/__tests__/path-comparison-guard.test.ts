// Fails the build when source compares path-ish values with `===`.
//
// Fixing instances of the Windows path bug has not worked — the next
// comparison someone writes reintroduces it. Within one night CI caught two:
// `wt === state.repoPath` (never true on Windows, where git answers with
// forward slashes and node with backslashes) and a `realpathSync` that leaves
// 8.3 short names unresolved. Both were written by someone who knew about the
// problem, which is the point: knowing is not enough, so this is mechanical.
//
// There is no ESLint in this repo, so the guard is a test — the same shape as
// the other parity tests here.
//
// Escape hatch: append `// path-compare-ok` to a line that genuinely wants
// raw string identity (comparing a value to itself, an already-normalised
// constant, a sentinel).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Sites that already existed when this guard landed. A lint introduced to a
// live codebase either rewrites everything at once — thirty call sites in the
// hottest files, for a bug that is latent in most of them — or freezes what is
// there and refuses anything NEW. This is the second. The list is meant to
// shrink; it must never grow.
import BASELINE from './path-comparison-baseline.json' with { type: 'json' };

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Identifiers whose value is a filesystem path. Deliberately conservative:
// a miss is a bug that slips through, a false positive is a developer annoyed
// by an escape comment, and the second is much cheaper than the first.
const PATH_ISH = /(?:^|[a-z0-9])(?:[Pp]ath|Cwd|cwd|[Dd]ir|[Rr]oot|[Tt]ree|[Ww]orktree|[Rr]epo)$/;

function isPathIsh(expr: string): boolean {
  const t = expr.trim().replace(/[();,]+$/, '');
  // Only bare identifiers and simple member access — `a.repoPath`, `cwd`.
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t)) return false;
  const last = t.split('.').pop() || '';
  return PATH_ISH.test(last);
}

// Baseline entries are `file  code`, deliberately without a line number.
function keyOf(offender: string): string {
  const [loc, ...rest] = offender.split('  ');
  return `${loc.replace(/:\d+$/, '')}  ${rest.join('  ').trim()}`;
}

// The size of the frozen list on the day it was created.
const BASELINE_CEILING = 40;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') continue;
      sourceFiles(p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('path comparison guard', () => {
  it('finds no raw ===/!== between path-ish values outside paths.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // paths.ts is where normalised values are legitimately compared.
      if (path.basename(file) === 'paths.ts') continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('path-compare-ok')) return;
        for (const m of line.matchAll(/([\w$.]+)\s*[!=]==\s*([\w$.]+)/g)) {
          if (isPathIsh(m[1]) && isPathIsh(m[2])) {
            // Forward slashes ALWAYS: path.relative emits backslashes on
            // Windows, so a baseline generated anywhere else matched nothing
            // there and every frozen entry re-fired. The guard against path
            // bugs had a path bug — caught by its own Windows run.
            const rel = path.relative(SRC, file).split(path.sep).join('/');
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        }
      });
    }
    const known = new Set(BASELINE as string[]);
    // Key on file+code, not line number: an unrelated edit above shifts every
    // line below it and would otherwise turn the whole baseline into failures.
    const fresh = offenders.filter((o) => !known.has(keyOf(o)));
    expect(
      fresh,
      'Compare paths with samePath() from paths.ts — `===` is wrong on Windows '
      + '(git answers C:/…, node answers C:\\…) and on macOS (/var vs /private/var). '
      + 'If raw identity is genuinely what you want, append `// path-compare-ok`.\n'
      + fresh.join('\n'),
    ).toEqual([]);
  });

  it('the baseline only ever shrinks', () => {
    // If the frozen list grows, the guard has been worked around rather than
    // satisfied.
    expect((BASELINE as string[]).length).toBeLessThanOrEqual(BASELINE_CEILING);
  });

  it('recognises a path-ish identifier', () => {
    // Guards the guard: if this stops matching, the scan above silently passes.
    for (const id of ['repoPath', 'state.repoPath', 'cwd', 'hookCwd', 'workTree', 'gitRoot', 'treeDir']) {
      expect(isPathIsh(id), id).toBe(true);
    }
    for (const id of ['count', 'a.length', 'sha', 'promptIndex', '"literal"']) {
      expect(isPathIsh(id), id).toBe(false);
    }
  });
});
