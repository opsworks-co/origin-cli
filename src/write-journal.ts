// A record of WHEN each file was written, independent of any agent.
//
// Tool hooks are the best evidence we have, but only four of seven agents
// emit them: Codex, Devin and Copilot expose no per-tool or per-edit hook at
// all, so every file they touch is attributed by the turn window — by whatever
// happened to be dirty, which in a shared checkout is also a sibling agent's
// work. No amount of cleverness in the window fixes that, because the window
// has no idea WHEN anything changed.
//
// The filesystem does. A watcher started at session start appends one line per
// observed write, and a turn then claims the writes that happened inside its
// own time span. That is evidence, it needs nothing from the agent, and it
// therefore works for agents that do not exist yet.
//
// What it still cannot do: name the PROCESS behind a write. No filesystem API
// on macOS or Windows reports that without elevated privileges, so two agents
// in ONE checkout remain indistinguishable here — that is what per-session
// worktrees solve, not this.
//
// This module is the pure half: the record format, and the rules for turning
// records into a turn's file list. The watcher process that produces them is
// write-journal-watch.ts, so all of this is testable without touching fs.watch.

export interface WriteRecord {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** Epoch ms when the write was observed. */
  at: number;
}

export interface TurnWindow {
  /** Epoch ms the turn began. */
  startedAt: number;
  /** Epoch ms the turn ended; omit for a turn still running. */
  endedAt?: number;
}

/** One journal line. Newline-delimited JSON so appends stay atomic-ish. */
export function serializeRecord(rec: WriteRecord): string {
  return JSON.stringify({ f: rec.file, t: rec.at }) + '\n';
}

/** Parse a journal, skipping anything malformed rather than failing the read. */
export function parseJournal(text: string): WriteRecord[] {
  const out: WriteRecord[] = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as { f?: unknown; t?: unknown };
      if (typeof o.f === 'string' && o.f && typeof o.t === 'number' && Number.isFinite(o.t)) {
        out.push({ file: o.f, at: o.t });
      }
    } catch { /* a torn final line during an append — skip it */ }
  }
  return out;
}

/**
 * Files written inside a turn's window.
 *
 * Boundaries are INCLUSIVE of start and EXCLUSIVE of end: a write landing at
 * the exact moment the next turn begins belongs to the next turn, so no write
 * is ever claimed by two turns. A turn with no `endedAt` is still running and
 * takes everything from its start onward.
 *
 * Order is first-write-first, and each file appears once — the caller wants a
 * file list, not an event log.
 */
export function filesWrittenDuring(records: readonly WriteRecord[], win: TurnWindow): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (r.at < win.startedAt) continue;
    if (win.endedAt !== undefined && r.at >= win.endedAt) continue;
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    out.push(r.file);
  }
  return out;
}

/**
 * Drop records older than `keepMs`, and cap the total.
 *
 * A journal is append-only for the life of a session, and a long session in a
 * busy repo would otherwise grow without bound and be re-read on every hook.
 * Trimming keeps the NEWEST records: an old write already belongs to a turn
 * that has been captured.
 */
export function trimJournal(records: readonly WriteRecord[], now: number, keepMs: number, maxRecords: number): WriteRecord[] {
  const fresh = records.filter((r) => now - r.at <= keepMs);
  return fresh.length > maxRecords ? fresh.slice(fresh.length - maxRecords) : fresh;
}
