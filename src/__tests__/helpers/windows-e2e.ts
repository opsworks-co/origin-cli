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
// which is the correct shape and is left alone. With the skips below lifted,
// no CLI test file is skipped wholesale on Windows any more.
//
// What is left is speed, not semantics. vitest.config.ts already documents the
// reason its own timeout is 30s: every git call is a process spawn Defender
// inspects, several times slower than the same call on the Ubuntu runner and
// slower again under parallel worker load. These tests drive ~10 CLI spawns
// plus git init/add/commit each, so they get the same allowance rather than a
// Linux number.
// Measured over three Windows runs of the sweep, per file:
//
//   13 files                            pass / pass / pass / pass
//   capture-e2e-real-binary             fail / fail / pass / FAIL  (#1570, held)
//   capture-e2e-cursor-concurrent-start pass / pass / FAIL / -     (#1568, held)
//
// So 13 of the 15 are enabled here, not 14. An earlier revision of this
// comment cleared `capture-e2e-real-binary` after its single green run in
// run 3, once #1564 fixed the `turn 5` cause. Run 4 then failed it on `turn
// 4` — a different assertion, about a shell write missing from its turn.
// One green run is not evidence a flaky file is fixed; that is the trap this
// file's own PR description warns about, and it was walked into here.
//
// `capture-e2e-cursor-concurrent-start` is skipped on Windows at its own
// describe, with the evidence and an owner in #1568. One evidenced exception
// with a tracking issue is the opposite of the blanket `!posix` above: that
// one had no recorded reason and hid 15 files for months.
export const isWindows = process.platform === 'win32';

/** Multiply an explicit test/hook timeout by this. 1 everywhere but Windows. */
export const WINDOWS_SLOWDOWN = isWindows ? 3 : 1;
