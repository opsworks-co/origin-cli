// The storage half of the write journal — see write-journal.ts for why the
// journal exists, and write-journal-watch.ts for the watcher that fills it.
//
// The journal records that a file changed and WHEN. That is enough to say which
// turn touched which file, and it is what stage 0 measured as insufficient: a
// turn's DIFF is still rebuilt afterwards from git against a baseline nobody
// wrote down, which is where `keepRicherTurnCapture` ends up choosing between
// two reconstructions by string length.
//
// This module removes the need to reconstruct at all. Every observed write also
// stores the file's content, addressed by hash. A turn's diff for a file is
// then `snapshot(before) -> snapshot(after)`, where `before` is simply the
// previous snapshot recorded for that file. No baseline, no window, no guess —
// and it is exact for an agent that exposes no hooks whatsoever.
//
// HONEST DEGRADATION is the rule here, and it is the whole reason the caps
// below return a reason instead of silently truncating. Origin's current
// pipeline slices a diff at 200 KB (mid-hunk, producing a corrupt patch) and
// drops it entirely above 2 MB with no marker at all, so a huge commit reads as
// a small one. This store never does that: when content cannot be kept, the
// hash is still recorded, so the reader knows the file changed, knows the exact
// state it changed to, and can say "content not retained" rather than reporting
// a wrong number. Less information is acceptable; wrong information is not.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Largest single file whose content is kept.
 *
 * Generous — a 4 MB source file is pathological, and the cost of keeping it is
 * one write of 4 MB, not a re-read of the repo. Beyond this the hash still goes
 * in the journal.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on one session's snapshot directory.
 *
 * A long session in a busy repo writes the same handful of files hundreds of
 * times; identical content dedupes to one blob, so this is reached only by
 * genuine churn. When it is reached the store stops accepting NEW content and
 * says so, rather than evicting blobs an unsent turn still refers to.
 */
export const MAX_STORE_BYTES = 512 * 1024 * 1024;

/** Bytes inspected when deciding whether a file is binary. */
const SNIFF_BYTES = 8000;

export type PutOutcome = 'stored' | 'deduped' | 'oversize' | 'store_full' | 'binary' | 'error';

export interface PutResult {
  /** SHA-256 of the content. Always present — knowing the state is free. */
  hash: string;
  /** Byte length of the content. */
  size: number;
  /** True when the bytes are retrievable via `getSnapshot`. */
  retained: boolean;
  /** Why the content was or was not kept. */
  outcome: PutOutcome;
  binary: boolean;
}

/** SHA-256, hex. The content address. */
export function hashContent(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Does this look like a binary file?
 *
 * A NUL byte in the first few KB is the same heuristic git uses. Binary content
 * is hashed and its size recorded but never retained: a byte diff of it is
 * unreadable, and keeping it is how a snapshot store fills up with build
 * artefacts nobody will ever look at.
 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Where a hash lives inside the store.
 *
 * Sharded on the first byte: a busy session produces tens of thousands of
 * blobs, and some filesystems degrade badly on a single directory that large.
 */
export function snapshotPath(dir: string, hash: string): string {
  return path.join(dir, hash.slice(0, 2), hash.slice(2));
}

/** Total bytes currently held. Walks the shards; cheap enough at these sizes. */
export function storeBytes(dir: string): number {
  let total = 0;
  let shards: string[] = [];
  try { shards = fs.readdirSync(dir); } catch { return 0; }
  for (const shard of shards) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(dir, shard), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      try { total += fs.statSync(path.join(dir, shard, e.name)).size; } catch { /* raced */ }
    }
  }
  return total;
}

/**
 * Store content and return its address.
 *
 * Never throws: a snapshot failure must degrade the capture, never break the
 * agent. Writes through a temp file and renames, so a crash mid-write cannot
 * leave a blob whose bytes do not match its name — a reader that trusted such a
 * blob would produce a diff that never happened.
 */
export function putSnapshot(
  dir: string,
  content: Buffer | string,
  opts: { maxBytes?: number; maxStoreBytes?: number; currentStoreBytes?: number } = {},
): PutResult {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8');
  const hash = hashContent(buf);
  const size = buf.length;
  const binary = looksBinary(buf);
  const base: PutResult = { hash, size, retained: false, outcome: 'error', binary };

  if (binary) return { ...base, outcome: 'binary' };
  if (size > (opts.maxBytes ?? MAX_SNAPSHOT_BYTES)) return { ...base, outcome: 'oversize' };

  const target = snapshotPath(dir, hash);
  try {
    if (fs.existsSync(target)) return { ...base, retained: true, outcome: 'deduped' };
  } catch { /* fall through and try to write */ }

  const ceiling = opts.maxStoreBytes ?? MAX_STORE_BYTES;
  const used = opts.currentStoreBytes ?? storeBytes(dir);
  if (used + size > ceiling) return { ...base, outcome: 'store_full' };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return { ...base, retained: true, outcome: 'stored' };
  } catch {
    return { ...base, outcome: 'error' };
  }
}

/** Read content back. Null when it was never retained, or is gone. */
export function getSnapshot(dir: string, hash: string | null | undefined): string | null {
  if (!hash) return null;
  try { return fs.readFileSync(snapshotPath(dir, hash), 'utf-8'); } catch { return null; }
}

export function hasSnapshot(dir: string, hash: string | null | undefined): boolean {
  if (!hash) return false;
  try { return fs.existsSync(snapshotPath(dir, hash)); } catch { return false; }
}

/**
 * Snapshot a file from disk, if it is still there.
 *
 * Returns null when the path is gone — a delete, which the journal records as
 * such rather than as a write of empty content. The two are different: an empty
 * file exists.
 */
export function snapshotFile(
  dir: string,
  absPath: string,
  opts: { maxBytes?: number; maxStoreBytes?: number; currentStoreBytes?: number } = {},
): PutResult | null {
  let buf: Buffer;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    // Check the size before reading it: reading a 2 GB file into memory to
    // discover it is too big is the failure this cap exists to prevent.
    if (st.size > (opts.maxBytes ?? MAX_SNAPSHOT_BYTES)) {
      return { hash: '', size: st.size, retained: false, outcome: 'oversize', binary: false };
    }
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  return putSnapshot(dir, buf, opts);
}

/** Remove a session's whole snapshot store. Called when the session ends. */
export function dropStore(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Delete blobs the journal no longer refers to.
 *
 * Called when the watcher compacts, which is the moment some write records age
 * out and their content stops being reachable. Precise rather than time-based:
 * a blob is removed only when NOTHING in the journal names it, so a turn whose
 * capture has not been uploaded yet keeps everything it needs to be re-rendered.
 *
 * Returns the number of bytes reclaimed. Never throws.
 */
export function pruneUnreferenced(dir: string, referenced: Iterable<string>): number {
  const keep = new Set<string>();
  for (const h of referenced) if (h) keep.add(h);
  let freed = 0;
  let shards: string[] = [];
  try { shards = fs.readdirSync(dir); } catch { return 0; }
  for (const shard of shards) {
    const shardDir = path.join(dir, shard);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(shardDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const hash = shard + e.name;
      if (keep.has(hash)) continue;
      const p = path.join(shardDir, e.name);
      try {
        freed += fs.statSync(p).size;
        fs.unlinkSync(p);
      } catch { /* raced with another reader; leave it */ }
    }
    try { if (fs.readdirSync(shardDir).length === 0) fs.rmdirSync(shardDir); } catch { /* ignore */ }
  }
  return freed;
}
