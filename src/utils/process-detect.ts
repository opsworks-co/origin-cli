/**
 * Cross-platform process detection — "is a process whose command line matches
 * X running, and what are its PIDs?"
 *
 * Origin attributes a commit to the RUNNING agent by scanning process command
 * lines for known patterns (see agents/registry.ts). The Unix path is
 * `pgrep -f <pattern>`, which has no native-Windows equivalent. On Windows we
 * enumerate processes via CIM/WMI (`Get-CimInstance Win32_Process`), which
 * exposes the full `CommandLine`, and match the same pattern in-process with a
 * JS RegExp — `pgrep -f` uses ERE, whose `.*`/`|` semantics JS shares.
 *
 * All matching excludes the current process tree (our own argv contains the
 * pattern text on the hook path, which would otherwise false-positive).
 */
import { isWindows } from './platform.js';
import { runDetailed } from './exec.js';

/**
 * Extract the regex pattern from a legacy `pgrep -f "<pattern>"` command
 * string. The agent registry historically stores full pgrep commands; this
 * pulls out just the pattern so we can match it in-process on Windows and
 * feed it to `pgrep -f` verbatim on Unix.
 */
export function pgrepPattern(pgrepCmd: string): string {
  const quoted = pgrepCmd.match(/pgrep\s+-f\s+"([^"]*)"/);
  if (quoted) return quoted[1];
  const bare = pgrepCmd.match(/pgrep\s+-f\s+(\S+)/);
  if (bare) return bare[1];
  return pgrepCmd; // already a bare pattern
}

// ─── Windows process snapshot (memoized per invocation) ─────────────────────

interface ProcRow { pid: number; ppid: number; cmd: string }

let winSnapshot: { at: number; rows: ProcRow[] } | null = null;
// A hook's standalone sweep checks ~10 patterns back to back; caching the
// (relatively slow) PowerShell CIM query for a couple seconds collapses those
// into a single spawn without ever serving a stale process list across hooks.
const WIN_SNAPSHOT_TTL_MS = 2_000;

function windowsProcessRows(): ProcRow[] {
  const now = Date.now();
  if (winSnapshot && now - winSnapshot.at < WIN_SNAPSHOT_TTL_MS) {
    return winSnapshot.rows;
  }
  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,CommandLine | ' +
    'ConvertTo-Json -Compress';
  const r = runDetailed(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: 8_000 },
  );
  let rows: ProcRow[] = [];
  if (r.status === 0 && r.stdout.trim()) {
    try {
      const parsed = JSON.parse(r.stdout);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      // Keep cmd-less rows (some system processes report no CommandLine) so the
      // ancestry walk in processInfo can still step through their ppid; the
      // regex match in windowsMatch naturally skips an empty command line.
      rows = arr
        .map((row: any) => ({
          pid: Number(row?.ProcessId),
          ppid: Number(row?.ParentProcessId),
          cmd: typeof row?.CommandLine === 'string' ? row.CommandLine : '',
        }))
        .filter((row: ProcRow) => Number.isInteger(row.pid));
    } catch { /* malformed JSON → no matches */ }
  }
  winSnapshot = { at: now, rows };
  return rows;
}

/** Test-only: drop the memoized Windows process snapshot. */
export function __resetProcessSnapshot(): void {
  winSnapshot = null;
}

function windowsMatch(pattern: string): number[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return []; // an un-JS-compilable ERE simply matches nothing on Windows
  }
  return windowsProcessRows()
    .filter((row) => re.test(row.cmd))
    .map((row) => row.pid);
}

function unixMatch(pattern: string): number[] {
  // pgrep exits 1 when nothing matches — runDetailed returns that without
  // throwing, so status !== 0 is the empty case, not an error.
  const r = runDetailed('pgrep', ['-f', pattern], { timeoutMs: 4_000 });
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((p) => parseInt(p.trim(), 10))
    .filter((p) => !Number.isNaN(p));
}

/**
 * PIDs of processes whose command line matches `pattern` (an ERE, same
 * semantics as `pgrep -f`), excluding the current process and its parent.
 * `pattern` may be a bare regex or a legacy `pgrep -f "…"` command string.
 */
export function matchingProcessPids(pattern: string): number[] {
  const pat = pgrepPattern(pattern);
  const exclude = new Set([process.pid, process.ppid]);
  const pids = isWindows() ? windowsMatch(pat) : unixMatch(pat);
  return pids.filter((p) => !exclude.has(p));
}

/**
 * True if at least one OTHER process (not our own tree) matches `pattern`.
 * The cross-platform replacement for the old `safePgrep`.
 */
export function isProcessRunning(pattern: string): boolean {
  return matchingProcessPids(pattern).length > 0;
}

/**
 * Parent pid + command line for a single process, cross-platform — the pieces
 * an ancestry walk needs. Unix: `ps -p <pid> -o ppid=,command=`. Windows: the
 * Win32_Process CIM snapshot (ParentProcessId + CommandLine). Returns null when
 * the pid is gone or the lookup fails. Replaces a bare `ps` shell-out (Unix-only).
 */
export function processInfo(pid: number): { ppid: number; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWindows()) {
    const row = windowsProcessRows().find((r) => r.pid === pid);
    return row ? { ppid: row.ppid, command: row.cmd } : null;
  }
  const r = runDetailed('ps', ['-p', String(pid), '-o', 'ppid=,command='], { timeoutMs: 3_000 });
  if (r.status !== 0) return null;
  const line = r.stdout.trim();
  if (!line) return null;
  // ps prints "  <ppid> <command…>"; split off the leading ppid token.
  const firstSpace = line.indexOf(' ');
  if (firstSpace < 0) return { ppid: parseInt(line, 10) || 0, command: '' };
  return {
    ppid: parseInt(line.slice(0, firstSpace).trim(), 10) || 0,
    command: line.slice(firstSpace + 1).trim(),
  };
}
