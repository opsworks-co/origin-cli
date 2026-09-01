/**
 * A quoted path in a hook command does not survive `cmd /c`.
 *
 * Found live, and it was not cosmetic. Antigravity documents that it runs a
 * hook's `command` through `cmd /c <string>` (docs/hooks.md: "run via `sh -c`
 * on Unix, `cmd /c` on Windows"). The command we wrote began with a quoted
 * interpreter path, and cmd received it escaped:
 *
 *   '\"C:\Program Files\nodejs\node.exe\"' is not recognized as an internal
 *   or external command, operable program or batch file.
 *
 * PreToolUse runs before EVERY tool call and a failing handler is a hard block,
 * so the agent could not read a file or run git at all. It told the user Node
 * was missing — on a machine where node.exe sat exactly where the command said.
 *
 * Measured against the real `cmd /c` on this machine:
 *
 *   FAIL  "C:\Program Files\nodejs\node.exe" <cli> …   (what we shipped)
 *   FAIL  ""C:\Program Files\nodejs\node.exe" <cli> …" (the usual outer-quote trick)
 *   PASS  C:\PROGRA~1\nodejs\node.exe <cli> …          (8.3 short name)
 *   PASS  node <cli> …                                 (PATH — not usable: GUI
 *                                                       agents don't inherit it)
 *
 * So the rule is to emit a path that needs no quoting at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { unquotedWindowsPath } from '../commands/enable.js';

describe('unquotedWindowsPath', () => {
  it('passes a space-free path through untouched', () => {
    const toShort = vi.fn(() => null);
    expect(unquotedWindowsPath('C:\\Users\\me\\node.exe', toShort)).toBe('C:\\Users\\me\\node.exe');
    // No short-name lookup is worth doing when there is nothing to escape.
    expect(toShort).not.toHaveBeenCalled();
  });

  it('substitutes the 8.3 short name for a path containing spaces', () => {
    const toShort = () => 'C:\\PROGRA~1\\nodejs\\node.exe';
    const out = unquotedWindowsPath('C:\\Program Files\\nodejs\\node.exe', toShort);
    expect(out).toBe('C:\\PROGRA~1\\nodejs\\node.exe');
    expect(out).not.toContain('"');
  });

  it('falls back to quoting when the volume has no 8.3 name', () => {
    // 8.3 generation can be disabled per volume. Quoting is what shipped
    // before, so the fallback is no worse — never a crash, never a bare path
    // that would split on its own spaces.
    const p = 'C:\\Program Files\\nodejs\\node.exe';
    expect(unquotedWindowsPath(p, () => null)).toBe(`"${p}"`);
    expect(unquotedWindowsPath(p, () => 'C:\\Still Has Spaces\\node.exe')).toBe(`"${p}"`);
  });

  it('falls back to quoting when the short-name lookup throws', () => {
    // A hook command is being generated; a spawn failure here must not take
    // down `origin enable`.
    const p = 'C:\\Program Files\\nodejs\\node.exe';
    expect(unquotedWindowsPath(p, () => { throw new Error('cmd unavailable'); })).toBe(`"${p}"`);
  });

  it('never returns a bare path that still contains a space', () => {
    // The one outcome that must never happen: an unquoted path with a space
    // splits into two arguments and the hook silently runs the wrong program.
    for (const short of [null, 'C:\\Still Has Spaces\\node.exe', '']) {
      const out = unquotedWindowsPath('C:\\Program Files\\nodejs\\node.exe', () => short);
      if (/\s/.test(out)) expect(out.startsWith('"') && out.endsWith('"')).toBe(true);
    }
  });
});
