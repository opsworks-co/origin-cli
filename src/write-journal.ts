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
  /**
   * SHA-256 of the file's content AFTER this write.
   *
   * Absent on a record written before content recording existed, and on a
   * delete. Present-but-unretained is normal and meaningful: the store may have
   * declined to keep a 4 MB file's bytes, and the hash still pins exactly which
   * state the file reached. See write-journal-store.ts on honest degradation.
   */
  hash?: string;
  /** Byte length of the content this hash addresses. */
  size?: number;
  /** True when the bytes are retrievable from the snapshot store. */
  retained?: boolean;
  /** The file was gone when the watcher looked — a delete, not an empty write. */
  gone?: boolean;
  /**
   * The file's own mtime when the watcher looked, epoch ms.
   *
   * `at` is when we OBSERVED an event; this is when the file was last actually
   * written. They are normally within milliseconds, and when they are not, the
   * event was not a write.
   *
   * That distinction is not theoretical. `fs.watch(recursive)` on Windows fires
   * for things that did not change a file's bytes, and the journal records an
   * event as a write: session bd3c110a turn 2 recorded seven files in a single
   * second — .claude/launch.json, dev.sh, docker-start.sh, fly.dev.toml,
   * fly.toml, pnpm-workspace.yaml, stop.sh — whose mtimes on disk were from the
   * previous MONTH. Nothing had written them, and the turn was billed 11 files
   * / +684 for a turn that edited one.
   *
   * Absent on records written before this field existed, which is why every
   * consumer must treat "no mtime" as "no opinion" rather than as evidence.
   */
  mtime?: number;
}

/**
 * A turn boundary, recorded in the SAME log as the writes.
 *
 * This is the part that makes attribution exact rather than inferred. Today a
 * turn's files are chosen by comparing write timestamps to a window held
 * somewhere else, and the window has a known soft edge — the watcher polls, so
 * a baseline is taken up to one interval after the turn really began, and turn
 * N swallows turn N+1's first writes (transcript-attribution.ts documents that
 * exact failure). Two clocks and two files can disagree.
 *
 * One ordered log cannot. A write appended after turn B's mark and before turn
 * C's belongs to turn B, by position, with no arithmetic on timestamps at all.
 */
export interface TurnMark {
  /** Epoch ms the turn was declared to begin. */
  at: number;
  /** The turn's stable id — never its position. */
  turnId: string;
  /**
   * Files whose LAST write before this mark belongs to this turn, not the one
   * before it.
   *
   * A turn nobody announced — Cursor folds a prompt typed mid-generation into
   * the running turn and fires no prompt hook for it — is discovered by the
   * edit that reveals it, and by then that edit is already in the log ahead of
   * any mark this turn could get. Position alone would file it under the
   * previous turn. The discovering hook knows exactly which file it was, so it
   * says so here, and both turns' spans are read with that one record moved.
   * Only the last record per file moves: that is the write that fired the hook.
   */
  reclaim?: string[];
}

export type JournalEntry =
  | ({ kind: 'write' } & WriteRecord)
  | ({ kind: 'turn' } & TurnMark);

export interface TurnWindow {
  /** Epoch ms the turn began. */
  startedAt: number;
  /** Epoch ms the turn ended; omit for a turn still running. */
  endedAt?: number;
}

/**
 * One journal line. Newline-delimited JSON so appends stay atomic-ish.
 *
 * Keys stay one character: a busy session appends tens of thousands of these
 * and the file is re-read on every hook. Optional fields are omitted rather
 * than written null, so a record with nothing extra is byte-identical to the
 * pre-content format and old journals keep parsing.
 */
export function serializeRecord(rec: WriteRecord): string {
  const o: Record<string, unknown> = { f: rec.file, t: rec.at };
  if (rec.hash) o.h = rec.hash;
  if (typeof rec.size === 'number') o.n = rec.size;
  if (rec.retained) o.r = 1;
  if (rec.gone) o.g = 1;
  if (typeof rec.mtime === 'number' && Number.isFinite(rec.mtime)) o.m = rec.mtime;
  return JSON.stringify(o) + '\n';
}

/** One turn-boundary line. `k:'t'` is what distinguishes it from a write. */
export function serializeTurnMark(mark: TurnMark): string {
  const o: Record<string, unknown> = { k: 't', t: mark.at, id: mark.turnId };
  if (mark.reclaim && mark.reclaim.length > 0) o.c = mark.reclaim;
  return JSON.stringify(o) + '\n';
}

/**
 * Parse a journal into its ordered entries, skipping anything malformed rather
 * than failing the read.
 *
 * Order is the file's order and is load-bearing — `writesForTurn` reads
 * position, not time. Never sort the result.
 */
export function parseJournalEntries(text: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o.k === 't') {
        if (typeof o.id === 'string' && o.id && typeof o.t === 'number' && Number.isFinite(o.t)) {
          const mark: JournalEntry = { kind: 'turn', at: o.t, turnId: o.id };
          if (Array.isArray(o.c) && o.c.every((f: unknown) => typeof f === 'string')) mark.reclaim = o.c;
          out.push(mark);
        }
        continue;
      }
      if (typeof o.f === 'string' && o.f && typeof o.t === 'number' && Number.isFinite(o.t)) {
        const rec: JournalEntry = { kind: 'write', file: o.f, at: o.t };
        if (typeof o.h === 'string' && o.h) rec.hash = o.h;
        if (typeof o.n === 'number' && Number.isFinite(o.n)) rec.size = o.n;
        if (o.r) rec.retained = true;
        if (o.g) rec.gone = true;
        if (typeof o.m === 'number' && Number.isFinite(o.m)) rec.mtime = o.m;
        out.push(rec);
      }
    } catch { /* a torn final line during an append — skip it */ }
  }
  return settleLateWrites(out);
}

/**
 * A write OBSERVED after a turn mark but MADE before it belongs to the turn
 * before the mark.
 *
 * Attribution is by position, and the watcher does not always observe a
 * write the instant it lands: a burst on one file is re-read once the
 * debounce window closes (write-journal-watch.ts), and on Linux the first
 * inotify event can arrive on the truncate, before the bytes. Either way the
 * record can be appended a few hundred milliseconds late — and if a turn mark
 * was written in between, the previous turn's last write reads as the next
 * turn's first. The Cursor e2e harness caught it on Linux: turn 1's app.py
 * showed up in turn 2's file list, whose own write was notes.md.
 *
 * `mtime` is the file's own last-write time, so it says when the write
 * happened regardless of when it was noticed. A record whose mtime predates
 * the mark it follows is moved in front of that mark. Records without an
 * mtime carry no opinion and stay where they are.
 */
export function settleLateWrites(entries: JournalEntry[]): JournalEntry[] {
  // How long after a mark a late observation can still land: the debounce
  // window plus generous jitter. Anything later is not a late observation.
  const LATE_OBSERVATION_MS = 5_000;
  // A write made right AFTER the mark can still carry an mtime a few
  // milliseconds BEFORE it: Linux stamps files from the kernel's coarse
  // clock (1-4 ms steps) while the mark is Date.now(). A late observation is
  // never that close — the debounce alone puts it 250 ms after the write.
  const COARSE_CLOCK_SLACK_MS = 40;
  const out: JournalEntry[] = [];
  let prevSpanStart = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== 'turn') { out.push(e); continue; }
    // Files the turn BEFORE this mark wrote: only a continuation of one of
    // those can be a late observation. A file with no record before the
    // mark whose mtime merely rounds a few ms backwards past it (coarse
    // filesystem clocks) is this turn's own first write and stays put; so
    // does a delete, whose mtime is of a file that no longer exists.
    const written = new Set<string>();
    for (let k = prevSpanStart; k < i; k++) {
      const p = entries[k];
      if (p.kind === 'write' && !p.gone) written.add(p.file);
    }
    const late: JournalEntry[] = [];
    const rest: JournalEntry[] = [];
    let j = i + 1;
    for (; j < entries.length && entries[j].kind !== 'turn'; j++) {
      const n = entries[j];
      const isLate = n.kind === 'write' && !n.gone
        && typeof n.mtime === 'number' && n.mtime < e.at - COARSE_CLOCK_SLACK_MS
        && n.at - e.at <= LATE_OBSERVATION_MS
        && written.has(n.file);
      (isLate ? late : rest).push(n);
    }
    out.push(...late, e, ...rest);
    prevSpanStart = i + 1;
    i = j - 1;
  }
  return out;
}

/**
 * Parse a journal's WRITES only.
 *
 * Kept as the original entry point so every existing caller (and the window
 * fallback) keeps working unchanged while turn marks are being adopted.
 */
export function parseJournal(text: string): WriteRecord[] {
  return parseJournalEntries(text)
    .filter((e): e is { kind: 'write' } & WriteRecord => e.kind === 'write')
    .map(({ kind: _kind, ...rec }) => rec);
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

// ─── Turn-scoped reads ──────────────────────────────────────────────────────
//
// Everything below reads the log BY POSITION. None of it compares timestamps,
// because that is the inference this design exists to remove.

/**
 * The half-open span of entry indices belonging to a turn: `[start, end)`.
 *
 * `start` is the index just after the turn's mark, `end` the index of the next
 * mark (or the end of the log for the turn still running). Returns null when
 * the turn was never marked — the caller then falls back to the time window
 * rather than assuming the turn wrote nothing.
 *
 * A turn marked more than once (a re-fired hook, a resumed session) takes its
 * LAST mark. Re-marking means "the turn starts here now"; honouring the first
 * would re-admit writes the re-mark was issued to disown.
 */
export function turnSpan(entries: readonly JournalEntry[], turnId: string): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'turn' && e.turnId === turnId) start = i + 1;
  }
  if (start < 0) return null;
  let end = entries.length;
  for (let i = start; i < entries.length; i++) {
    if (entries[i].kind === 'turn') { end = i; break; }
  }
  return { start, end };
}

/**
 * The indices of the write records that are a turn's own, ascending.
 *
 * The span by position, then two corrections for marks that RECLAIM a file
 * (see TurnMark.reclaim): a record the NEXT mark reclaims leaves this turn,
 * and a record THIS turn's mark reclaims from the previous span joins it.
 * Everything else in the ledger reads through here, so the two turns can
 * never both hold the moved record.
 */
export function turnWriteIndices(entries: readonly JournalEntry[], turnId: string): number[] {
  const span = turnSpan(entries, turnId);
  if (!span) return [];
  // The last write of `file` in [from, to) — and any record immediately
  // ahead of it that is the SAME write seen twice. Watch backends fire more
  // than one event per save (a rename and a change; two recorders on one
  // tree), and the recorder debounces per instance, not across them. One
  // write, one attribution: a duplicate left behind would let the previous
  // turn keep a copy of the write this turn reclaimed.
  const lastWriteOf = (file: string, from: number, to: number): number[] => {
    for (let i = to - 1; i >= from; i--) {
      const e = entries[i];
      if (e.kind !== 'write' || e.file !== file) continue;
      const found = [i];
      for (let j = i - 1; j >= from; j--) {
        const p = entries[j];
        if (p.kind !== 'write' || p.file !== file) break;
        if ((p.hash ?? null) !== (e.hash ?? null) || !!p.gone !== !!e.gone) break;
        found.unshift(j);
      }
      return found;
    }
    return [];
  };
  const excluded = new Set<number>();
  const next = entries[span.end];
  if (next && next.kind === 'turn' && next.reclaim) {
    for (const f of next.reclaim) {
      for (const i of lastWriteOf(f, span.start, span.end)) excluded.add(i);
    }
  }
  const out: number[] = [];
  const own = entries[span.start - 1];
  if (own && own.kind === 'turn' && own.reclaim) {
    let prevStart = 0;
    for (let i = span.start - 2; i >= 0; i--) {
      if (entries[i].kind === 'turn') { prevStart = i + 1; break; }
    }
    for (const f of own.reclaim) {
      out.push(...lastWriteOf(f, prevStart, span.start - 1));
    }
    out.sort((a, b) => a - b);
  }
  for (let i = span.start; i < span.end; i++) {
    if (entries[i].kind === 'write' && !excluded.has(i)) out.push(i);
  }
  return out;
}

/** Every write recorded inside a turn, in order, duplicates included. */
export function writesForTurn(entries: readonly JournalEntry[], turnId: string): WriteRecord[] {
  const out: WriteRecord[] = [];
  for (const i of turnWriteIndices(entries, turnId)) {
    const e = entries[i];
    if (e.kind === 'write') { const { kind: _k, ...rec } = e; out.push(rec); }
  }
  return out;
}

export interface TurnFileChange {
  file: string;
  /**
   * Content hash the file held when the turn began — the last hash recorded
   * for it BEFORE this turn's mark.
   *
   * Null means this turn is the first to write the file in this session, so the
   * journal has no earlier state for it. That is a genuine "unknown here", not
   * "the file was empty": the caller resolves it with one precise
   * `git show <baseline>:<file>`, which costs O(files this turn touched) rather
   * than the whole-tree diff the current pipeline takes.
   */
  beforeHash: string | null;
  /** Content hash after the turn's LAST write to the file. Null if deleted. */
  afterHash: string | null;
  /** The turn's last record for this file was a delete. */
  deleted: boolean;
  /** True when both sides are retrievable, so an exact diff can be rendered. */
  renderable: boolean;
  /** Size of the after-state, when known. */
  size?: number;
  /** How many times the turn wrote this file. Churn, not net change. */
  writes: number;
  /**
   * Latest filesystem mtime observed for this file during the turn, epoch ms.
   *
   * Undefined when no record carried one (a journal written before the field
   * existed). Consumers must read that as "unknown", never as "old".
   */
  mtime?: number;
  /**
   * The turn's first record for this file sits AHEAD of the turn's mark — it
   * was reclaimed from the previous span (see TurnMark.reclaim). A caller
   * resolving a null `beforeHash` through git must not use THIS turn's
   * baseline for it: that baseline was cut after the write and already holds
   * it, which reads as no change at all.
   */
  reclaimed?: boolean;
}

/**
 * What a turn did to each file it touched, as before/after content addresses.
 *
 * This is the whole point of the stage. A file's before-state is not derived
 * from a baseline commit, a shadow, or a working-tree scan — it is the previous
 * snapshot this same log recorded, so two consecutive turns cannot both claim
 * one change and a turn cannot inherit its predecessor's work. The cumulative-
 * diff defect stage 0 measured (turn 4 re-containing turn 1's change byte for
 * byte) is structurally impossible here: turn 4's before-state IS turn 3's
 * after-state.
 *
 * A file written and then restored to its original content inside one turn is
 * reported with `beforeHash === afterHash`. That is correct and deliberate: the
 * turn did work, and the NET change is nothing. Callers that render diffs
 * should skip it; callers counting activity should not.
 */
export function turnFileChanges(entries: readonly JournalEntry[], turnId: string): TurnFileChange[] {
  const own = turnWriteIndices(entries, turnId);
  if (turnSpan(entries, turnId) === null) return [];
  const ownSet = new Set(own);
  const firstOwn = own.length > 0 ? own[0] : (turnSpan(entries, turnId)!.start);

  // Last state each file was seen in before this turn's first record. A
  // record this turn reclaimed from the previous span is its own and must not
  // seed its own before-state; the record ahead of it does.
  const before = new Map<string, string | null>();
  const ceiling = Math.max(firstOwn, turnSpan(entries, turnId)!.start);
  for (let i = 0; i < ceiling; i++) {
    const e = entries[i];
    if (e.kind !== 'write' || ownSet.has(i)) continue;
    before.set(e.file, e.gone ? null : (e.hash ?? null));
  }

  const order: string[] = [];
  const acc = new Map<string, TurnFileChange>();
  const spanStart = turnSpan(entries, turnId)!.start;
  for (const i of own) {
    const e = entries[i];
    if (e.kind !== 'write') continue;
    let cur = acc.get(e.file);
    if (!cur) {
      cur = {
        file: e.file,
        beforeHash: before.has(e.file) ? (before.get(e.file) as string | null) : null,
        afterHash: null,
        deleted: false,
        renderable: false,
        writes: 0,
        ...(i < spanStart ? { reclaimed: true } : {}),
      };
      acc.set(e.file, cur);
      order.push(e.file);
    }
    cur.writes++;
    cur.deleted = !!e.gone;
    cur.afterHash = e.gone ? null : (e.hash ?? null);
    if (typeof e.size === 'number') cur.size = e.size;
    if (typeof e.mtime === 'number') cur.mtime = e.mtime;
    // Renderable needs BOTH sides retrievable. The before-side is only known to
    // be retained if some earlier record said so, so this is finalised by the
    // caller that owns the snapshot store; here it reflects the after-side only.
    cur.renderable = !e.gone && !!e.retained;
  }
  return order.map((f) => acc.get(f) as TurnFileChange);
}

/** Turn ids present in the log, in the order they were marked. */
export function turnIdsInJournal(entries: readonly JournalEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === 'turn' && !seen.has(e.turnId)) { seen.add(e.turnId); out.push(e.turnId); }
  }
  return out;
}
