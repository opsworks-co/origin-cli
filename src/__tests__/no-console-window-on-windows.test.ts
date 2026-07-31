// Source-scan guard: every child process we launch must set `windowsHide`.
//
// On Windows a console-subsystem child (git.exe, node.exe — and cmd.exe, which
// `execSync` ALWAYS goes through) allocates its OWN console window when the
// parent has none to inherit. That is exactly the case under a GUI agent like
// Codex Desktop and inside our own detached daemons, so every un-hidden call
// popped a terminal window. Hooks shell out constantly and the heartbeat lives
// for hours, so the user was buried in windows that never closed.
//
// This is a lint-style test rather than a behavioural one because the failure
// only reproduces on Windows under a GUI parent — nothing in CI or on a dev Mac
// would catch a new un-hidden call site.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** Call sites of `fn(` whose following window lacks `windowsHide`. */
function unhidden(fn: string, window = 900): string[] {
  const bad: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf-8');
    const re = new RegExp(`\\b${fn}\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const seg = src.slice(m.index, m.index + window);
      if (/windowsHide/.test(seg)) continue;
      // Calls routed through our own helpers inherit windowsHide from
      // utils/exec.ts buildOptions/spawnOpts, so an options bag using the
      // RunOptions shape (timeoutMs) is already covered.
      if (/timeoutMs/.test(seg)) continue;
      // A shared opts bag passed by NAME (execOpts / gitOpts) carries
      // windowsHide at its declaration — asserted separately below.
      if (/,\s*(?:exec|git)Opts\s*[,)]/.test(seg)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${path.relative(SRC, file)}:${line}`);
    }
  }
  return bad;
}

/** Every shared `execOpts` / `gitOpts` declaration that is a RAW child_process
 *  bag (has `stdio:`, not the RunOptions `timeoutMs` shape) must hide too. */
function unhiddenSharedOpts(): string[] {
  const bad: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf-8');
    const re = /const\s+(?:gitOpts|execOpts)[^=]*=\s*(?:\(cwd: string\)\s*=>\s*)?\(?\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const seg = src.slice(m.index, m.index + 420);
      if (!/stdio\s*:/.test(seg)) continue;   // not a raw child_process bag
      if (/timeoutMs/.test(seg)) continue;    // RunOptions → central fix
      if (/windowsHide/.test(seg)) continue;
      bad.push(`${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  return bad;
}

describe('no stray console windows on Windows', () => {
  // execSync is the worst offender: it ALWAYS runs via `cmd.exe /d /s /c`, so
  // an un-hidden call is a literal cmd.exe window — what the user screenshotted.
  it('every execSync call sets windowsHide', () => {
    expect(unhidden('execSync')).toEqual([]);
  });

  it('every detached spawn sets windowsHide', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = fs.readFileSync(file, 'utf-8');
      const re = /\bspawn\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        // Wide enough to span the explanatory comment inside the options bag.
        const seg = src.slice(m.index, m.index + 1400);
        if (!/detached:\s*true/.test(seg)) continue;
        if (/windowsHide/.test(seg)) continue;
        bad.push(`${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every shared raw exec-options bag sets windowsHide', () => {
    expect(unhiddenSharedOpts()).toEqual([]);
  });

  // The gap that let the popups come back after #900: the checks above cover
  // execSync, detached spawn and shared opts bags — but NOT a hand-rolled
  // `execFileSync(..., { cwd, encoding, stdio })` bag. Two of those sat in
  // heartbeat.ts, one of them (getCurrentBranch) on the 30s ping timer, so a
  // git.exe console flashed every half-minute for the daemon's whole life.
  //
  // Scoped to the DAEMON entrypoints deliberately. These three are spawned with
  // detached:true, so they provably own no console and every un-hidden child
  // allocates a window. Hook-context call sites have the same exposure under a
  // GUI agent but there are ~40 of them; widening this list is a separate sweep.
  const DAEMONS = ['heartbeat.ts', 'transcript-watch.ts', 'codex-watch.ts'];

  it.each(DAEMONS)('%s hides every child process it launches', (name) => {
    const src = fs.readFileSync(path.join(SRC, name), 'utf-8');
    const bad: string[] = [];
    const re = /\b(execFileSync|execSync|spawnSync|execFile)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const seg = src.slice(m.index, m.index + 900);
      if (/windowsHide/.test(seg)) continue;
      if (/timeoutMs/.test(seg)) continue;                    // RunOptions → utils/exec.ts
      if (/,\s*(?:exec|git)Opts\s*[,)]/.test(seg)) continue;  // shared bag, asserted above
      bad.push(`${name}:${src.slice(0, m.index).split('\n').length}`);
    }
    expect(bad).toEqual([]);
  });

  // The shared wrappers are what the bulk of git calls go through — if these
  // regress, hundreds of call sites silently start popping windows again.
  it('utils/exec.ts sets windowsHide in BOTH wrappers', () => {
    const src = fs.readFileSync(path.join(SRC, 'utils', 'exec.ts'), 'utf-8');
    expect(src.match(/windowsHide:\s*true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
