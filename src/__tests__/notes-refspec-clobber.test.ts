// Attribution notes must survive an ordinary `git pull`.
//
// Root cause this pins: `origin enable` installed
// `+refs/notes/origin:refs/notes/origin` on the remote — a FORCED refspec
// mapping the remote's notes straight onto the local ref. Every ordinary
// `git fetch`/`git pull` then force-updated refs/notes/origin from the remote,
// silently destroying any note written locally but not yet pushed (offline, a
// failed push, a push that lost a race). No warning, no recovery: the note is
// simply gone, and with it the prompt behind that commit.
//
// The safe design already existed in git-notes.ts and is what we now use
// everywhere: stage into refs/notes/origin-remote, then `git notes merge -s ours`
// so this machine stays authoritative for commits it annotated itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LEGACY_CLOBBERING_NOTES_REFSPEC,
  NOTES_FETCH_REFSPEC,
  removeLegacyNotesRefspec,
  syncNotesFromRemote,
} from '../git-notes.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function noteOf(cwd: string, rev = 'HEAD'): string | null {
  try { return git(cwd, 'notes', '--ref=origin', 'show', rev); } catch { return null; }
}
function fetchspecs(cwd: string): string[] {
  try {
    return git(cwd, 'config', '--get-all', 'remote.origin.fetch').split('\n').map((s) => s.trim());
  } catch { return []; }
}

describe('notes survive an ordinary git pull', () => {
  let bare: string;
  let author: string;   // the machine that publishes notes
  let local: string;    // our machine — writes notes, pulls

  beforeEach(() => {
    const tmp = fs.realpathSync(os.tmpdir());
    bare = fs.mkdtempSync(path.join(tmp, 'notes-remote-')) + '.git';
    execFileSync('git', ['init', '-q', '--bare', bare]);

    author = fs.mkdtempSync(path.join(tmp, 'notes-author-'));
    git(author, 'init', '-q', '-b', 'main', '.');
    git(author, 'config', 'user.email', 'a@a.co');
    git(author, 'config', 'user.name', 'a');
    git(author, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(author, 'f.txt'), 'v1\n');
    git(author, 'add', '-A');
    git(author, 'commit', '-qm', 'c1');
    git(author, 'remote', 'add', 'origin', bare);
    git(author, 'push', '-q', 'origin', 'main');
    git(author, 'notes', '--ref=origin', 'add', '-m', '{"who":"author"}', 'HEAD');
    git(author, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');

    local = fs.mkdtempSync(path.join(tmp, 'notes-local-'));
    fs.rmSync(local, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', bare, local]);
    git(local, 'config', 'user.email', 'b@b.co');
    git(local, 'config', 'user.name', 'b');
    git(local, 'config', 'commit.gpgsign', 'false');
  });

  afterEach(() => {
    for (const d of [bare, author, local]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  /** Our machine annotates a new commit but never pushes the note. */
  function writeUnpushedLocalNote(): string {
    fs.appendFileSync(path.join(local, 'f.txt'), 'v2\n');
    git(local, 'commit', '-qam', 'c2');
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"who":"local-unpushed"}', 'HEAD');
    return git(local, 'rev-parse', 'HEAD');
  }

  /** The remote's notes ref moves on, so a pull has something to bring down. */
  function advanceRemoteNotes(): void {
    git(author, 'notes', '--ref=origin', 'add', '-f', '-m', '{"who":"author-v2"}', 'HEAD');
    git(author, 'push', '-q', '-f', 'origin', '+refs/notes/origin:refs/notes/origin');
  }

  it('DEMONSTRATES the bug: the legacy forced refspec destroys an unpushed local note', () => {
    // Exactly what an older `origin enable` configured.
    git(local, 'config', '--add', 'remote.origin.fetch', LEGACY_CLOBBERING_NOTES_REFSPEC);
    writeUnpushedLocalNote();
    expect(noteOf(local)).toContain('local-unpushed');

    advanceRemoteNotes();
    git(local, 'fetch', '-q', 'origin');

    // The local note is gone — this is the data loss.
    expect(noteOf(local)).toBeNull();
  });

  it('syncNotesFromRemote keeps the unpushed local note AND brings the remote one', () => {
    writeUnpushedLocalNote();
    advanceRemoteNotes();

    syncNotesFromRemote(local);
    git(local, 'fetch', '-q', 'origin'); // an ordinary pull, using whatever refspecs are configured

    // Ours survived…
    expect(noteOf(local)).toContain('local-unpushed');
    // …and the author's note for c1 came down too.
    const c1 = git(local, 'rev-parse', 'HEAD~1');
    expect(noteOf(local, c1)).toContain('author');
  });

  it('syncNotesFromRemote strips the legacy refspec so a poisoned repo stops losing notes', () => {
    // A repo configured by an older release.
    git(local, 'config', '--add', 'remote.origin.fetch', LEGACY_CLOBBERING_NOTES_REFSPEC);
    expect(fetchspecs(local)).toContain(LEGACY_CLOBBERING_NOTES_REFSPEC);

    syncNotesFromRemote(local);

    // Healed: the clobbering spec is gone, the staging one is in place.
    expect(fetchspecs(local)).not.toContain(LEGACY_CLOBBERING_NOTES_REFSPEC);
    expect(fetchspecs(local)).toContain(NOTES_FETCH_REFSPEC);

    // And now the same sequence that destroyed the note above is survivable.
    writeUnpushedLocalNote();
    advanceRemoteNotes();
    git(local, 'fetch', '-q', 'origin');
    expect(noteOf(local)).toContain('local-unpushed');
  });

  it('removeLegacyNotesRefspec is idempotent and leaves the staging refspec alone', () => {
    git(local, 'config', '--add', 'remote.origin.fetch', NOTES_FETCH_REFSPEC);
    // Nothing to remove yet.
    expect(removeLegacyNotesRefspec(local, 'origin')).toBe(false);
    expect(fetchspecs(local)).toContain(NOTES_FETCH_REFSPEC);

    git(local, 'config', '--add', 'remote.origin.fetch', LEGACY_CLOBBERING_NOTES_REFSPEC);
    expect(removeLegacyNotesRefspec(local, 'origin')).toBe(true);
    expect(removeLegacyNotesRefspec(local, 'origin')).toBe(false); // second call: no-op

    // The staging refspec and the default branch spec must be untouched.
    const specs = fetchspecs(local);
    expect(specs).toContain(NOTES_FETCH_REFSPEC);
    expect(specs.some((s) => s.includes('refs/heads/*'))).toBe(true);
  });
});
