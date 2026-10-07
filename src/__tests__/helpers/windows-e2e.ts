// Shared Windows allowance for the capture-e2e family.
//
// Every capture-e2e file carried `skipIf(!haveDist || !posix)`, copied from
// file to file since caabb702 with no recorded reason — `origin why` finds no
// session behind the line. The effect was that the native-Windows job never
// once drove the built binary end to end, on the one platform that keeps
// breaking:
//
//   #1533 — a hand-built minimal env set only HOME, so os.homedir() on Windows
//           read %USERPROFILE% and found the runner's real, empty ~/.origin.
//   #1544 — the update-check banner printed on stdout, corrupting --json.
//
// Both are defects in how the CLI resolves the environment it is handed. Both
// reached main. Neither could have been caught by a unit test.
//
// Audited before lifting the gate: all 15 files resolve their temp root through
// `fs.realpathSync.native` (which is what collapses Windows 8.3 short paths),
// spread `...process.env` wholesale into every child — so the isolated HOME and
// USERPROFILE that setup/isolate-home.ts exports both reach the CLI, the exact
// mechanism #1533 got wrong — build every path with `path.join`, and invoke git
// through `execFileSync` rather than a shell, so no `sh` is required. The only
// POSIX-looking construct any of them uses is `process.kill(pid, 'SIGTERM')`,
// which Node emulates on Windows via TerminateProcess.
//
// Two other files mention win32 but were never gated at the describe level:
// enable-idempotency and ensure-policy-hook already RUN on Windows and guard
// only their Unix permission-bit assertions (`statSync().mode & 0o777`) inline,
// which is the correct shape and is left alone.
//
// What is left is speed, not semantics. vitest.config.ts already documents the
// reason its own timeout is 30s: every git call is a process spawn Defender
// inspects, several times slower than the same call on the Ubuntu runner and
// slower again under parallel worker load. These tests drive ~10 CLI spawns
// plus git init/add/commit each, so they get the same allowance rather than a
// Linux number.
// Measured over three Windows runs of the original 15-file sweep, per file:
//
//   13 files                            pass / pass / pass / pass
//   capture-e2e-real-binary             fail / fail / pass / FAIL  (#1570, closed)
//   capture-e2e-cursor-concurrent-start pass / pass / FAIL / -     (#1568, open)
//
// #1570 closed with #1582. #1568's lock fix is on main (#1702) but the file
// stays held: #1580 lifted it on one green run and it failed the next. Probe
// with ORIGIN_WINDOWS_CAPTURE_PROBE=1; lifting wants several consecutive
// native Windows greens.
//
// Three files added after the sweep that skipped Windows at birth, with no
// recorded miss, now run: carried-row-sheds-inherited-files, checkout-restop-
// stays-empty, mid-turn-pull. A hold needs a Windows failure of its own.
//
// It happened again: between #1711 and #1961 fifteen more files were born with
// `skipIf(!haveDist || isWindows)`, each copying the one before, while the
// Windows job was switched off (Actions disabled since 2026-09-15). None of
// them ever failed on Windows; the audit found no POSIX-only step — their
// "shell commands" are transcript text, the work is done in Node, and the
// `#!/bin/sh` git hooks some install are the same ones rebase-onto-own-squash
// and replayed-commit already run under Git for Windows. They run again, and
// capture-e2e-windows-gate.test.ts now refuses a Windows skip in any
// capture-e2e file not listed here.

/**
 * capture-e2e files allowed to skip native Windows, each with the Windows
 * failure that earned the hold. Add a file only with its own failure.
 */
export const WINDOWS_HELD: Readonly<Record<string, string>> = {
  'capture-e2e-cursor-concurrent-start.test.ts': 'issue #1568 — the reservation-filed prompt is lost, ~1 run in 4',
};

export const isWindows = process.platform === 'win32';

/** Multiply an explicit test/hook timeout by this. 1 everywhere but Windows. */
export const WINDOWS_SLOWDOWN = isWindows ? 3 : 1;
