import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { beforeEach, expect } from 'vitest';

/**
 * Golden turn rows: what a capture-e2e scenario's turns finally say, frozen.
 *
 * Phase 0 of the turn-capture consolidation. The per-turn answer is decided
 * today in ~20 CLI places and 12 separate "which capture wins" rules; the
 * consolidation moves all of that into one resolver. The existing e2e
 * assertions check PROPERTIES (files match the diff, the commit is on its own
 * turn), which a refactor can keep while still changing the answer — a turn's
 * `diffSource` flipping, a file dropping out of its edit evidence, a diff
 * gaining a context line. This freezes the whole answer, so every difference
 * a later phase introduces is seen, and either fixed or re-recorded on purpose.
 *
 * What is frozen is the CLI's OUTPUT as the harness folds it (`foldStopRows`:
 * last write per turn, plus the two server rules it mirrors) — not the row the
 * server stores. The server applies more rules on top (an empty re-send does
 * not evict stored content, a sha is fill-only, attestation re-homes commits),
 * so a golden turn can read emptier or carry more stamps than its stored row.
 * That is deliberate: phase 1 replaces the CLI producers, and this is the
 * surface it changes. Freezing the stored row needs the real ingest.
 *
 * Only fields that describe the turn's CONTENT are kept. Timestamps, ids,
 * tokens and cost vary run to run and say nothing about capture; commit shas
 * vary too, so they are replaced by the commit's subject line.
 *
 * `commits` is every sha ANY payload stamped on the turn, not the one the
 * server ends up keeping. Which stamp survives is decided by several server
 * passes (fill-only `shaMayLand`, producer claims, commit attestation), and
 * re-implementing them here to guess the survivor got it wrong in both
 * directions. The full set is what the CLI actually said, and a stray stamp —
 * an edit hook stamping the pre-commit HEAD — shows up as its own entry.
 *
 * Re-record with ORIGIN_UPDATE_GOLDEN=1. A re-recorded golden is a behaviour
 * change: say why in the commit that carries it.
 */

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'capture-turns');

export type GoldenTurn = {
  promptIndex: number;
  diffSource: string | null;
  chatOnly: boolean;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  uncommittedDiff: string;
  editedFiles: string[];
  contentUnavailableFiles: string[];
  commits: string[];
};

type WireHit = { method: string; url: string; body: unknown };

type GoldenOpts = {
  repo: string;
  /** Extra absolute paths to replace with `<root>` (temp dirs, worktrees). */
  roots?: string[];
  /** Every per-turn row the CLI sent, in any order — the source of `commits`. Defaults to `rows`. */
  sent?: Row[];
  /**
   * Everything the fake API received, and the server session id it handed
   * out. When both are given, recording also saves this session's ingest
   * requests as a payload fixture, which apps/api replays through the real
   * router and database to freeze the rows the SERVER stores.
   */
  requests?: WireHit[];
  sessionId?: string;
};

const PAYLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'capture-payloads');

export function payloadPath(name: string): string {
  return path.join(PAYLOAD_DIR, `${name}.json`);
}

/**
 * This session's ingest requests, in arrival order: PATCH /session/:id and
 * POST /session/end, only those that carry turn or commit data. The
 * transcript is dropped — ingest does not read it for turn content, and it
 * is most of the bytes.
 */
export function ingestRequests(requests: WireHit[], sessionId: string): Array<{ kind: 'patch' | 'end'; body: Record<string, unknown> }> {
  const out: Array<{ kind: 'patch' | 'end'; body: Record<string, unknown> }> = [];
  for (const h of requests) {
    const url = (h.url || '').split('?')[0];
    const body = h.body && typeof h.body === 'object' ? (h.body as Record<string, unknown>) : null;
    if (!body) continue;
    const kind = h.method === 'PATCH' && url === `/api/mcp/session/${sessionId}`
      ? 'patch'
      : h.method === 'POST' && url === '/api/mcp/session/end' && body.sessionId === sessionId ? 'end' : null;
    if (!kind) continue;
    if (!Array.isArray(body.promptChanges) && !Array.isArray(body.commitTurns) && !body.gitCapture) continue;
    const { transcript: _transcript, ...rest } = body;
    out.push({ kind, body: rest });
  }
  return out;
}

function writePayloadFixture(name: string, opts: GoldenOpts): void {
  if (!opts.requests || !opts.sessionId) return;
  const labels = commitLabels(opts.repo);
  const fixture = {
    note: 'Recorded by packages/cli capture-e2e with ORIGIN_UPDATE_GOLDEN=1. Replayed by apps/api capture-golden-stored-rows.test.ts.',
    roots: [opts.repo, ...(opts.roots ?? [])],
    commits: Object.fromEntries(labels),
    requests: ingestRequests(opts.requests, opts.sessionId),
  };
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  fs.writeFileSync(payloadPath(name), JSON.stringify(fixture, null, 1) + '\n');
}

type Row = { promptIndex: number; [k: string]: unknown };

/** Map every commit in `repo` (all refs) from sha to `commit: <subject>`. */
export function commitLabels(repo: string): Map<string, string> {
  const labels = new Map<string, string>();
  let out = '';
  try {
    out = execFileSync('git', ['log', '--all', '--format=%H %s'], { cwd: repo, encoding: 'utf-8' });
  } catch { return labels; }
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) (.*)$/.exec(line.trim());
    if (m) labels.set(m[1], `commit: ${m[2]}`);
  }
  return labels;
}

function labelSha(sha: unknown, labels: Map<string, string>): string | null {
  if (typeof sha !== 'string' || !sha) return null;
  for (const [full, label] of labels) {
    if (full.startsWith(sha) || sha.startsWith(full)) return label;
  }
  return 'commit: <not in repo>';
}

function normalizeText(text: unknown, roots: string[]): string {
  if (typeof text !== 'string') return '';
  let s = text.replace(/\r\n/g, '\n');
  for (const root of roots) {
    if (!root) continue;
    s = s.split(root).join('<root>');
    s = s.split(root.replace(/\\/g, '/')).join('<root>');
  }
  // Blob shas in `index a1b2..c3d4 100644` differ whenever any byte upstream
  // does (a merge's `index a,b..c` too); the hunks below them carry the content.
  return s.replace(/^index [0-9a-f]+(,[0-9a-f]+)*\.\.[0-9a-f]+( [0-7]{6})?$/gm, 'index <blob>');
}

/**
 * Diffs above this size are frozen as their size and hash, not their text: a
 * budget-truncation scenario sends hundreds of KB, and a golden nobody can
 * read in review freezes nothing a reviewer can check.
 */
const MAX_INLINE_DIFF = 16_000;

function frozenDiff(text: string): string {
  if (text.length <= MAX_INLINE_DIFF) return text;
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  return `<${text.length} chars, sha256 ${hash}>`;
}

function normalizePaths(files: unknown, roots: string[]): string[] {
  if (!Array.isArray(files)) return [];
  const out = files
    .map((f) => (typeof f === 'string' ? f : (f as { file?: string; path?: string })?.file ?? (f as { path?: string })?.path))
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .map((f) => normalizeText(f.replace(/\\/g, '/'), roots));
  return [...new Set(out)].sort();
}

function editedFiles(editsJson: unknown, roots: string[]): string[] {
  if (typeof editsJson !== 'string' || !editsJson) return [];
  try {
    const cap = JSON.parse(editsJson) as { edits?: Array<{ file?: string }> };
    return normalizePaths(Array.isArray(cap?.edits) ? cap.edits : [], roots);
  } catch { return []; }
}

/** The content of each turn, with everything run-specific stripped. */
export function toGoldenTurns(rows: Row[], opts: GoldenOpts): GoldenTurn[] {
  const labels = commitLabels(opts.repo);
  const roots = [opts.repo, ...(opts.roots ?? [])].sort((a, b) => b.length - a.length);
  const stamped = new Map<number, Set<string>>();
  for (const r of opts.sent ?? rows) {
    const label = labelSha(r?.commitSha, labels);
    if (!label || typeof r?.promptIndex !== 'number') continue;
    if (!stamped.has(r.promptIndex)) stamped.set(r.promptIndex, new Set());
    stamped.get(r.promptIndex)!.add(label);
  }
  return [...rows]
    .sort((a, b) => a.promptIndex - b.promptIndex)
    .map((r) => ({
      promptIndex: r.promptIndex,
      diffSource: typeof r.diffSource === 'string' && r.diffSource ? r.diffSource : null,
      chatOnly: r.chatOnly === true,
      filesChanged: normalizePaths(r.filesChanged, roots),
      linesAdded: typeof r.linesAdded === 'number' ? r.linesAdded : 0,
      linesRemoved: typeof r.linesRemoved === 'number' ? r.linesRemoved : 0,
      diff: frozenDiff(normalizeText(r.diff, roots)),
      uncommittedDiff: frozenDiff(normalizeText(r.uncommittedDiff, roots)),
      editedFiles: editedFiles(r.editsJson, roots),
      contentUnavailableFiles: normalizePaths(r.contentUnavailableFiles, roots),
      commits: [...(stamped.get(r.promptIndex) ?? [])].sort(),
    }));
}

/**
 * Count failed tests in the calling describe block. Call it at describe level
 * and pass the count as `failedBefore`, so a run whose scenario broke cannot be
 * recorded as the golden.
 */
export function trackTestFailures(): () => number {
  let failed = 0;
  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => { failed++; });
  });
  return () => failed;
}

export function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.json`);
}

/**
 * Compare a scenario's final turn rows with its recorded golden. With
 * ORIGIN_UPDATE_GOLDEN=1 the golden is (re)written instead, and the check passes.
 */
export function expectGoldenTurns(
  name: string,
  rows: Row[],
  opts: GoldenOpts & { failedBefore?: number },
): void {
  const actual = toGoldenTurns(rows, opts);
  const file = goldenPath(name);
  if (process.env.ORIGIN_UPDATE_GOLDEN === '1') {
    // A scenario whose own assertions failed captured something broken; freezing
    // it would make the broken answer the baseline every later phase must match.
    if (opts.failedBefore) {
      throw new Error(`refusing to record the golden for "${name}": ${opts.failedBefore} earlier test(s) in this scenario failed`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    writePayloadFixture(name, opts);
    return;
  }
  expect(fs.existsSync(file), `no golden for "${name}" — record it with ORIGIN_UPDATE_GOLDEN=1 and commit ${path.relative(process.cwd(), file)}`).toBe(true);
  const expected = JSON.parse(fs.readFileSync(file, 'utf-8')) as GoldenTurn[];
  expect(
    actual,
    `turn rows for "${name}" differ from the recorded golden. If the change is intended, re-record with ORIGIN_UPDATE_GOLDEN=1 and say why in the commit.`,
  ).toEqual(expected);
}
