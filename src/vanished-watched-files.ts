/**
 * A file that appeared and vanished, and that no tool call ever wrote, is
 * nobody's work.
 *
 * RCCE-423 (874ff028). A background job the agent started writes a scratch
 * file after Stop closed the turn. The write journal is watching the tree, so
 * the write lands inside the closed turn's span and the turn's row gains the
 * file. The job deletes it again during the NEXT turn, where the same write
 * is dropped as watched-only — it is not that turn's authoring either. The
 * creation stays behind: the closed turn keeps naming a file that exists in no
 * tree and in no commit, with lines nobody can look at.
 *
 * The rule is narrow on purpose, and every part of it is required:
 *
 *   - the row's section adds or removes the file whole (`new file mode`,
 *     `deleted file mode`). The job's creation lands on the closed turn and its
 *     removal on the next one, and neither is that turn's work; a file the turn
 *     EDITED has a before-state, and that is real work;
 *   - no tool call, edit hook or command named the file — only watched
 *     evidence saw it (WATCHED_ONLY_EVIDENCE, the same reading
 *     trim-watched-edits uses);
 *   - the file is in neither the working tree, nor HEAD, nor any commit the
 *     session still owns.
 *
 * So a shell-written file that survives is kept, a deletion of a real file is
 * kept (it is in HEAD, so the check below finds it), work committed on a branch
 * is kept, and anything git cannot answer is kept. Only a file that exists
 * nowhere — not on disk, not in HEAD, not in a commit the session owns — goes.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WATCHED_ONLY_EVIDENCE } from './trim-watched-edits.js';

const norm = (f: string) => f.replace(/\\/g, '/');

export interface VanishableRow {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  contentUnavailableFiles?: string[];
}

interface Section { file: string; text: string; added: number; removed: number; isAdd: boolean; isDelete: boolean }

/** `diff --git` sections, with the counts and the "new file" flag of each. */
function sectionsOf(text: string | null | undefined): Section[] {
  const out: Section[] = [];
  const raw = String(text || '');
  if (!raw.trim()) return out;
  const lines = raw.split('\n');
  let current: Section | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) out.push(current);
      const file = line.split(' b/')[1] || '';
      current = { file: norm(file.trim()), text: '', added: 0, removed: 0, isAdd: false, isDelete: false };
    }
    if (!current) continue;
    current.text += `${line}\n`;
    if (line.startsWith('new file mode')) current.isAdd = true;
    else if (line.startsWith('deleted file mode')) current.isDelete = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  if (current) out.push(current);
  return out;
}

const git = (repoPath: string, args: string[]): { ok: boolean; out: string } => {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        windowsHide: true, cwd: repoPath, encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
      }).toString(),
    };
  } catch { return { ok: false, out: '' }; }
};

/**
 * Every path the given commits name, or null when git could not say — a sha it
 * cannot read, a timeout, an output past the buffer. `ok` is the whole answer:
 * the commands below are chosen so that "no such path" is an EMPTY SUCCESS,
 * never a failure (`git cat-file -e HEAD:missing` exits 128, the same as a
 * fatal error, which is why it is not used).
 */
function filesInCommits(repoPath: string, shas: readonly string[]): Set<string> | null {
  const valid = shas.filter((s) => /^[a-fA-F0-9]{7,40}$/.test(s));
  if (valid.length === 0) return new Set();
  const r = git(repoPath, ['show', '--name-only', '--no-renames', '--format=', ...valid]);
  if (!r.ok) return null;
  return new Set(r.out.split('\n').map((l) => norm(l.trim())).filter(Boolean));
}

/**
 * Is there a directory ENTRY for `file` in the repo?
 *
 * true / false / null when the filesystem could not say. Asked of the
 * filesystem, not of git: `ls-files --others --exclude-standard` never names an
 * IGNORED file, so a build artifact, a scratch file — or a path a `.gitignore`
 * hides — is still there while git stays silent about it.
 *
 * `lstat`, not `existsSync`: a symlink whose target is missing is still an
 * entry the tree has, and `existsSync` follows the link and answers false for
 * it. Only a proven ENOENT/ENOTDIR is "no path"; any other error is unknown.
 * An absolute path, or one climbing out of the repo, is never probed.
 */
export function repoEntryExists(repoPath: string, file: string): boolean | null {
  if (!repoPath || !file || path.isAbsolute(file) || norm(file).split('/').includes('..')) return null;
  try {
    fs.lstatSync(path.join(repoPath, file));
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

/** Files a tool call, an edit hook or a command named for this turn. */
function authoredFiles(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  try {
    const cap = JSON.parse(raw) as { edits?: Array<{ file?: unknown; evidence?: unknown }> };
    for (const e of Array.isArray(cap?.edits) ? cap.edits : []) {
      if (!e || typeof e.file !== 'string' || !e.file) continue;
      if (typeof e.evidence === 'string' && WATCHED_ONLY_EVIDENCE.has(e.evidence)) continue;
      out.add(norm(e.file));
    }
  } catch { /* unparseable payload claims nothing */ }
  return out;
}

/**
 * Take the vanished, never-authored additions off each row, in place. Returns
 * the files dropped, per row. Run after the git passes and BEFORE editsJson is
 * trimmed, so the watched edits of a dropped file go with it. Never throws.
 */
export function dropVanishedWatchedAdds(
  repoPath: string | null | undefined,
  rows: ReadonlyArray<VanishableRow | null | undefined>,
  opts: {
    editsByIndex?: Map<number, string> | null;
    /** Commits the session still owns — their files are work, wherever the tree is now. */
    commitShas?: readonly string[];
    /**
     * Files git proved existed only inside a commit the session reset away
     * (`abandonedOnlyFiles` in commands/hooks.ts). For these, authorship does
     * not keep the section: the session itself threw the work away, and the
     * other three checks below still have to answer "gone" before anything is
     * dropped. An empty list — every git failure included — changes nothing.
     *
     * Deliberately the opposite of trim-watched-edits.ts, which KEEPS an
     * authored edit on the same file. The two are answering different
     * questions: this drops the DIFF, because a card of lines nobody can open
     * is a lie about the repository; that keeps the RECORD, because the agent
     * really did write the file. Do not "fix" the asymmetry — it is the point.
     */
    abandonedFiles?: readonly string[];
    log?: (event: string, data: Record<string, unknown>) => void;
  } = {},
): Map<number, string[]> {
  const dropped = new Map<number, string[]>();
  if (!repoPath || !Array.isArray(rows) || rows.length === 0) return dropped;
  try {
    // Fail closed: every check below reads git, and a git that cannot answer
    // would make every file look gone.
    if (!git(repoPath, ['rev-parse', '--git-dir']).ok) return dropped;
    if (!git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) return dropped;
    let committed: Set<string> | null | undefined;
    /** true / false / null when git could not answer. */
    const inACommit = (f: string): boolean | null => {
      if (committed === undefined) committed = filesInCommits(repoPath, opts.commitShas || []);
      return committed === null ? null : committed.has(f);
    };
    /** See repoEntryExists: the filesystem answers, not git. */
    const onDisk = (f: string): boolean | null => repoEntryExists(repoPath, f);
    /** In HEAD's tree. `ls-tree` prints nothing and SUCCEEDS for a path it does not have. */
    const inHead = (f: string): boolean | null => {
      const r = git(repoPath, ['ls-tree', '-r', '--name-only', 'HEAD', '--', f]);
      return r.ok ? r.out.trim() !== '' : null;
    };

    const abandoned = new Set((Array.isArray(opts.abandonedFiles) ? opts.abandonedFiles : [])
      .filter((f): f is string => typeof f === 'string' && !!f).map(norm));

    for (const row of rows) {
      if (!row || !Number.isInteger(row.promptIndex)) continue;
      const authored = authoredFiles(opts.editsByIndex?.get(row.promptIndex));
      const halves: Array<'diff' | 'uncommittedDiff'> = ['diff', 'uncommittedDiff'];
      const gone = new Set<string>();
      let added = 0;
      let removed = 0;
      for (const half of halves) {
        const sections = sectionsOf(row[half] as string | null | undefined);
        if (sections.length === 0) continue;
        const keep: Section[] = [];
        for (const s of sections) {
          const wholeFile = s.isAdd || s.isDelete;
          // Every answer must be a NO. An unknown keeps the section: absence of
          // evidence is not evidence that the file is gone.
          const vanished = wholeFile && !!s.file && (abandoned.has(s.file) || !authored.has(s.file))
            && inACommit(s.file) === false && onDisk(s.file) === false && inHead(s.file) === false;
          if (!vanished) { keep.push(s); continue; }
          gone.add(s.file);
          added += s.added;
          removed += s.removed;
        }
        if (gone.size > 0) row[half] = keep.map((s) => s.text).join('') as any;
      }
      if (gone.size === 0) continue;
      if (Array.isArray(row.filesChanged)) {
        row.filesChanged = (row.filesChanged as unknown[])
          .filter((f) => !(typeof f === 'string' && gone.has(norm(f))));
      }
      if (Array.isArray(row.contentUnavailableFiles)) {
        row.contentUnavailableFiles = (row.contentUnavailableFiles as string[]).filter((f: string) => !gone.has(norm(f)));
      }
      row.linesAdded = Math.max(0, (Number(row.linesAdded) || 0) - added);
      row.linesRemoved = Math.max(0, (Number(row.linesRemoved) || 0) - removed);
      dropped.set(row.promptIndex, [...gone].sort());
      opts.log?.('a file that appeared and vanished, written by no tool, dropped from the turn', {
        promptIndex: row.promptIndex, files: [...gone].slice(0, 20), linesAdded: added, linesRemoved: removed,
      });
    }
  } catch { /* leave every row as it was */ }
  return dropped;
}
