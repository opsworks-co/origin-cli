/**
 * The note a rewritten commit gets (OR-11/A5). Pure: notes in, one note out.
 *
 * A history rewrite — amend, rebase, a rebase squash/fixup, cherry-pick, a
 * forge squash merge — makes a NEW commit out of one or more old ones. The
 * old commits' notes stay where they are; the new commit needs a note of its
 * own. The rule is conservative:
 *
 *   every rebuilt canonical record names the NEW commit and carries only the
 *   identity of contributions the old notes proved. It is COMMIT-level unless
 *   the caller hands in line claims PROVEN on the new commit
 *   (`lineProjection`, rewrite-line-projection.ts, OR-46): then a contribution
 *   whose projected lines no other claimant touches carries them as `files`,
 *   in the new commit's coordinates and without `iteration_index` (the old
 *   commit's prompts are not proven to be this commit's). A line two claimants
 *   reach — two sessions of a squash, a session the sources disagree about, a
 *   line the target's own record already claims — is carried by none. With no
 *   proven line the note is exactly what OR-11 always wrote.
 *
 * What travels into a rebuilt contribution: `evidence`, `agent`, `model`,
 * `actor`, `session.id` and `session.reference_uri`/`started_at` when every
 * merged copy agrees, and the projected `files` above. What never does: the
 * old `files` and ranges themselves, `iterations`
 * (the old commit's turns are not proven to be this commit's), `prompt_count`,
 * `usage`, `duration_ms`, `session.diff_stats` (session-cumulative up to the
 * OLD record's `recorded_at`, and summing them across squashed commits double
 * counts) and `revision.diff_stats` (the old revision's totals). A record that
 * names the old commit is never copied.
 *
 * Sources of a claim, in order: the source note's own v1 record (read through
 * `readRecord`, and only when it names that source commit), else the legacy
 * session note when it names an observed session AND an explicit agent — the
 * same rules as the OR-9 writer (`buildAttributionRecordForCommit`), so a
 * `detected-*`/`unknown` session, a model without an agent, or a lossy squash
 * aggregate gives no claim.
 *
 * One old commit or several is decided by the MAPPING, not by how many old
 * commits carry a note: a squash of one attributed and three human commits is
 * a squash of four. Several old commits → one new commit: contributions are
 * grouped by session (S2). A session's hard identity is its `evidence`, its
 * `session.id` and a compatible `agent.id`: copies that disagree on it get no
 * canonical contribution — nothing is picked by input order — and a
 * `conflicting-session-identity` warning. Anything else is a detail: a `/model`
 * switch inside one session is normal, so copies naming two models give ONE
 * contribution with no `model` (never the first, last or smallest one) and a
 * `session-detail-dropped` warning. The same holds when the target already
 * carries the session, and when the session writer later writes the commit's
 * own snapshot. The result never depends on the order of the old→new pairs.
 *
 * The legacy `origin` payload: one old commit → its payload carried unchanged.
 * Several → one squash aggregate listing every session and model and summing
 * nothing. It names a single `sessionId`/`agent`/`model` only when exactly one
 * session is involved; a multi-session squash names none, because naming one
 * would hand the whole commit to it (readers that need a single session get
 * none; see `isAiNote` in attribution.ts).
 *
 * Every note a rewrite writes carries REWRITE_NOTE_KEY: a namespaced,
 * versioned record of the old commits it was built from, the commit it belongs
 * to, and whether a note written for the commit itself (`base: "note"`) sits
 * under the carried contributions. A target note:
 *  - with a valid marker and `base: "none"` is a rewrite's own note: rebuilt
 *    from the union of its old commits and the new ones, so the order the hooks
 *    ran in and a repeat of the same pairs change nothing;
 *  - with `base: "note"`, or with no valid marker at all (post-commit's own
 *    note, a teammate's, CI's, an envelope that only looks similar): its legacy
 *    payload is never replaced; its record keeps its contributions and gains
 *    only missing sessions; a record that cannot be merged safely is left
 *    exactly as it is.
 * A session writer that later writes the commit's own note keeps what the
 * rewrite carried (`mergeSessionNoteOverRewrite`), so neither writer's order
 * loses the other's contributions.
 */

import {
  readRecord,
  validateFull,
  ATTRIBUTION_RECORD_SCHEMA_VERSION,
} from './attribution-record.js';
import {
  ATTRIBUTION_RECORD_NOTE_KEY,
  ATTRIBUTION_RECORD_PRODUCER,
  buildAttributionRecordForCommit,
  publishableLineFiles,
} from './attribution-note.js';
import { MAX_FILE_LINES, isCanonicalRepoPath } from './attribution-line-ranges.js';
import { MAX_REWRITE_CLAIM_LINES, type ProjectedRewriteLine } from './rewrite-line-projection.js';

/**
 * Envelope key, next to `origin` and `attribution_record`, of the rewrite
 * bookkeeping. Transport bookkeeping of the note: not part of the v1 contract
 * and not read by legacy readers.
 */
export const REWRITE_NOTE_KEY = 'origin_rewrite';
export const REWRITE_NOTE_SCHEMA = 'origin-rewrite/1';

export interface RewriteMarker {
  schema: typeof REWRITE_NOTE_SCHEMA;
  /** The commit the note is attached to. A marker copied onto another commit is not ours. */
  target: string;
  /** Every old commit the note was built from, sorted, full lowercase shas. */
  sources: string[];
  /** `note`: the commit's own note sits under the carried contributions. */
  base: 'none' | 'note';
}

export type RewriteWarningCode =
  /** A source note is not JSON: it is carried byte for byte on a 1→1 only. */
  | 'source-note-not-json'
  /** A source record failed the full validation path. */
  | 'source-record-invalid'
  /** A source record has a major version this reader does not interpret. */
  | 'source-record-unsupported'
  /** A source record names a revision other than the commit it is attached to. */
  | 'source-record-wrong-revision'
  /** A legacy source note proves no session + agent (unobserved, guessed, aggregate, foreign shape). */
  | 'source-legacy-no-claim'
  /** Copies of one session disagree on its hard identity (evidence or agent): no canonical contribution. */
  | 'conflicting-session-identity'
  /** Copies of one session agree on its identity but not on an optional detail (a model): that detail is left out. */
  | 'session-detail-dropped'
  /** The existing target note is not JSON; it is left alone. */
  | 'target-note-not-json'
  /** The existing target record is invalid, newer, or names another revision; it is left alone. */
  | 'target-record-unusable'
  /** A source claims a session the target record already has, with another identity. */
  | 'target-session-differs'
  /** No valid record could be built from what the sources prove. */
  | 'record-not-built'
  /**
   * Proven lines were not carried: a contribution's lines could not be published
   * whole (schema or note-size limits), or the line projection handed in was
   * malformed or beyond its bounds and was ignored as a whole.
   */
  | 'rewrite-lines-not-carried'
  /** The target record states more line ranges or lines than a rewrite checks against; the target is left unchanged. */
  | 'target-lines-unbounded'
  /** A rebuild from the sources in hand would drop what the target already carries (a source note is gone). */
  | 'target-rebuild-lossy'
  /** The note-write lock could not be held through the write, after every attempt: nothing written. */
  | 'note-lock-unavailable';

export interface RewriteWarning {
  code: RewriteWarningCode;
  /** The commit the warning is about (a source, or the target). */
  sha?: string;
  sessionId?: string;
  detail: string;
}

export interface RewriteSourceNote {
  /** Full lowercase sha of the old commit. */
  sha: string;
  /** Its note on refs/notes/origin, exactly as stored. */
  note: string;
}

export interface RebuildRewriteInput {
  /** Full lowercase sha of the new commit. */
  targetSha: string;
  /**
   * EVERY old commit of the mapping or range, noted or not. Decides 1→1
   * against N→1 and the squash count. Old commits listed only in `sources`
   * are added.
   */
  sourceCommits?: ReadonlyArray<string>;
  /** The notes of those old commits that have one. */
  sources: ReadonlyArray<RewriteSourceNote>;
  /** The target's note as it exists now, or null. */
  existingTarget?: string | null;
  /**
   * Target lines proven to carry a source contribution's claim, computed by
   * the caller from THESE `sources` (projectRewriteLineClaims). Absent or
   * empty: every rebuilt contribution is commit-level, as before OR-46.
   */
  lineProjection?: ReadonlyArray<ProjectedRewriteLine>;
  recordedAt: Date;
  producerVersion: string;
}

export interface RebuildRewriteResult {
  /**
   * The note to store on the target, or null when the target must not be
   * written — nothing to carry, nothing new, or an existing note that is not
   * ours to change.
   */
  payload: string | null;
  /** The canonical record inside `payload`, when there is one. */
  record?: Record<string, any>;
  /**
   * Old commits a rewrite note already recorded that the input lacks. The
   * caller must add them (with their notes) and call again; see
   * `rebuildRewrittenNote`.
   */
  recordedSources?: string[];
  warnings: RewriteWarning[];
}

const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

type Opts = { recordedAt: Date; producerVersion: string; lineProjection?: ReadonlyArray<ProjectedRewriteLine> };

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseNote(note: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(note);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A stable JSON rendering: object keys sorted, so equal objects compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The rewrite marker of a note, or null. Only the exact shape counts: the
 * namespaced key, the versioned schema, the commit the note is attached to,
 * sorted unique full shas, and nothing else. A look-alike is somebody else's
 * note and goes down the protected path.
 */
export function readRewriteMarker(note: Record<string, any> | null, targetSha: string): RewriteMarker | null {
  const m = note?.[REWRITE_NOTE_KEY];
  if (!isPlainObject(m)) return null;
  const keys = Object.keys(m).sort().join(',');
  if (keys !== 'base,schema,sources,target') return null;
  if (m.schema !== REWRITE_NOTE_SCHEMA || m.target !== targetSha) return null;
  if (m.base !== 'none' && m.base !== 'note') return null;
  const sources = m.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (typeof s !== 'string' || !FULL_SHA.test(s) || s === targetSha) return null;
    if (i > 0 && !(sources[i - 1] < s)) return null;
  }
  return { schema: REWRITE_NOTE_SCHEMA, target: targetSha, sources: [...sources], base: m.base };
}

function marker(targetSha: string, sources: Iterable<string>, base: 'none' | 'note'): RewriteMarker {
  return { schema: REWRITE_NOTE_SCHEMA, target: targetSha, sources: [...new Set(sources)].sort(), base };
}

// ─── Contributions ──────────────────────────────────────────────────────────

interface Claim {
  sha: string;
  contribution: Record<string, any>;
  /** Index of the contribution in the source's own v1 record; absent for a legacy claim. */
  index?: number;
}

/**
 * The commit-level identity of one contribution: what a rewrite may carry.
 * Everything revision-scoped or session-cumulative is left behind.
 */
function commitLevelIdentity(c: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { evidence: c.evidence };
  if (isPlainObject(c.agent)) out.agent = { ...c.agent };
  if (isPlainObject(c.model)) out.model = { ...c.model };
  if (isPlainObject(c.actor)) out.actor = { ...c.actor };
  if (isPlainObject(c.session) && typeof c.session.id === 'string') {
    const session: Record<string, any> = { id: c.session.id };
    if (typeof c.session.reference_uri === 'string') session.reference_uri = c.session.reference_uri;
    if (typeof c.session.started_at === 'string') session.started_at = c.session.started_at;
    out.session = session;
  }
  return out;
}

/**
 * The claims one note proves about the commit it is attached to. The v1
 * record wins when the note has one; a record that cannot be read gives no
 * claim at all (the legacy payload of such a note is not re-interpreted).
 */
function claimsFromNote(sha: string, obj: Record<string, any>, warnings: RewriteWarning[], opts: Opts): Claim[] {
  if (ATTRIBUTION_RECORD_NOTE_KEY in obj) {
    const read = readRecord(obj[ATTRIBUTION_RECORD_NOTE_KEY]);
    if (read.status === 'unsupported') {
      warnings.push({ code: 'source-record-unsupported', sha, detail: `schema_version ${read.version} is not interpreted` });
      return [];
    }
    if (read.status === 'invalid') {
      warnings.push({ code: 'source-record-invalid', sha, detail: `record is invalid (${read.reason})` });
      return [];
    }
    const revision = read.record.revision;
    if (revision?.vcs !== 'git' || revision?.id !== sha) {
      warnings.push({ code: 'source-record-wrong-revision', sha, detail: `record names ${revision?.vcs}:${revision?.id}` });
      return [];
    }
    return (read.record.contributions as Record<string, any>[]).map((c, index) => ({ sha, contribution: commitLevelIdentity(c), index }));
  }
  return claimsFromLegacy(sha, obj, warnings, opts);
}

/**
 * A legacy session note gives one minimal claim when it names an observed
 * session and an explicit agent — decided by the OR-9 writer's own builder,
 * so the two can never disagree about what counts as observed.
 */
function claimsFromLegacy(sha: string, obj: Record<string, any>, warnings: RewriteWarning[], opts: Opts): Claim[] {
  const origin = obj.origin;
  if (!isPlainObject(origin)) {
    warnings.push({ code: 'source-legacy-no-claim', sha, detail: 'note has no legacy origin payload' });
    return [];
  }
  if (origin.squashMerge === true || origin.source !== undefined) {
    warnings.push({ code: 'source-legacy-no-claim', sha, detail: 'aggregate or imported legacy note carries no session pairing' });
    return [];
  }
  const sessionId = typeof origin.sessionId === 'string' ? origin.sessionId : '';
  // A `local-*` id was never registered, so its originUrl points at nothing.
  const reference = typeof origin.originUrl === 'string' && !sessionId.startsWith('local-') ? origin.originUrl : undefined;
  const built = buildAttributionRecordForCommit(sha, {
    sessionId,
    agentId: typeof origin.agent === 'string' ? origin.agent : undefined,
    modelId: typeof origin.model === 'string' ? origin.model : undefined,
    sessionReferenceUri: reference,
  }, opts);
  if (!built.record) {
    warnings.push({ code: 'source-legacy-no-claim', sha, sessionId: sessionId || undefined, detail: built.reason });
    return [];
  }
  return [{ sha, contribution: commitLevelIdentity(built.record.contributions[0]) }];
}

function claimKey(c: Record<string, any>): string {
  if (isPlainObject(c.session) && typeof c.session.id === 'string') return `session:${c.session.id}`;
  return `structural:${stable({ evidence: c.evidence, agent: c.agent, model: c.model, actor: c.actor })}`;
}

/**
 * The hard identity of one session's copies: the same evidence and no two
 * different agents. (`session.id` is the group key.) A model is not part of
 * it: see `modelsOf`.
 */
function hardIdentityAgrees(cs: ReadonlyArray<Record<string, any>>): boolean {
  if (new Set(cs.map((c) => c.evidence)).size > 1) return false;
  return new Set(cs.map((c) => c.agent?.id).filter((id) => id !== undefined)).size <= 1;
}

/** The distinct model ids the copies state. More than one: the model is left out. */
function modelsOf(cs: ReadonlyArray<Record<string, any>>): string[] {
  return [...new Set(cs.map((c) => c.model?.id).filter((id): id is string => typeof id === 'string'))].sort();
}

function withoutModel(c: Record<string, any>): Record<string, any> {
  const { model: _dropped, ...rest } = c;
  return rest;
}

/** A contribution the schema accepts without its model: one that still names an agent. */
const standsWithoutModel = (c: Record<string, any>) => isPlainObject(c.agent) && typeof c.agent.id === 'string';

function modelDropped(sessionId: string | undefined, models: string[], sha?: string): RewriteWarning {
  return {
    code: 'session-detail-dropped', sessionId, ...(sha ? { sha } : {}),
    detail: `copies of this session name different models (${models.join(', ')}); the model is left out`,
  };
}

/**
 * Merge an object-valued detail (agent, model, actor, session fields) across
 * copies that agree on identity: a value every copy that has it agrees on is
 * kept; a value the copies disagree on is dropped — never picked.
 */
function mergeDetail(values: Array<Record<string, any> | undefined>): Record<string, any> | undefined {
  const present = values.filter((v): v is Record<string, any> => isPlainObject(v));
  if (present.length === 0) return undefined;
  const out: Record<string, any> = {};
  const keys = new Set(present.flatMap((v) => Object.keys(v)));
  for (const key of [...keys].sort()) {
    const seen = new Set(present.filter((v) => v[key] !== undefined).map((v) => stable(v[key])));
    if (seen.size === 1) out[key] = JSON.parse([...seen][0]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Group claims by session (or by structural identity for session-less
 * contributions) and merge each group. Deterministic and independent of the
 * order of `claims`.
 */
interface MergedClaims {
  merged: Map<string, Record<string, any>>;
  /** Every model id the copies of a merged group stated (a dropped model included). */
  models: Map<string, string[]>;
  /** Groups whose copies disagree on hard identity: deliberately no contribution. */
  conflicts: Set<string>;
}

function mergeClaims(claims: Claim[], warnings: RewriteWarning[]): MergedClaims {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = claimKey(claim.contribution);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(claim);
  }
  const out: MergedClaims = { merged: new Map(), models: new Map(), conflicts: new Set() };
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const cs = group.map((g) => g.contribution);
    const from = [...new Set(group.map((g) => g.sha.slice(0, 12)))].sort().join(', ');
    const models = modelsOf(cs);
    const agent = mergeDetail(cs.map((c) => c.agent));
    // Two models and no agent: nothing the schema accepts is left to claim.
    if (!hardIdentityAgrees(cs) || (models.length > 1 && !agent?.id)) {
      out.conflicts.add(key);
      warnings.push({
        code: 'conflicting-session-identity',
        sessionId: cs[0].session?.id,
        detail: `copies from ${from} disagree on evidence/agent; no canonical contribution for this session`,
      });
      continue;
    }
    const c: Record<string, any> = { evidence: cs[0].evidence };
    const model = models.length > 1 ? undefined : mergeDetail(cs.map((x) => x.model));
    const actor = mergeDetail(cs.map((x) => x.actor));
    if (agent?.id) c.agent = agent;
    if (model?.id) c.model = model;
    if (actor) c.actor = actor;
    if (cs[0].session) c.session = { ...mergeDetail(cs.map((x) => x.session)), id: cs[0].session.id };
    if (models.length > 1) warnings.push(modelDropped(cs[0].session?.id, models));
    out.merged.set(key, c);
    out.models.set(key, models);
  }
  return out;
}

// ─── Carried line claims ────────────────────────────────────────────────────

/** A claimant of a target line that no rebuilt contribution can be: the target's own record. */
const TARGET_OWNER = 'target:';
/** Line ranges of the target's own record a rewrite checks projected lines against. */
const MAX_TARGET_OWNER_RANGES = 100_000;
/**
 * Lines the target's own record may state, measured arithmetically: the most a
 * record of OR-45-bounded files can hold (1000 files × MAX_FILE_LINES + 1).
 * A record claiming more cannot describe real files; it is not reasoned about.
 */
const MAX_TARGET_OWNER_LINES = 1000 * (MAX_FILE_LINES + 1);

/**
 * The line projection as handed in, or undefined when it cannot be trusted
 * WHOLE: more entries than one projection may produce, a source that is not
 * an old commit of this rewrite, a non-integer index, a non-canonical path, a
 * line outside the OR-45 file bounds. A rejected projection carries no line
 * at all — the note is OR-11's commit-level one — and says so in a warning.
 * The builder never trusts the caller's bounds.
 */
function acceptedProjection(
  projection: ReadonlyArray<ProjectedRewriteLine> | undefined,
  commits: ReadonlySet<string>,
  targetSha: string,
  warnings: RewriteWarning[],
): ReadonlyArray<ProjectedRewriteLine> | undefined {
  if (projection === undefined || projection === null) return undefined;
  const reject = (why: string) => {
    warnings.push({ code: 'rewrite-lines-not-carried', sha: targetSha, detail: `line projection ignored: ${why}` });
    return undefined;
  };
  if (!Array.isArray(projection)) return reject('not a list');
  if (projection.length > MAX_REWRITE_CLAIM_LINES) return reject('too many lines');
  for (const p of projection) {
    if (!isPlainObject(p)) return reject('malformed entry');
    if (typeof p.sourceSha !== 'string' || !commits.has(p.sourceSha)) return reject('a source that is not an old commit of this rewrite');
    if (!Number.isSafeInteger(p.contributionIndex) || p.contributionIndex < 0) return reject('malformed contribution index');
    if (typeof p.path !== 'string' || !isCanonicalRepoPath(p.path)) return reject('unsafe path');
    if (!Number.isSafeInteger(p.line) || p.line < 1 || p.line > MAX_FILE_LINES + 1) return reject('line outside the file bounds');
  }
  return projection;
}

/**
 * The target's own claimed lines as sorted, merged intervals per path; null
 * past MAX_TARGET_OWNER_RANGES ranges or MAX_TARGET_OWNER_LINES stated lines,
 * both counted before anything is sorted.
 */
function targetIntervals(targetFiles: ReadonlyArray<Record<string, any>>): Map<string, Array<[number, number]>> | null {
  let count = 0;
  let stated = 0;
  const byPath = new Map<string, Array<[number, number]>>();
  for (const f of targetFiles) {
    const ranges = Array.isArray(f?.ranges) ? f.ranges : [];
    count += ranges.length;
    if (count > MAX_TARGET_OWNER_RANGES) return null;
    const list = byPath.get(f.path) ?? [];
    for (const r of ranges) {
      stated += r.end_line - r.start_line + 1;
      if (stated > MAX_TARGET_OWNER_LINES) return null;
      list.push([r.start_line, r.end_line]);
    }
    byPath.set(f.path, list);
  }
  for (const [p, list] of byPath) {
    list.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of list) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    byPath.set(p, merged);
  }
  return byPath;
}

/** Does a sorted, merged interval list hold `line`? Binary search: never walks a range. */
function holds(intervals: ReadonlyArray<[number, number]> | undefined, line: number): boolean {
  if (!intervals) return false;
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line < intervals[mid][0]) hi = mid - 1;
    else if (line > intervals[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * The `files` each claim group may carry: of the projected target lines, the
 * ones exactly ONE claimant reaches. A claimant is a claim group (by
 * `claimKey`, whether or not it ends up with a contribution), a projected line
 * whose source contribution no claim here names, or the target's own record
 * (`targetFiles`). Only groups in `carriers` get files; the rest still block.
 * A group whose lines cannot be published whole stays commit-level.
 *
 * The target's ranges are never walked line by line (a valid record may claim
 * up to line 2^53 − 1): projected lines are looked up in them. Null when the
 * target states more ranges or lines than are checked — the caller then
 * leaves the target exactly as it is.
 */
function carriedLineFiles(
  claims: ReadonlyArray<Claim>,
  carriers: ReadonlySet<string>,
  projection: ReadonlyArray<ProjectedRewriteLine> | undefined,
  targetFiles: ReadonlyArray<Record<string, any>>,
  targetSha: string,
  warnings: RewriteWarning[],
): Map<string, Record<string, any>[]> | null {
  const out = new Map<string, Record<string, any>[]>();
  if (!projection || projection.length === 0) return out;
  const ownedByTarget = targetIntervals(targetFiles);
  if (!ownedByTarget) return null;
  const groupOf = new Map<string, string>();
  for (const c of claims) if (c.index !== undefined) groupOf.set(`${c.sha}:${c.index}`, claimKey(c.contribution));

  const owners = new Map<string, Set<string>>();
  const own = (path: string, line: number, owner: string) => {
    const k = `${path}\u0000${line}`;
    if (!owners.has(k)) owners.set(k, new Set());
    owners.get(k)!.add(owner);
  };
  for (const p of projection) {
    if (holds(ownedByTarget.get(p.path), p.line)) own(p.path, p.line, TARGET_OWNER);
    own(p.path, p.line, groupOf.get(`${p.sourceSha}:${p.contributionIndex}`) ?? `unclaimed:${p.sourceSha}:${p.contributionIndex}`);
  }

  const linesByGroup = new Map<string, Map<string, number[]>>();
  for (const [k, set] of owners) {
    if (set.size !== 1) continue;
    const [group] = set;
    if (!carriers.has(group)) continue;
    const sep = k.lastIndexOf('\u0000');
    const path = k.slice(0, sep);
    const line = Number(k.slice(sep + 1));
    if (!linesByGroup.has(group)) linesByGroup.set(group, new Map());
    const byPath = linesByGroup.get(group)!;
    byPath.set(path, [...(byPath.get(path) ?? []), line]);
  }

  for (const [group, byPath] of [...linesByGroup].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const files = [...byPath].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, lines]) => {
      const ranges: Array<{ start_line: number; end_line: number }> = [];
      for (const l of [...lines].sort((a, b) => a - b)) {
        const last = ranges[ranges.length - 1];
        if (last && last.end_line === l - 1) last.end_line = l;
        else ranges.push({ start_line: l, end_line: l });
      }
      return { path, ranges };
    });
    // No iteration is carried: `undefined` strips any.
    const published = publishableLineFiles(files, undefined);
    if (published && published.length > 0) {
      out.set(group, published as Record<string, any>[]);
    } else {
      warnings.push({ code: 'rewrite-lines-not-carried', sha: targetSha, detail: 'proven lines exceed the record or note limits; the contribution stays commit-level' });
    }
  }
  return out;
}

/** `line` when any contribution carries `files`, else `commit`. */
function levelOf(contributions: ReadonlyArray<Record<string, any>>): 'line' | 'commit' {
  return contributions.some((c) => Array.isArray(c.files)) ? 'line' : 'commit';
}

function newRecord(targetSha: string, contributions: Record<string, any>[], opts: Opts) {
  return {
    schema_version: ATTRIBUTION_RECORD_SCHEMA_VERSION,
    revision: { vcs: 'git', id: targetSha },
    attribution_level: levelOf(contributions),
    recorded_at: opts.recordedAt.toISOString(),
    producer: { name: ATTRIBUTION_RECORD_PRODUCER, version: opts.producerVersion },
    contributions,
  };
}

function validated(record: Record<string, any>, targetSha: string, warnings: RewriteWarning[]): Record<string, any> | undefined {
  const result = validateFull(record);
  if (result.ok) return record;
  const first = result.schemaErrors[0]
    ? `${result.schemaErrors[0].instancePath || '/'} ${result.schemaErrors[0].message}`
    : `${result.semanticErrors[0]?.rule} ${result.semanticErrors[0]?.message}`;
  warnings.push({ code: 'record-not-built', sha: targetSha, detail: `record failed validation: ${first}` });
  return undefined;
}

/** The target's exact 1.0 record, or null when it has none; `false` when it has one that must not be touched. */
function targetRecord(existing: Record<string, any>, targetSha: string): Record<string, any> | null | false {
  if (!(ATTRIBUTION_RECORD_NOTE_KEY in existing)) return null;
  const read = readRecord(existing[ATTRIBUTION_RECORD_NOTE_KEY]);
  // Only an exact 1.0 record naming this commit is extended. A projected
  // newer minor would lose its newer fields if rewritten by this writer.
  if (read.status !== 'exact' || read.record.revision?.vcs !== 'git' || read.record.revision?.id !== targetSha) return false;
  return read.record;
}

// ─── Legacy payload ─────────────────────────────────────────────────────────

/**
 * The squash aggregate for several old commits. `commitsSquashed` counts old
 * commits — noted or not, an earlier aggregate counting as its own total —
 * and nothing else is summed. Singular identity only for exactly one session.
 */
function legacySquashAggregate(
  commits: string[],
  origins: Map<string, Record<string, any>>,
  recordedAt: Date,
): Record<string, any> {
  const sessions = new Set<string>();
  const models = new Set<string>();
  const agents = new Set<string>();
  const sessionModels = new Set<string>();
  const add = (id: unknown) => { if (typeof id === 'string' && id.trim() && id !== 'unknown') sessions.add(id); };
  let count = 0;
  for (const sha of commits) {
    const origin = origins.get(sha);
    if (origin?.squashMerge === true) {
      count += typeof origin.commitsSquashed === 'number' && origin.commitsSquashed > 0 ? origin.commitsSquashed : 1;
      for (const id of Array.isArray(origin.sessionIds) ? origin.sessionIds : []) add(id);
    } else {
      count += 1;
    }
    if (!origin) continue;
    add(origin.sessionId);
    if (typeof origin.agent === 'string' && origin.agent) agents.add(origin.agent);
    if (typeof origin.model === 'string' && origin.model && origin.model !== 'unknown') sessionModels.add(origin.model);
    for (const m of [origin.model, ...(Array.isArray(origin.models) ? origin.models : [])]) {
      if (typeof m === 'string' && m && m !== 'unknown') models.add(m);
    }
  }
  const sorted = [...sessions].sort();
  const single = sorted.length === 1;
  return JSON.parse(JSON.stringify({
    version: 1,
    squashMerge: true,
    commitsSquashed: count,
    // A single-session squash is that session's, as a legacy reader expects.
    // Several sessions: no single owner is named, the list is the claim.
    sessionId: single ? sorted[0] : undefined,
    agent: single && agents.size === 1 ? [...agents][0] : undefined,
    model: single && sessionModels.size === 1 ? [...sessionModels][0] : undefined,
    sessionIds: sorted,
    models: [...models].sort(),
    timestamp: recordedAt.toISOString(),
  }));
}

/**
 * Everything but the canonical record and the rewrite bookkeeping, from one
 * source note: the payload a 1→1 rewrite carries unchanged.
 */
function carriedKeys(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== ATTRIBUTION_RECORD_NOTE_KEY && k !== REWRITE_NOTE_KEY) out[k] = v;
  }
  return out;
}

// ─── The builder ────────────────────────────────────────────────────────────

/**
 * Build the note for `targetSha` from its old commits' notes. See the module
 * comment for the rules. Never throws.
 *
 * When the existing target note is a rewrite's own note that lists old commits
 * the input lacks, the result carries `recordedSources` and no payload: the
 * caller adds them (and their notes) and calls again, so the note is always a
 * function of the union of its old commits.
 */
export function rebuildRewrittenNote(input: RebuildRewriteInput): RebuildRewriteResult {
  const warnings: RewriteWarning[] = [];
  const targetSha = (input.targetSha || '').toLowerCase();
  if (!FULL_SHA.test(targetSha)) {
    return { payload: null, warnings: [{ code: 'record-not-built', detail: 'target is not a full git sha' }] };
  }
  const opts: Opts = { recordedAt: input.recordedAt, producerVersion: input.producerVersion };

  // One old commit counts once, and never the target itself.
  const notes = new Map<string, string>();
  for (const s of input.sources) {
    const sha = (s?.sha || '').toLowerCase();
    if (!FULL_SHA.test(sha) || sha === targetSha || typeof s.note !== 'string' || !s.note.trim()) continue;
    if (!notes.has(sha)) notes.set(sha, s.note);
  }
  const commits = new Set<string>(notes.keys());
  for (const raw of input.sourceCommits ?? []) {
    const sha = (raw || '').toLowerCase();
    if (FULL_SHA.test(sha) && sha !== targetSha) commits.add(sha);
  }
  opts.lineProjection = acceptedProjection(input.lineProjection, new Set(notes.keys()), targetSha, warnings);

  if (typeof input.existingTarget === 'string' && input.existingTarget.trim()) {
    const existing = parseNote(input.existingTarget);
    if (!existing) {
      return { payload: null, warnings: [{ code: 'target-note-not-json', sha: targetSha, detail: 'existing target note is not JSON; left unchanged' }] };
    }
    const mark = readRewriteMarker(existing, targetSha);
    if (mark?.base === 'none') {
      // A record we cannot read as exact 1.0 for this commit (a newer major,
      // invalid, another revision) is never rebuilt over — the marker being ours
      // does not make the record ours to downgrade.
      if (targetRecord(existing, targetSha) === false) {
        warnings.push({ code: 'target-record-unusable', sha: targetSha, detail: 'existing target record is not an exact 1.0 record for this commit; left unchanged' });
        return { payload: null, warnings };
      }
      const missing = mark.sources.filter((x) => !commits.has(x));
      if (missing.length > 0) return { payload: null, recordedSources: missing, warnings };
      // Our own note, and every old commit it was built from is in hand:
      // rebuild from the union as if there were no target note.
      const conflicts = new Set<string>();
      const rebuilt = rebuildFromSources(targetSha, [...commits].sort(), notes, warnings, opts, conflicts);
      if (rebuilt.payload && sameNoteModuloTime(rebuilt.payload, input.existingTarget)) {
        return { payload: null, record: existing[ATTRIBUTION_RECORD_NOTE_KEY], warnings };
      }
      // A session the sources in hand disagree about is deliberately dropped
      // (its warning says so); that is not a lost source note.
      if (losesWhatTargetCarries(existing, rebuilt.payload, conflicts)) {
        // A recorded old commit's note (or the commit) is gone: the notes in
        // hand no longer prove everything the target already carries. Keep the
        // target as it is and only add what the sources in hand prove.
        warnings.push({ code: 'target-rebuild-lossy', sha: targetSha, detail: 'a rebuild from the notes still readable would drop carried attribution; extending the target instead' });
        return mergeIntoTargetNote(targetSha, existing, mark, [...commits].sort(), notes, warnings, opts, 'none');
      }
      return rebuilt;
    }
    return mergeIntoTargetNote(targetSha, existing, mark, [...commits].sort(), notes, warnings, opts);
  }
  if (notes.size === 0) return { payload: null, warnings };
  return rebuildFromSources(targetSha, [...commits].sort(), notes, warnings, opts);
}

/** No target note (or our own one, superseded): build the whole note from the old commits. */
function rebuildFromSources(
  targetSha: string,
  commits: string[],
  notes: Map<string, string>,
  warnings: RewriteWarning[],
  opts: Opts,
  conflicts: Set<string> = new Set(),
): RebuildRewriteResult {
  if (notes.size === 0) return { payload: null, warnings };

  const parsed = new Map<string, Record<string, any>>();
  for (const sha of commits) {
    const raw = notes.get(sha);
    if (raw === undefined) continue;
    const obj = parseNote(raw);
    if (obj) parsed.set(sha, obj);
    else warnings.push({ code: 'source-note-not-json', sha, detail: 'source note is not JSON' });
  }

  // A 1→1 whose note is not JSON is copied byte for byte, as rewrites always did.
  if (parsed.size === 0) {
    return commits.length === 1 ? { payload: notes.get(commits[0])!, warnings } : { payload: null, warnings };
  }

  const claims = [...parsed].flatMap(([sha, obj]) => claimsFromNote(sha, obj, warnings, opts));
  const { merged, conflicts: conflicted } = mergeClaims(claims, warnings);
  for (const key of conflicted) conflicts.add(key);
  // No target record here: the ownership check cannot be unbounded.
  const files = carriedLineFiles(claims, new Set(merged.keys()), opts.lineProjection, [], targetSha, warnings) ?? new Map();
  let record: Record<string, any> | undefined;
  if (merged.size > 0) {
    const contributions = [...merged].map(([key, c]) => (files.has(key) ? { ...c, files: files.get(key) } : c));
    record = validated(newRecord(targetSha, contributions, opts), targetSha, warnings);
  } else {
    warnings.push({ code: 'record-not-built', sha: targetSha, detail: 'no source proves a contribution' });
  }

  let legacy: Record<string, any> = {};
  if (commits.length === 1) {
    legacy = carriedKeys(parsed.get(commits[0])!);
  } else {
    const origins = new Map<string, Record<string, any>>();
    for (const [sha, obj] of parsed) if (isPlainObject(obj.origin)) origins.set(sha, obj.origin);
    if (origins.size > 0) legacy = { origin: legacySquashAggregate(commits, origins, opts.recordedAt) };
  }

  if (Object.keys(legacy).length === 0 && !record) return { payload: null, warnings };
  const envelope: Record<string, any> = { ...legacy };
  if (record) envelope[ATTRIBUTION_RECORD_NOTE_KEY] = record;
  envelope[REWRITE_NOTE_KEY] = marker(targetSha, commits, 'none');
  return { payload: JSON.stringify(envelope, null, 2), record, warnings };
}

/**
 * The target already has a note that is not a pure rewrite note. Its legacy
 * payload is authoritative and never replaced; its record keeps every
 * contribution and gains only sessions it does not have. Anything unsafe
 * leaves the note alone.
 */
function mergeIntoTargetNote(
  targetSha: string,
  existing: Record<string, any>,
  mark: RewriteMarker | null,
  commits: string[],
  notes: Map<string, string>,
  warnings: RewriteWarning[],
  opts: Opts,
  markerBase: 'none' | 'note' = 'note',
): RebuildRewriteResult {
  const base = targetRecord(existing, targetSha);
  if (base === false) {
    warnings.push({ code: 'target-record-unusable', sha: targetSha, detail: 'existing target record is not an exact 1.0 record for this commit; left unchanged' });
    return { payload: null, warnings };
  }
  // No record: the target's own legacy note is the target's word about itself.
  const baseContributions: Record<string, any>[] = base
    ? base.contributions
    : claimsFromLegacy(targetSha, existing, [], opts).map((c) => c.contribution);

  const claims: Claim[] = [];
  for (const sha of commits) {
    const raw = notes.get(sha);
    if (raw === undefined) continue;
    const obj = parseNote(raw);
    if (!obj) { warnings.push({ code: 'source-note-not-json', sha, detail: 'source note is not JSON' }); continue; }
    claims.push(...claimsFromNote(sha, obj, warnings, opts));
  }
  const { merged, models } = mergeClaims(claims, warnings);

  const baseByKey = new Map(baseContributions.map((c) => [claimKey(c), c] as const));
  // Only a session the target does not carry may bring lines; every other
  // claimant, and the target's own line claims, still block the lines they reach.
  const carriers = new Set([...merged.keys()].filter((key) => !baseByKey.has(key)));
  const targetFiles = baseContributions.flatMap((c) => (Array.isArray(c.files) ? c.files : []));
  const files = carriedLineFiles(claims, carriers, opts.lineProjection, targetFiles, targetSha, warnings);
  if (!files) {
    warnings.push({ code: 'target-lines-unbounded', sha: targetSha, detail: 'the target record states more line ranges or lines than a rewrite checks; left unchanged' });
    return { payload: null, record: base || undefined, warnings };
  }
  const additions: Record<string, any>[] = [];
  // Sessions the target carries under a model the sources contradict: the
  // target keeps its contribution, minus the model.
  const degrade = new Set<string>();
  for (const [key, c] of merged) {
    const onTarget = baseByKey.get(key);
    if (!onTarget) { additions.push(files.has(key) ? { ...c, files: files.get(key) } : c); continue; }
    if (!hardIdentityAgrees([onTarget, c])) {
      warnings.push({ code: 'target-session-differs', sha: targetSha, sessionId: c.session?.id, detail: 'the target record already names this session with another identity; the target wins' });
      continue;
    }
    const all = modelsOf([onTarget, ...(models.get(key) ?? []).map((id) => ({ model: { id } }))]);
    if (all.length > 1 && onTarget.model !== undefined && standsWithoutModel(onTarget)) {
      degrade.add(key);
      warnings.push(modelDropped(c.session?.id, all, targetSha));
    }
  }
  const known = new Set(mark?.sources ?? []);
  const grew = commits.some((c) => !known.has(c));
  if (additions.length === 0 && degrade.size === 0 && !(mark && grew)) return { payload: null, record: base || undefined, warnings };

  let record: Record<string, any> | undefined = base || undefined;
  if (additions.length > 0 || degrade.size > 0) {
    const kept = baseContributions.map((c) => (degrade.has(claimKey(c)) ? withoutModel(c) : c));
    const candidate = base
      ? {
        ...base,
        attribution_level: levelOf([...kept, ...additions]),
        recorded_at: opts.recordedAt.toISOString(),
        producer: { name: ATTRIBUTION_RECORD_PRODUCER, version: opts.producerVersion },
        contributions: [...kept, ...additions],
      }
      : newRecord(targetSha, [...kept, ...additions], opts);
    record = validated(candidate, targetSha, warnings);
    if (!record) return { payload: null, warnings };
  }
  const envelope: Record<string, any> = { ...existing };
  if (record) envelope[ATTRIBUTION_RECORD_NOTE_KEY] = record;
  // A look-alike key of somebody else's is left as it was; ours sits beside it.
  envelope[REWRITE_NOTE_KEY] = marker(targetSha, [...known, ...commits], markerBase);
  return { payload: JSON.stringify(envelope, null, 2), record, warnings };
}

/**
 * Would replacing `existing` by `rebuilt` drop something `existing` carries: a
 * contribution of its record, a session of its legacy aggregate, or squashed
 * commits from its count? (A rebuild from every old commit's note only ever
 * adds; a smaller result means notes went missing.)
 */
function losesWhatTargetCarries(existing: Record<string, any>, rebuilt: string | null, conflicts: ReadonlySet<string> = new Set()): boolean {
  const next = rebuilt ? parseNote(rebuilt) : null;
  const before = existing[ATTRIBUTION_RECORD_NOTE_KEY]?.contributions;
  const after = new Set<string>((next?.[ATTRIBUTION_RECORD_NOTE_KEY]?.contributions ?? []).map(claimKey));
  // A contribution only loses its model (two proven models) under the same
  // key, so it is not "lost"; a deliberately conflicted session is not either.
  if (Array.isArray(before) && before.some((c: Record<string, any>) => !after.has(claimKey(c)) && !conflicts.has(claimKey(c)))) return true;
  const o = existing.origin;
  if (isPlainObject(o) && o.squashMerge === true) {
    const n = next?.origin;
    const ids = new Set<string>(isPlainObject(n) && Array.isArray(n.sessionIds) ? n.sessionIds : []);
    if (Array.isArray(o.sessionIds) && o.sessionIds.some((id: string) => !ids.has(id))) return true;
    if (typeof o.commitsSquashed === 'number' && !(isPlainObject(n) && n.commitsSquashed >= o.commitsSquashed)) return true;
  } else if (isPlainObject(o) && !(next && isPlainObject(next.origin))) {
    return true;
  }
  return false;
}

/** Equal notes but for the build timestamps: nothing new to write. */
function sameNoteModuloTime(a: string, b: string | null | undefined): boolean {
  const x = parseNote(a);
  const y = typeof b === 'string' ? parseNote(b) : null;
  if (!x || !y) return false;
  const strip = (o: Record<string, any>) => {
    const c = structuredClone(o);
    if (isPlainObject(c[ATTRIBUTION_RECORD_NOTE_KEY])) {
      delete c[ATTRIBUTION_RECORD_NOTE_KEY].recorded_at;
      delete c[ATTRIBUTION_RECORD_NOTE_KEY].producer;
    }
    if (isPlainObject(c.origin) && c.origin.squashMerge === true) delete c.origin.timestamp;
    return stable(c);
  };
  return strip(x) === strip(y);
}

// ─── The commit's own writer, after a rewrite ───────────────────────────────

/** The snapshot's contributions, each without its model where another copy of its session proves a different one. */
function sameSessionModels(
  own: Record<string, any>[],
  carried: Record<string, any> | null,
  mark: RewriteMarker,
  readSourceNote: ((sha: string) => string | null) | undefined,
  opts: Opts,
): Record<string, any>[] {
  if (!own.some((c) => c.model !== undefined)) return own;
  const copies: Record<string, any>[] = [...(carried?.contributions ?? [])];
  for (const sha of readSourceNote ? mark.sources : []) {
    let raw: string | null = null;
    try { raw = readSourceNote!(sha); } catch { /* unreadable: proves nothing */ }
    const obj = raw ? parseNote(raw) : null;
    if (obj) copies.push(...claimsFromNote(sha, obj, [], opts).map((c) => c.contribution));
  }
  return own.map((c) => {
    const key = claimKey(c);
    if (!key.startsWith('session:') || c.model === undefined || !standsWithoutModel(c)) return c;
    const same = copies.filter((x) => claimKey(x) === key && hardIdentityAgrees([c, x]));
    return modelsOf([c, ...same]).length > 1 ? withoutModel(c) : c;
  });
}

/**
 * The note a session writer (`writeGitNotes`: post-commit, Stop, SessionEnd)
 * stores on a commit that already carries a rewrite's note. The session's own
 * snapshot is the commit's word about itself: its legacy payload replaces the
 * carried one, and its contributions replace carried ones of the same session.
 * Carried contributions of other sessions stay, and so does the bookkeeping,
 * now `base: "note"`. With no rewrite marker on the existing note the
 * session's payload is returned unchanged — the OR-9 writer's behaviour.
 *
 * The snapshot names the model the session runs under NOW. When a carried copy
 * of the same session, or a note of an old commit the bookkeeping lists
 * (`readSourceNote`), proves another model, the snapshot's contribution keeps
 * everything but its model — the same field-level rule as the rebuild. Without
 * `readSourceNote` only the carried contribution is compared: a carried copy
 * that already lost its model cannot say why, so the snapshot's model stays.
 * Never throws.
 */
export function mergeSessionNoteOverRewrite(
  existingNote: string | null,
  sessionPayload: string,
  targetSha: string,
  opts: Opts,
  readSourceNote?: (sha: string) => string | null,
): string {
  try {
    const target = (targetSha || '').toLowerCase();
    const existing = typeof existingNote === 'string' ? parseNote(existingNote) : null;
    const mark = existing ? readRewriteMarker(existing, target) : null;
    const session = parseNote(sessionPayload);
    if (!existing || !mark || !session) return sessionPayload;

    const envelope: Record<string, any> = { ...session };
    envelope[REWRITE_NOTE_KEY] = marker(target, mark.sources, 'note');
    const existingRecord = targetRecord(existing, target);
    if (existingRecord === false) {
      // A newer, invalid or foreign-revision record is kept exactly as it is:
      // this writer cannot merge into it and must not replace it.
      const { [REWRITE_NOTE_KEY]: bookkeeping, [ATTRIBUTION_RECORD_NOTE_KEY]: _own, ...legacy } = envelope;
      return JSON.stringify({ ...legacy, [ATTRIBUTION_RECORD_NOTE_KEY]: existing[ATTRIBUTION_RECORD_NOTE_KEY], [REWRITE_NOTE_KEY]: bookkeeping }, null, 2);
    }
    const carried = existingRecord;
    const own = targetRecord(session, target) || null;
    const ownContributions = sameSessionModels(own ? own.contributions : [], carried, mark, readSourceNote, opts);
    const ownKeys = new Set(ownContributions.map(claimKey));
    const kept = (carried?.contributions ?? []).filter((c: Record<string, any>) => !ownKeys.has(claimKey(c)));

    const contributions = [...ownContributions, ...kept];
    if (contributions.length > 0) {
      const baseRecord = own ?? carried ?? newRecord(target, [], opts);
      const candidate = {
        ...baseRecord,
        attribution_level: contributions.some((c) => Array.isArray(c.files)) ? 'line' : 'commit',
        recorded_at: opts.recordedAt.toISOString(),
        producer: { name: ATTRIBUTION_RECORD_PRODUCER, version: opts.producerVersion },
        contributions,
      };
      const ok = validateFull(candidate).ok ? candidate : (carried ?? own);
      if (ok) envelope[ATTRIBUTION_RECORD_NOTE_KEY] = ok;
    }
    // Keep the envelope's key order: legacy, record, bookkeeping.
    const ordered: Record<string, any> = {};
    for (const [k, v] of Object.entries(envelope)) if (k !== REWRITE_NOTE_KEY) ordered[k] = v;
    ordered[REWRITE_NOTE_KEY] = envelope[REWRITE_NOTE_KEY];
    return JSON.stringify(ordered, null, 2);
  } catch {
    return sessionPayload;
  }
}
