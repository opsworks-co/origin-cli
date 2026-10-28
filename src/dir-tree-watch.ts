// A recursive watch built from one non-recursive watch per DIRECTORY.
//
// The write journal uses it on Linux in place of `fs.watch(root, { recursive:
// true })`, whose Linux implementation in Node 20 (a JavaScript fallback, not
// inotify's own) breaks the journal two ways. Both read off Node 20.20's
// internal/fs/recursive_watch.js:
//
//  1. It watches every FILE by inode. A file git replaces — checkout, rebase,
//     reset all write a new file and rename it into place — keeps the watch on
//     the old, deleted inode, so every later write to it is invisible. CI's
//     capture-e2e-edits-after-a-checkout-stay-the-turns waited 10 s for two
//     edits after a checkout and saw neither.
//  2. Its `unref()` is a no-op: it unrefs the entries of a map that holds
//     Stats objects, not the handles. A process holding a watcher can never
//     exit on its own — `transcript-watch --once` hung until the 180 s test
//     timeout in capture-e2e-watch-shell-turn-decision and -cursor-decisions.
//
// A directory watch reports writes to any file inside it by NAME, whatever
// inode the name points at now, and the handles here are ours to unref. It is
// also far fewer handles: one per directory instead of one per file, and none
// at all under the directories `skipDir` rules out (node_modules, .git).
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export interface DirTreeWatcher extends EventEmitter {
  close(): void;
  unref(): void;
}

/**
 * Watch `root` and every directory below it that `skipDir` does not rule out.
 * `listener` gets the event type and the path relative to `root`, the same
 * shape `fs.watch(root, { recursive: true })` reports. A directory created
 * later is watched as soon as its creation is seen, and the files already in
 * it by then are reported, so a `mkdir -p a/b && echo > a/b/c` is not lost
 * to the gap before its watch exists.
 *
 * Throws, as fs.watch does, when `root` itself cannot be watched. A
 * subdirectory that cannot be watched any more (deleted under us) is dropped
 * quietly; running out of watches (ENOSPC) is an 'error', because a journal
 * missing a subtree looks complete and is not.
 */
export function watchDirTree(
  root: string,
  opts: { persistent?: boolean; skipDir?: (rel: string) => boolean },
  listener: (eventType: string, rel: string) => void,
): DirTreeWatcher {
  const emitter = new EventEmitter() as DirTreeWatcher;
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;
  let unrefd = false;

  const rel = (abs: string): string => path.relative(root, abs);

  const drop = (dir: string): void => {
    for (const [d, w] of watchers) {
      if (d === dir || d.startsWith(dir + path.sep)) {
        try { w.close(); } catch { /* already closed */ }
        watchers.delete(d);
      }
    }
  };

  const fail = (err: unknown): void => {
    if (closed) return;
    emitter.close();
    emitter.emit('error', err);
  };

  // `announce`: report the files found, for a directory that appeared after
  // the watch began (its contents were written before we could see them).
  const add = (dir: string, announce: boolean): void => {
    if (closed || watchers.has(dir)) return;
    if (dir !== root && opts.skipDir?.(rel(dir))) return; // path-compare-ok: the same string we were given
    let w: fs.FSWatcher;
    try {
      w = fs.watch(dir, { persistent: opts.persistent ?? true }, (eventType, name) => {
        if (closed || !name) return;
        const child = path.join(dir, String(name));
        listener(eventType, rel(child));
        if (eventType !== 'rename') return;
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(child); } catch { /* gone */ }
        if (st?.isDirectory()) add(child, true);
        else if (!st) drop(child);
      });
    } catch (err: unknown) {
      if (dir === root) throw err; // path-compare-ok
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOSPC' || code === 'EMFILE') fail(err);
      return;
    }
    w.on('error', (err) => {
      if (dir === root) { fail(err); return; } // path-compare-ok
      drop(dir);
    });
    if (unrefd) w.unref();
    watchers.set(dir, w);

    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = path.join(dir, e.name);
      if (e.isDirectory()) add(child, announce);
      else if (announce && e.isFile()) listener('rename', rel(child));
    }
  };

  emitter.close = (): void => {
    if (closed) return;
    closed = true;
    for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
    watchers.clear();
  };
  emitter.unref = (): void => {
    unrefd = true;
    for (const w of watchers.values()) w.unref();
  };

  add(root, false);
  return emitter;
}
