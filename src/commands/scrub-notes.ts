import crypto from 'crypto';
import { gitDetailed, gitIdentityEnv } from '../utils/exec.js';
import { redactRemoteCredentials } from '../git-notes.js';
import {
  PROMPT_CARRIERS,
  scrubNoteBody,
  serializeScrubbedNote,
  verifyScrubbedNote,
  type NoteBlockReason,
  type PromptCarrier,
  type ScrubOptions,
} from '../note-scrub.js';

// origin scrub-notes — remove prompt text that notes written before the
// metadata-only default (OR-48), or under the `notesIncludePrompts: true`
// opt-in, left in this repo's refs/notes/origin (OR-49).
//
//   origin scrub-notes --dry-run            report only: writes nothing, no remote
//   origin scrub-notes                      rewrite the local ref
//   origin scrub-notes --push [--remote r]  rewrite it, then replace r's ref
//   … --drop-unprovable-edits               also delete each whole editsJson that
//                                           was cut short with prompt text in it
//
// The rewrite is all or nothing. Every note blob reachable from the ref — the
// current notes and every earlier version in the ref's history — is read in a
// few batched git calls and classified (note-scrub.ts). Any current note that
// cannot be proven clean or safely rewritten blocks the run (a truncated
// editsJson holding prompt text included, unless --drop-unprovable-edits
// lets that one case be deleted whole). Otherwise the
// notes are written as ONE new parentless commit (the old history is where
// earlier prompt-bearing versions live, so it cannot be kept), on a private
// ref outside refs/notes/origin*, verified against the source, and only then
// swapped in with a compare-and-swap on refs/notes/origin.
//
// --push then replaces exactly refs/notes/origin on one configured remote,
// with --force-with-lease on the tip the scan started from. A remote that
// does not match the local ref, or moves before the push, is never
// overwritten.
//
// Nothing here prints note content: the report is counts, commit SHAs and
// carrier names. Commit SHAs, branches and tags are not touched.

const NOTES_REF = 'refs/notes/origin';
// Outside refs/notes/origin* and refs/origin/*, so no Origin fetch/push glob
// can carry it anywhere; removed before the command returns.
export const CANDIDATE_REF_PREFIX = 'refs/origin-scrub/candidate-';
// Objects per `git cat-file --batch` call: bounded output per child, and a
// fixed number of children per thousand notes.
const READ_BATCH = 500;
const TYPE_BATCH = 20_000;
const BLOCKED_LINES_MAX = 50;

export type GitResult = { stdout: string; stderr: string; status: number };
export type GitRunner = (
  args: string[],
  opts?: { input?: string | Buffer; encoding?: BufferEncoding; env?: Record<string, string>; timeoutMs?: number },
) => GitResult;

export interface ScrubNotesOptions {
  dryRun?: boolean;
  push?: boolean;
  remote?: string;
  /** See ScrubOptions.dropUnprovableEdits: lossy, explicit opt-in only. */
  dropUnprovableEdits?: boolean;
}

export interface ScrubNotesDeps {
  cwd?: string;
  /** Every git call goes through this (the command test counts and intercepts them). */
  git?: GitRunner;
}

interface BlockedNote { commit: string; reason: NoteBlockReason | 'unreadable'; field: string }

export interface ScrubReport {
  mode: 'dry-run' | 'local' | 'push';
  oldTip: string | null;
  newTip: string | null;
  notes: number;
  toRewrite: number;
  clean: number;
  blocked: BlockedNote[];
  carriers: Partial<Record<PromptCarrier, number>>;
  /** Whole editsJson values deleted under --drop-unprovable-edits. */
  editsJsonDropped: number;
  dropUnprovableEdits: boolean;
  historyCommits: number;
  /** Earlier note versions in the ref's history that are not provably clean. */
  historyDirty: number;
  remote: string;
  outcome: string;
}

class ScrubAbort extends Error {}

function defaultRunner(cwd: string): GitRunner {
  return (args, opts = {}) => gitDetailed(args, {
    cwd,
    input: opts.input,
    encoding: opts.encoding,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxBuffer: 512 * 1024 * 1024,
  });
}

// A note's path in the notes tree is the annotated object's hex name,
// possibly split by fanout directories.
function noteTarget(path: string): string | null {
  const hex = path.replace(/\//g, '');
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(hex) ? hex : null;
}

interface TreeEntry { mode: string; type: string; sha: string; path: string }

function lsTree(git: GitRunner, tree: string): TreeEntry[] {
  const r = git(['ls-tree', '-r', '-z', '--full-tree', tree]);
  if (r.status !== 0) throw new ScrubAbort(`could not list the notes tree of ${tree.slice(0, 12)}`);
  return r.stdout.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, path: line.slice(tab + 1) };
  });
}

// Bodies of the given blobs, READ_BATCH per `git cat-file --batch`; a missing
// object, or one that is not valid UTF-8, maps to null. `latin1` keeps one
// char per byte so the sizes in the batch headers index the output directly;
// each body is then decoded strictly: a lenient decode would turn bad bytes
// into U+FFFD, and a rewrite would then store that instead of the original.
// ignoreBOM keeps a BOM as U+FEFF, so it is not silently dropped either.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function strictUtf8(bytes: Buffer): string | null {
  try { return UTF8.decode(bytes); } catch { return null; }
}

function readBlobs(git: GitRunner, shas: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (let start = 0; start < shas.length; start += READ_BATCH) {
    const chunk = shas.slice(start, start + READ_BATCH);
    const r = git(['cat-file', '--batch'], { input: chunk.join('\n') + '\n', encoding: 'latin1', timeoutMs: 120_000 });
    if (r.status !== 0) throw new ScrubAbort('could not read the note objects (git cat-file failed)');
    const raw = r.stdout;
    let pos = 0;
    for (const sha of chunk) {
      const nl = raw.indexOf('\n', pos);
      if (nl < 0) throw new ScrubAbort('could not read the note objects (short git cat-file output)');
      const header = raw.slice(pos, nl).split(' ');
      pos = nl + 1;
      if (header.length < 3) { out.set(sha, null); continue; }
      const size = Number(header[2]);
      if (!Number.isFinite(size)) throw new ScrubAbort('could not read the note objects (bad git cat-file output)');
      out.set(sha, header[1] === 'blob' ? strictUtf8(Buffer.from(raw.slice(pos, pos + size), 'latin1')) : null);
      pos += size + 1; // trailing newline after each object
    }
  }
  return out;
}

// Each object's type from `git cat-file --batch-check`; null when missing.
function objectTypes(git: GitRunner, shas: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (let start = 0; start < shas.length; start += TYPE_BATCH) {
    const chunk = shas.slice(start, start + TYPE_BATCH);
    const r = git(['cat-file', '--batch-check'], { input: chunk.join('\n') + '\n', timeoutMs: 120_000 });
    if (r.status !== 0) throw new ScrubAbort('could not read the note history (git cat-file --batch-check failed)');
    const lines = r.stdout.split('\n');
    chunk.forEach((sha, i) => {
      const [, type] = (lines[i] || '').split(' ');
      out.set(sha, !type || type === 'missing' ? null : type);
    });
  }
  return out;
}

function revParse(git: GitRunner, rev: string): string | null {
  const r = git(['rev-parse', '--verify', '--quiet', rev]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Branches, tags and HEAD: none of them may move because of this command.
function codeRefsSnapshot(git: GitRunner): string {
  const refs = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']);
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const sym = git(['symbolic-ref', '--quiet', 'HEAD']);
  return `${refs.stdout}\nHEAD ${head.stdout.trim()} ${sym.stdout.trim()}`;
}

// A local audit must not reach the network. In a partial (promisor) clone,
// reading an object the clone lacks makes git fetch it on its own; Git 2.45
// added GIT_NO_LAZY_FETCH to stop that, and then a missing object is reported
// missing — an unreadable note — instead. Older git cannot be stopped, so a
// partial clone there is refused before any content is read; a full clone has
// nothing to fetch lazily.
export const NO_LAZY_FETCH_MIN_GIT: [number, number] = [2, 45];

function lazyFetchEnv(git: GitRunner): { env: Record<string, string> } | { error: string } {
  const m = /(\d+)\.(\d+)/.exec(git(['--version']).stdout);
  const [maj, min] = NO_LAZY_FETCH_MIN_GIT;
  if (m && (Number(m[1]) > maj || (Number(m[1]) === maj && Number(m[2]) >= min))) return { env: { GIT_NO_LAZY_FETCH: '1' } };
  const cfg = git(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']);
  const partial = cfg.stdout.split('\n').some((line) => {
    const [key, value = ''] = line.trim().split(/\s+/, 2);
    if (!key) return false;
    return key === 'extensions.partialclone' ? value !== '' : value.toLowerCase() === 'true';
  });
  if (!partial) return { env: {} };
  return {
    error: `this is a partial clone, and git older than ${maj}.${min} cannot read it without fetching missing objects `
      + 'from the remote. Run the scrub from a full clone, or upgrade git',
  };
}

function configuredRemotes(git: GitRunner): string[] {
  const r = git(['remote']);
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

// The remote's advertised refs/notes/origin: a sha, or null when it has none.
function remoteNotesTip(git: GitRunner, remote: string): string | null {
  const r = git(['ls-remote', '--refs', remote, NOTES_REF], { timeoutMs: 60_000 });
  if (r.status !== 0) {
    const why = redactRemoteCredentials(r.stderr.trim().split('\n').pop() || `exit ${r.status}`);
    throw new ScrubAbort(`could not read ${NOTES_REF} on ${remote}: ${why}`);
  }
  const line = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === NOTES_REF);
  return line ? line[0] : null;
}

interface ScanResult {
  entries: TreeEntry[];
  rewrites: Map<string, { before: unknown; body: string }>;
  report: Pick<ScrubReport, 'notes' | 'toRewrite' | 'clean' | 'blocked' | 'carriers' | 'editsJsonDropped' | 'historyCommits' | 'historyDirty'>;
  tipHasParents: boolean;
}

function scan(git: GitRunner, tip: string, scrubOpts: ScrubOptions): ScanResult {
  const entries = lsTree(git, tip);
  const blocked: BlockedNote[] = [];
  const carriers: Partial<Record<PromptCarrier, number>> = {};
  const rewrites = new Map<string, { before: unknown; body: string }>();
  const seenTargets = new Set<string>();
  let clean = 0;
  let editsJsonDropped = 0;

  // Anything in the tree that is not one note per commit is not ours to judge.
  for (const e of entries) {
    const target = noteTarget(e.path);
    // A tree path is arbitrary bytes and may itself hold text: report the
    // entry by its object SHA, never by its path.
    if (!target || e.type !== 'blob') blocked.push({ commit: e.sha, reason: 'unreadable', field: `non-note tree entry (${e.type} object)` });
    else if (seenTargets.has(target)) blocked.push({ commit: target, reason: 'unreadable', field: 'duplicate note path' });
    else seenTargets.add(target);
  }
  const noteEntries = entries.filter((e) => e.type === 'blob' && noteTarget(e.path));
  const bodies = readBlobs(git, [...new Set(noteEntries.map((e) => e.sha))]);
  for (const e of noteEntries) {
    const target = noteTarget(e.path)!;
    const body = bodies.get(e.sha);
    if (body == null) { blocked.push({ commit: target, reason: 'unreadable', field: 'note object' }); continue; }
    const result = scrubNoteBody(body, scrubOpts);
    if (result.status === 'clean') { clean++; continue; }
    if (result.status === 'blocked') { blocked.push({ commit: target, reason: result.reason, field: result.field }); continue; }
    for (const [carrier, n] of Object.entries(result.removed)) {
      carriers[carrier as PromptCarrier] = (carriers[carrier as PromptCarrier] ?? 0) + (n ?? 0);
    }
    editsJsonDropped += result.droppedEditsJson;
    rewrites.set(e.path, { before: result.parsed, body: serializeScrubbedNote(result.scrubbed) });
  }

  // Earlier versions: every blob reachable from the ref that is not a current
  // note. A clone fetching the ref receives all of them. Plain
  // `rev-list --objects` (any git), typed by `cat-file --batch-check`; an
  // object this clone does not have (`?sha`) cannot be proven clean.
  const history = git(['rev-list', '--objects', '--missing=print', tip], { timeoutMs: 120_000 });
  if (history.status !== 0) throw new ScrubAbort(`could not walk the history of ${NOTES_REF} (git rev-list failed)`);
  const listed = new Set<string>();
  for (const line of history.stdout.split('\n')) {
    const sha = (line.startsWith('?') ? line.slice(1) : line).split(' ')[0];
    if (sha) listed.add(sha);
  }
  const current = new Set(noteEntries.map((e) => e.sha));
  const earlier: string[] = [];
  let historyCommits = 0;
  let historyDirty = 0;
  for (const [sha, type] of objectTypes(git, [...listed])) {
    if (type === 'commit') historyCommits++;
    else if (type === null) { if (!current.has(sha)) historyDirty++; }
    else if (type === 'blob' && !current.has(sha)) earlier.push(sha);
  }
  for (const body of readBlobs(git, earlier).values()) {
    if (body == null || scrubNoteBody(body).status !== 'clean') historyDirty++;
  }

  const parents = git(['rev-list', '--parents', '-n', '1', tip]);
  if (parents.status !== 0) throw new ScrubAbort(`could not read the ${NOTES_REF} tip commit`);
  return {
    entries,
    rewrites,
    tipHasParents: parents.stdout.trim().split(/\s+/).length > 1,
    report: { notes: noteEntries.length, toRewrite: rewrites.size, clean, blocked, carriers, editsJsonDropped, historyCommits, historyDirty },
  };
}

// The scrubbed notes as one parentless commit on `candidateRef`, in a single
// `git fast-import`: unchanged notes by their existing blob, rewritten ones
// inline. Returns the new commit.
function buildCandidate(git: GitRunner, cwd: string, s: ScanResult, oldTip: string, candidateRef: string): string {
  const env = gitIdentityEnv(cwd);
  const ident = git(['var', 'GIT_COMMITTER_IDENT'], { env });
  if (ident.status !== 0 || !ident.stdout.trim()) throw new ScrubAbort('no git committer identity to write the rewritten notes with');
  const dropped = s.report.editsJsonDropped
    ? `\nDropped ${plural(s.report.editsJsonDropped, 'truncated editsJson value')} holding prompt text (--drop-unprovable-edits).\n`
    : '';
  const message = `Scrub prompt text from Origin notes\n\nRewritten by origin scrub-notes from ${oldTip}.\n${dropped}`;
  const parts: Buffer[] = [];
  const add = (text: string) => parts.push(Buffer.from(text, 'utf8'));
  add(`commit ${candidateRef}\ncommitter ${ident.stdout.trim()}\ndata ${Buffer.byteLength(message)}\n${message}`);
  for (const e of s.entries) {
    const rewrite = s.rewrites.get(e.path);
    if (!rewrite) { add(`M ${e.mode} ${e.sha} ${e.path}\n`); continue; }
    add(`M ${e.mode} inline ${e.path}\ndata ${Buffer.byteLength(rewrite.body)}\n${rewrite.body}\n`);
  }
  add('\ndone\n');
  const r = git(['fast-import', '--quiet', '--done'], { input: Buffer.concat(parts), env, timeoutMs: 120_000 });
  if (r.status !== 0) throw new ScrubAbort('could not write the rewritten notes (git fast-import failed)');
  const tip = revParse(git, candidateRef);
  if (!tip) throw new ScrubAbort('the rewritten notes commit is missing');
  return tip;
}

// Independent check of the candidate against the scan, before anything live
// moves: same notes on the same commits, untouched notes byte-identical,
// rewritten notes equal to their source minus prompt carriers (and minus a
// whole editsJson only where the option allows it and the source proves it).
function verifyCandidate(git: GitRunner, s: ScanResult, candidate: string, scrubOpts: ScrubOptions): void {
  const parents = git(['rev-list', '--parents', '-n', '1', candidate]);
  if (parents.status !== 0 || parents.stdout.trim().split(/\s+/).length !== 1) {
    throw new ScrubAbort('verification failed: the rewritten notes commit has parents');
  }
  const after = lsTree(git, candidate);
  const before = new Map(s.entries.map((e) => [e.path, e]));
  if (after.length !== s.entries.length) throw new ScrubAbort('verification failed: the number of notes changed');
  const rewrittenShas: string[] = [];
  for (const e of after) {
    const src = before.get(e.path);
    if (!src || src.mode !== e.mode || src.type !== e.type) throw new ScrubAbort('verification failed: the set of annotated commits changed');
    if (s.rewrites.has(e.path)) rewrittenShas.push(e.sha);
    else if (src.sha !== e.sha) throw new ScrubAbort(`verification failed: an untouched note changed (${noteTarget(e.path) ?? e.path})`);
  }
  const bodies = readBlobs(git, rewrittenShas);
  for (const e of after) {
    const rewrite = s.rewrites.get(e.path);
    if (!rewrite) continue;
    const body = bodies.get(e.sha);
    let parsed: unknown;
    try { parsed = body == null ? undefined : JSON.parse(body); } catch { parsed = undefined; }
    const problem = parsed === undefined ? 'rewritten note is not JSON' : verifyScrubbedNote(rewrite.before, parsed, scrubOpts);
    if (problem) throw new ScrubAbort(`verification failed on ${noteTarget(e.path)}: ${problem}`);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printReport(r: ScrubReport, exitCode: number): void {
  console.log(`Origin notes scrub: ${NOTES_REF}${r.mode === 'dry-run' ? ' (dry run — nothing written)' : ''}`);
  console.log(`  ref tip:   ${r.oldTip ?? '(none)'}`);
  console.log(`  notes:     ${r.notes} (${r.clean} already clean, ${r.toRewrite} to rewrite, ${r.blocked.length} blocked)`);
  const carriers = PROMPT_CARRIERS.filter((c) => r.carriers[c]).map((c) => `${c} ×${r.carriers[c]}`);
  console.log(`  carriers:  ${carriers.length ? carriers.join(', ') : 'none'}`);
  if (r.dropUnprovableEdits || r.editsJsonDropped) {
    console.log(`  editsJson dropped: ${r.editsJsonDropped} (truncated payloads containing prompt text)`);
  }
  console.log(`  history:   ${plural(r.historyCommits, 'commit')}, ${plural(r.historyDirty, 'earlier note version')} not provably clean`);
  if (r.blocked.length) {
    console.log('  blocked:');
    for (const b of r.blocked.slice(0, BLOCKED_LINES_MAX)) {
      console.log(`    ${b.commit.slice(0, 12)}  ${b.reason}${b.field ? `  ${b.field}` : ''}`);
    }
    if (r.blocked.length > BLOCKED_LINES_MAX) console.log(`    … ${r.blocked.length - BLOCKED_LINES_MAX} more`);
  }
  if (r.newTip) console.log(`  new tip:   ${r.newTip}`);
  console.log(`  remote:    ${r.remote}`);
  (exitCode === 0 ? console.log : console.error)(`  result:    ${r.outcome}`);
}

/**
 * The whole run: the report and the exit code it implies. Exported for the
 * command test, which injects the git runner.
 */
export function runScrubNotes(opts: ScrubNotesOptions, deps: ScrubNotesDeps = {}): { report: ScrubReport; exitCode: number } {
  const cwd = deps.cwd ?? process.cwd();
  // The remote is reached only through `remoteGit` (git remote, ls-remote,
  // push); every other call reads or writes this repository, with lazy fetch off.
  const remoteGit = deps.git ?? defaultRunner(cwd);
  const mode: ScrubReport['mode'] = opts.dryRun ? 'dry-run' : opts.push ? 'push' : 'local';
  const remote = opts.remote ?? 'origin';
  const report: ScrubReport = {
    mode, oldTip: null, newTip: null, notes: 0, toRewrite: 0, clean: 0, blocked: [], carriers: {},
    editsJsonDropped: 0, dropUnprovableEdits: !!opts.dropUnprovableEdits, historyCommits: 0, historyDirty: 0,
    remote: mode === 'push' ? remote : mode === 'dry-run' ? 'not contacted (dry run)' : 'not contacted (local only)',
    outcome: '',
  };
  const done = (outcome: string, exitCode: number) => { report.outcome = outcome; return { report, exitCode }; };

  if (opts.dryRun && opts.push) return done('--dry-run and --push cannot be combined', 1);
  if (opts.remote !== undefined && !opts.push) return done('--remote only applies with --push', 1);
  if (mode === 'push' && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) || !configuredRemotes(remoteGit).includes(remote))) {
    return done(`"${remote}" is not a configured remote of this repository (see git remote)`, 1);
  }
  const lazy = lazyFetchEnv(remoteGit);
  if ('error' in lazy) return done(`${lazy.error}. ${NOTES_REF} was not read or changed`, 1);
  const git: GitRunner = (args, o = {}) => remoteGit(args, { ...o, env: { ...lazy.env, ...o.env } });
  const scrubOpts: ScrubOptions = { dropUnprovableEdits: !!opts.dropUnprovableEdits };

  const candidateRef = `${CANDIDATE_REF_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let candidateStarted = false;
  try {
    const oldTip = revParse(git, `${NOTES_REF}^{commit}`);
    report.oldTip = oldTip;
    if (mode === 'push') {
      const remoteTip = remoteNotesTip(remoteGit, remote);
      if (!oldTip && !remoteTip) return done(`no ${NOTES_REF} here or on ${remote}; nothing to scrub`, 0);
      if (!oldTip) return done(`${remote} has ${NOTES_REF} but this clone does not; fetch it first, then run --dry-run`, 1);
      if (!remoteTip) return done(`${remote} has no ${NOTES_REF}, so there is nothing to replace there; run without --push to scrub locally`, 1);
      if (remoteTip !== oldTip) {
        // A plain run already replaced this clone's ref; --push only ever
        // replaces the exact tip a scan read here, so it cannot continue it.
        const source = /Rewritten by origin scrub-notes from ([0-9a-f]{40,64})\./.exec(git(['log', '-1', '--format=%B', oldTip]).stdout);
        const why = source && source[1] === remoteTip
          ? `this clone's ref was already scrubbed locally from ${remote}'s tip, so it no longer matches it. `
          : '';
        return done(`${remote}'s ${NOTES_REF} (${remoteTip.slice(0, 12)}) is not the local one (${oldTip.slice(0, 12)}); `
          + `nothing was changed. ${why}Run the scrub with --push from a fresh clone that fetched ${remote}'s ${NOTES_REF} `
          + '(see "Removing prompt text from older notes" in DOCS.md)', 1);
      }
      report.remote = `${remote} at ${remoteTip.slice(0, 12)} (matches local)`;
    }
    if (!oldTip) return done(`no ${NOTES_REF} in this repository; nothing to scrub`, 0);

    const codeRefs = codeRefsSnapshot(git);
    const s = scan(git, oldTip, scrubOpts);
    Object.assign(report, s.report);
    const historyRewrite = s.tipHasParents && s.report.historyDirty > 0;
    const what = `${plural(s.rewrites.size, 'note')}${historyRewrite ? ' and the ref history (replaced by one commit)' : ''}`;

    if (s.report.blocked.length > 0) {
      let next = '';
      const truncated = s.report.blocked.filter((b) => b.reason === 'edits_json_truncated').length;
      if (truncated > 0) {
        // Never reached with the option: it turns every such note into a drop.
        next = `. ${plural(truncated, 'note')} ${truncated === 1 ? 'holds' : 'hold'} a truncated editsJson with prompt text in its kept bytes, which can only be `
          + 'removed by deleting that whole editsJson: run origin scrub-notes --dry-run --drop-unprovable-edits, check the '
          + '"editsJson dropped" count, and only then rerun this command with --drop-unprovable-edits'
          + (truncated < s.report.blocked.length ? '. The other blocked notes must be resolved first' : '');
      }
      return done(`${plural(s.report.blocked.length, 'note')} cannot be proven clean; nothing was rewritten${mode === 'push' ? ' or pushed' : ''}${next}`, 1);
    }
    if (s.rewrites.size === 0 && !historyRewrite) {
      return done(mode === 'push' ? `already clean, and ${remote} has the same tip; nothing to do` : 'already clean; nothing to do', 0);
    }
    if (mode === 'dry-run') {
      return done(`would rewrite ${what}${s.report.editsJsonDropped ? `, deleting ${plural(s.report.editsJsonDropped, 'whole editsJson value')}` : ''}`, 0);
    }

    candidateStarted = true;
    const candidate = buildCandidate(git, cwd, s, oldTip, candidateRef);
    verifyCandidate(git, s, candidate, scrubOpts);
    if (codeRefsSnapshot(git) !== codeRefs) throw new ScrubAbort('branches, tags or HEAD moved during the scrub');
    if (mode === 'push' && remoteNotesTip(remoteGit, remote) !== oldTip) {
      throw new ScrubAbort(`${remote}'s ${NOTES_REF} moved during the scrub; run --dry-run again`);
    }

    // The one live write, and only if refs/notes/origin is still the scanned tip.
    const cas = git(['update-ref', '-m', 'origin scrub-notes', NOTES_REF, candidate, oldTip]);
    if (cas.status !== 0) {
      throw new ScrubAbort(`${NOTES_REF} changed while the scrub ran (another writer); run --dry-run again`);
    }
    report.newTip = candidate;
    const undo = `Undo locally (restores the prompt text): git update-ref ${NOTES_REF} ${oldTip} ${candidate}`;

    if (mode === 'local') {
      return done(`rewrote ${what} locally. Remotes still serve the old notes, and this clone's ref no longer matches `
        + 'theirs, so --push from here will refuse. To replace a remote\'s ref, run origin scrub-notes --push from a fresh '
        + `clone of it (see "Removing prompt text from older notes" in DOCS.md). ${undo}`, 0);
    }

    // Exactly one ref, leased on the tip the scan read. --no-verify keeps
    // Origin's pre-push hook, which folds remote notes back in, out of it.
    const lease = `--force-with-lease=${NOTES_REF}:${oldTip}`;
    const pushed = remoteGit(
      ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', lease, remote, `${candidate}:${NOTES_REF}`],
      { timeoutMs: 120_000 },
    );
    let remoteNow: string | null = null;
    if (pushed.status === 0) {
      try { remoteNow = remoteNotesTip(remoteGit, remote); } catch { remoteNow = null; }
    }
    if (pushed.status !== 0 || remoteNow !== candidate) {
      const rejected = /stale info|\[rejected\]|fetch first/i.test(pushed.stdout + pushed.stderr);
      report.remote = `${remote}: not confirmed replaced`;
      return done(`local ${NOTES_REF} is scrubbed (${oldTip.slice(0, 12)} → ${candidate.slice(0, 12)}), but ${remote} may still `
        + 'serve the old notes. '
        + (rejected
          ? `${remote}'s ref moved after the scan, so the lease refused the push and nothing there was overwritten. `
            + `Run the scrub again from a fresh clone that fetched the new ${NOTES_REF}. `
          : `Retry the same lease-protected push: git push --no-verify ${lease} ${remote} ${candidate}:${NOTES_REF}. `)
        + undo, 1);
    }
    report.remote = `${remote}: ${NOTES_REF} replaced (${oldTip.slice(0, 12)} → ${candidate.slice(0, 12)})`;
    return done(`rewrote ${what} and replaced ${NOTES_REF} on ${remote}. Clones, forks, mirrors and backups `
      + `that already fetched the old notes still have them. ${undo}`, 0);
  } catch (err) {
    if (err instanceof ScrubAbort) return done(`${err.message}. ${NOTES_REF} was not changed`, 1);
    throw err;
  } finally {
    if (candidateStarted) git(['update-ref', '-d', candidateRef]);
  }
}

export async function scrubNotesCommand(opts: ScrubNotesOptions, deps: ScrubNotesDeps = {}): Promise<void> {
  const { report, exitCode } = runScrubNotes(opts, deps);
  printReport(report, exitCode);
  if (exitCode !== 0) process.exitCode = exitCode;
}
