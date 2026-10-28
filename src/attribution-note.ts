/**
 * The v1 attribution record inside an Origin Git note (OR-9/A3).
 *
 * A note on refs/notes/origin is a backward-compatible envelope:
 *
 *   {
 *     "origin": { ...legacy session note, unchanged... },
 *     "attribution_record": { ...one canonical v1 record for THIS commit... }
 *   }
 *
 * `origin` stays exactly what every CLI and API reader parses today.
 * `attribution_record` is the contract of schemas/attribution-record/v1 and
 * passes its full validation path (`validateFull`) before it is written. It is
 * built per annotated commit — one revision per record — never shared between
 * the commits one `writeGitNotes` call annotates.
 *
 * Every optional field comes from a source that measured or observed it. When
 * no such source exists the field is absent, and when no honest record can be
 * built at all the key is absent and the legacy note is written on its own.
 */

import type { SessionState } from './session-state.js';
import {
  ATTRIBUTION_RECORD_SCHEMA_VERSION,
  attributionRecordSchema,
  validateFull,
} from './attribution-record.js';
import { allToolIds, isSpecificModel } from './agents/registry.js';
import { localTurnForServerRow, serverRowForLocalTurn } from './turn-index.js';
import { isPromptHash, provablePromptHash } from './prompt-hash.js';
import type { ProjectedLineFile } from './attribution-line-ranges.js';

/** The note key that carries the canonical record, next to the legacy `origin`. */
export const ATTRIBUTION_RECORD_NOTE_KEY = 'attribution_record';

export const ATTRIBUTION_RECORD_PRODUCER = 'origin-cli';

/**
 * Tool identities a captured `agentSlug` may carry into `agent.id`: the
 * well-known values of the v1 README. `agentSlug` is not always a tool — a
 * per-tool override (`origin config set agentSlugs.cursor cursor-frontend`)
 * replaces it with an Origin agent name — so anything outside this list is not
 * a tool identity and gives no record rather than a wrong one.
 */
export const CANONICAL_AGENT_IDS: readonly string[] = allToolIds();

/**
 * What a writer knows about the session behind a note, gathered once per
 * `writeGitNotes` call. Everything but `sessionId` is optional; the builder
 * drops whatever does not meet the contract.
 */
export interface AttributionRecordSource {
  /** Origin session id. */
  sessionId: string;
  /** Explicit captured tool identity (never inferred from the model). */
  agentId?: string;
  /** Model id exactly as the agent reported it. */
  modelId?: string;
  /** Permissioned record of the whole session; set only for a session the server knows. */
  sessionReferenceUri?: string;
  /** When the session started (not a relaunch). */
  sessionStartedAt?: string;
  /** Session-cumulative cost estimate in USD. */
  costUsd?: number;
  /** Commit sha → cumulative zero-based index of the one turn that made it. */
  iterationIndexBySha?: Record<string, number>;
  /** Cumulative index → canonical hash of that prompt's permissioned record, only where provable. */
  promptHashByIndex?: Record<number, string>;
  /**
   * Full lowercase commit sha → what this writer's line projection decided for
   * it (attribution-line-claims.ts). Computed before the write; the builder
   * never reads git. Only a `proven` decision whose files are publishable
   * makes the record line-level; a sha without one is `not_evaluated`.
   */
  lineClaims?: LineClaimDecisions;
}

/**
 * What one writer's line projection says about one commit (OR-45 checkpoint 6):
 *
 *   • `proven` — a non-empty, publishable set of files: the contribution is
 *     line-level, and replaces any ranges stored before;
 *   • `degraded` — the commit WAS evaluated and nothing could be proven (a
 *     truncated capture, a replay mismatch, the budget ran out, the claims were
 *     oversized or invalid). Authoritative: the contribution is commit-level,
 *     and ranges stored by an earlier write are NOT carried over;
 *   • `not_evaluated` — this writer did not look (no capture surface, no bound
 *     turn, an agent without line claims). Says nothing about lines, so ranges
 *     an earlier write of the same session proved are kept.
 */
export type LineClaimDecision =
  | { status: 'proven'; files: ProjectedLineFile[] }
  | { status: 'degraded'; reason: string }
  | { status: 'not_evaluated' };

export type LineClaimDecisions = Readonly<Record<string, LineClaimDecision>>;

const NOT_EVALUATED: LineClaimDecision = { status: 'not_evaluated' };

/** The decision for `sha` (any case); a sha the map does not name was not evaluated. */
export function lineClaimDecisionFor(decisions: LineClaimDecisions | undefined, sha: string): LineClaimDecision {
  const key = (sha || '').toLowerCase();
  const d = decisions && Object.hasOwn(decisions, key) ? decisions[key] : undefined;
  return d && typeof d === 'object' && (d.status === 'proven' || d.status === 'degraded') ? d : NOT_EVALUATED;
}

export type AttributionRecordBuild =
  | { record: Record<string, any>; reason?: undefined }
  | { record?: undefined; reason: string };

// Patterns are read from the schema itself, so a prefilter can never be looser
// or stricter than the contract it guards.
let patternCache: { model: RegExp; referenceUri: RegExp; sessionId: RegExp; repoPath: RegExp } | null = null;
function patterns() {
  if (!patternCache) {
    const defs = attributionRecordSchema().$defs;
    patternCache = {
      model: new RegExp(defs.model.properties.id.allOf[0].pattern),
      referenceUri: new RegExp(defs.reference_uri.pattern),
      sessionId: new RegExp(defs.opaque_id.pattern),
      repoPath: new RegExp(defs.repo_path.pattern),
    };
  }
  return patternCache;
}

// Session ids that name no observed Origin session: the legacy `unknown`
// sentinel, the post-commit pgrep receipt (`detected-<agent>-<t>`), and the
// Devin Desktop recency guess (`devin-<native id>`, picked by "a recent session
// in this repo", not observed making the commit).
const UNOBSERVED_SESSION = /^(unknown$|detected-|devin-)/;

/** The model id a record may carry, or undefined when the reported value is not one. */
export function canonicalModelId(model: string | undefined | null): string | undefined {
  const m = (model || '').trim();
  if (!isSpecificModel(m) || /^unknown$/i.test(m)) return undefined;
  return patterns().model.test(m) ? m : undefined;
}

/** The agent id a record may carry, or undefined when the slug is not a tool identity. */
export function canonicalAgentId(slug: string | undefined | null): string | undefined {
  const s = (slug || '').trim();
  return CANONICAL_AGENT_IDS.includes(s) ? s : undefined;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Positive estimate → decimal string with at most 6 fractional digits; anything else → undefined. */
function costAmount(costUsd: number | undefined): string | undefined {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  const amount = costUsd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  // A cost that rounds to zero at six digits was not measured as zero.
  return /^0(\.0*)?$/.test(amount) ? undefined : amount;
}

/**
 * Build the canonical v1 record for one annotated commit, and run it through
 * the full validation path. Pure apart from reading the schema file.
 *
 * Never throws; a record that cannot be built honestly, or that fails
 * validation, comes back as `{ reason }` and the caller writes no record.
 */
export function buildAttributionRecordForCommit(
  sha: string,
  source: AttributionRecordSource,
  opts: { recordedAt: Date; producerVersion: string },
): AttributionRecordBuild {
  try {
    const revisionId = (sha || '').toLowerCase();
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(revisionId)) {
      return { reason: 'revision id is not a full git sha' };
    }
    const sessionId = (source.sessionId || '').trim();
    if (!sessionId || UNOBSERVED_SESSION.test(sessionId) || !patterns().sessionId.test(sessionId)) {
      return { reason: 'no observed Origin session' };
    }
    // session_capture requires the agent, and the agent is never guessed.
    const agentId = canonicalAgentId(source.agentId);
    if (!agentId) return { reason: 'no captured tool identity' };

    const recordedAt = opts.recordedAt.toISOString();
    const session: Record<string, any> = { id: sessionId };

    const sessionRef = source.sessionReferenceUri && patterns().referenceUri.test(source.sessionReferenceUri)
      && source.sessionReferenceUri.length <= 2048
      ? source.sessionReferenceUri
      : undefined;
    if (sessionRef) session.reference_uri = sessionRef;

    const startedAt = isoOrUndefined(source.sessionStartedAt);
    if (startedAt) {
      const durationMs = opts.recordedAt.getTime() - Date.parse(startedAt);
      // A start after the record is a clock problem, not a session.
      if (durationMs >= 0) {
        session.started_at = startedAt;
        session.duration_ms = durationMs;
      }
    }

    const index = source.iterationIndexBySha?.[revisionId];
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
      const iteration: Record<string, any> = { index };
      const promptHash = source.promptHashByIndex?.[index];
      if (isPromptHash(promptHash)) iteration.prompt_hash = promptHash;
      if (sessionRef) iteration.reference_uri = `${sessionRef}?prompt=${index}`;
      session.iterations = [iteration];
    }

    const amount = costAmount(source.costUsd);
    if (amount) session.usage = { cost: { amount, currency: 'USD', basis: 'estimated' } };

    const contribution: Record<string, any> = { evidence: 'session_capture', agent: { id: agentId } };
    const modelId = canonicalModelId(source.modelId);
    if (modelId) contribution.model = { id: modelId };
    contribution.session = session;

    const record = {
      schema_version: ATTRIBUTION_RECORD_SCHEMA_VERSION,
      revision: { vcs: 'git', id: revisionId },
      attribution_level: 'commit',
      recorded_at: recordedAt,
      producer: { name: ATTRIBUTION_RECORD_PRODUCER, version: opts.producerVersion },
      contributions: [contribution],
    };

    // Proven line claims make this a line-level record. One that does not
    // validate is dropped whole, and the honest commit-level record below is
    // written instead — never a partially trusted projection.
    const iterationIndex = Array.isArray(session.iterations) ? session.iterations[0].index : undefined;
    const decision = lineClaimDecisionFor(source.lineClaims, revisionId);
    const files = decision.status === 'proven' ? publishableLineFiles(decision.files, iterationIndex) : null;
    if (files && files.length > 0) {
      const lineRecord = { ...record, attribution_level: 'line', contributions: [{ ...contribution, files }] };
      if (validateFull(lineRecord).ok) return { record: lineRecord };
    }

    const result = validateFull(record);
    if (!result.ok) {
      const first = result.schemaErrors[0]
        ? `${result.schemaErrors[0].instancePath || '/'} ${result.schemaErrors[0].message}`
        : `${result.semanticErrors[0]?.rule} ${result.semanticErrors[0]?.message}`;
      return { reason: `record failed validation: ${first}` };
    }
    return { record };
  } catch (err) {
    return { reason: `record build error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type NormalizedLineFile = { path: string; ranges: Array<Record<string, number>> };

/**
 * The most a contribution's `files` may take in the stored note, in UTF-8
 * bytes. The note reaches git as ONE argument (`git notes add -m`), and Linux
 * caps a single argument at MAX_ARG_STRLEN = 128 KiB; half of it leaves room
 * for the legacy payload and the rest of the record.
 */
export const LINE_FILES_MAX_BYTES = 64 * 1024;

// The schema's limits on `files` (attribution-record.schema.json, line_file).
const MAX_LINE_FILES = 1000;
const MAX_LINE_RANGES = 10000;
// The note is pretty-printed with two spaces, and a contribution's `files`
// value sits four levels deep (record → contributions → [n] → files): each of
// its lines but the first carries 8 more spaces than it does on its own.
const FILES_NOTE_INDENT = 8;

/** UTF-8 bytes `files` takes inside the stored note. */
function lineFilesNoteBytes(files: NormalizedLineFile[]): number {
  const text = JSON.stringify(files, null, 2);
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  return Buffer.byteLength(text, 'utf8') + FILES_NOTE_INDENT * (lines - 1);
}

/**
 * The one publishability check for line claims, shared by the record builder
 * and by the projection that decides whether Stop rewrites a note — so a set
 * the builder would refuse is never "proven", and never draws a rewrite on
 * every Stop.
 *
 * Returns the normalized files (see normalizedLineClaims), `[]` for no claims,
 * or null when the set cannot be published WHOLE: malformed, beyond the
 * schema's path and count limits, or larger than LINE_FILES_MAX_BYTES in the
 * note. Nothing is ever trimmed to fit.
 */
export function publishableLineFiles(
  claims: ProjectedLineFile[] | undefined,
  iterationIndex: number | undefined,
): NormalizedLineFile[] | null {
  const files = normalizedLineClaims(claims, iterationIndex);
  if (!files || files.length === 0) return files;
  if (files.length > MAX_LINE_FILES) return null;
  for (const f of files) {
    if (f.path.length > 4096 || !patterns().repoPath.test(f.path) || f.ranges.length > MAX_LINE_RANGES) return null;
  }
  return lineFilesNoteBytes(files) <= LINE_FILES_MAX_BYTES ? files : null;
}

const FILE_KEYS = new Set(['path', 'ranges']);
const RANGE_KEYS = new Set(['start_line', 'end_line', 'iteration_index']);
const onlyKeys = (o: object, allowed: ReadonlySet<string>) => Object.keys(o).every((k) => allowed.has(k));

/**
 * The v1 `files` of one contribution from projected claims: integer, ordered,
 * non-overlapping 1-based ranges, one entry per path, sorted.
 *
 * The set is accepted WHOLE or not at all. `[]` means there are no claims;
 * `null` means the set is invalid — a malformed file or range, an unknown key,
 * a path listed twice, overlapping ranges — and the caller writes the
 * commit-level record, never the valid-looking remainder. Path safety and the
 * rest of the contract are checked by `validateFull` on the whole record.
 *
 * A well-formed `iteration_index` that is not the contribution's own iteration
 * is not proof of anything the record can name (S5): the range keeps its lines
 * and loses the index, which is never re-guessed into another.
 */
function normalizedLineClaims(
  claims: ProjectedLineFile[] | undefined,
  iterationIndex: number | undefined,
): NormalizedLineFile[] | null {
  if (claims === undefined) return [];
  if (!Array.isArray(claims)) return null;
  const files: NormalizedLineFile[] = [];
  const paths = new Set<string>();
  for (const file of claims) {
    if (!file || typeof file !== 'object' || !onlyKeys(file, FILE_KEYS)) return null;
    if (typeof file.path !== 'string' || !file.path || paths.has(file.path)) return null;
    if (!Array.isArray(file.ranges) || file.ranges.length === 0) return null;
    paths.add(file.path);
    const ranges: Array<Record<string, number>> = [];
    for (const r of file.ranges) {
      if (!r || typeof r !== 'object' || !onlyKeys(r, RANGE_KEYS)) return null;
      const { start_line: start, end_line: end, iteration_index: iteration } = r;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
      if (iteration !== undefined && !(Number.isSafeInteger(iteration) && iteration >= 0)) return null;
      const range: Record<string, number> = { start_line: start, end_line: end };
      if (iterationIndex !== undefined && iteration === iterationIndex) range.iteration_index = iterationIndex;
      ranges.push(range);
    }
    ranges.sort((x, y) => x.start_line - y.start_line || x.end_line - y.end_line);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start_line <= ranges[i - 1].end_line) return null;
    files.push({ path: file.path, ranges });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The canonical record inside a stored note, when it is an exact valid v1.0 record for `sha`. */
function validRecordFor(note: Record<string, any> | null, sha: string): Record<string, any> | null {
  const record = note?.[ATTRIBUTION_RECORD_NOTE_KEY];
  if (!record || typeof record !== 'object' || record.revision?.id !== sha) return null;
  return validateFull(record).ok ? record : null;
}

function parseNoteObject(raw: string | null | undefined): Record<string, any> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sessionIdOf(c: Record<string, any>): string | undefined {
  return c?.evidence === 'session_capture' && typeof c.session?.id === 'string' ? c.session.id : undefined;
}

/**
 * Keep line claims a session already proved for a commit when the same
 * session writes that commit again without them.
 *
 * A commit's note is written up to three times (post-commit, Stop,
 * SessionEnd), and a later write can lack the capture an earlier one had — a
 * transcript not flushed yet, a ledger that rolled over. Replacing the stored
 * record then would silently turn proven lines into a bare commit claim.
 * The writer calls this ONLY when its own projection of the commit is
 * `not_evaluated`: a fresh `degraded` result is a negative re-check and must
 * not be undone here. Then, for each contribution of the stored record that
 * has `files`:
 *
 *   • the new payload's contribution of the SAME session, if it has no `files`
 *     of its own, takes the stored ones (and the stored iterations they name);
 *   • a new contribution WITH `files` wins — a fresh proof replaces the old;
 *   • other sessions, and a stored record that is not an exact valid v1.0
 *     record of this very commit, are left to the existing write rules.
 *
 * The result must pass full validation; otherwise the stored contribution is
 * kept whole, and if even that fails the new payload is written unchanged.
 * Never throws.
 */
export function preserveProvenLineClaims(existingNote: string | null, newPayload: string, sha: string): string {
  try {
    const target = (sha || '').toLowerCase();
    const stored = validRecordFor(parseNoteObject(existingNote), target);
    if (!stored || stored.attribution_level !== 'line') return newPayload;
    const next = parseNoteObject(newPayload);
    const record = next?.[ATTRIBUTION_RECORD_NOTE_KEY];
    if (!next || !record || typeof record !== 'object' || record.revision?.id !== target) return newPayload;
    if (!Array.isArray(record.contributions)) return newPayload;

    const provenBySession = new Map<string, Record<string, any>>();
    for (const c of stored.contributions) {
      const id = sessionIdOf(c);
      if (id && Array.isArray(c.files)) provenBySession.set(id, c);
    }
    let changed = false;
    const merge = (whole: boolean) => record.contributions.map((c: Record<string, any>) => {
      const id = sessionIdOf(c);
      const proven = id ? provenBySession.get(id) : undefined;
      if (!proven || Array.isArray(c.files)) return c;
      changed = true;
      if (whole) return proven;
      const named = new Set<number>();
      for (const f of proven.files) for (const r of f.ranges) if (typeof r.iteration_index === 'number') named.add(r.iteration_index);
      const have = new Set<number>((c.session?.iterations ?? []).map((it: Record<string, any>) => it.index));
      const carried = (proven.session?.iterations ?? []).filter((it: Record<string, any>) => named.has(it.index) && !have.has(it.index));
      const session = carried.length > 0
        ? { ...c.session, iterations: [...(c.session?.iterations ?? []), ...carried].sort((a, b) => a.index - b.index) }
        : c.session;
      return { ...c, session, files: proven.files };
    });

    for (const whole of [false, true]) {
      changed = false;
      const contributions = merge(whole);
      if (!changed) return newPayload;
      const candidate = { ...record, attribution_level: 'line', contributions };
      if (validateFull(candidate).ok) {
        return JSON.stringify({ ...next, [ATTRIBUTION_RECORD_NOTE_KEY]: candidate }, null, 2);
      }
    }
    return newPayload;
  } catch {
    return newPayload;
  }
}

/**
 * May Stop upgrade this EXISTING note with `sessionId`'s line claims? Only
 * when it holds an exact valid v1.0 record of `sha` whose contribution from
 * this session exists and is still commit-level. A note of other sessions
 * only, one with no valid record (legacy-only, invalid, unsupported, another
 * revision's) and one whose own contribution already has lines are not
 * candidates: Stop never projects them, and never writes them with `-f`.
 * A missing note is not this function's question — Stop always writes it.
 */
export function noteIsLineUpgradeCandidate(existingNote: string | null, sha: string, sessionId: string): boolean {
  const record = validRecordFor(parseNoteObject(existingNote), (sha || '').toLowerCase());
  if (!record || !sessionId) return false;
  const own = record.contributions.filter((c: Record<string, any>) => sessionIdOf(c) === sessionId);
  return own.length > 0 && own.every((c: Record<string, any>) => !Array.isArray(c.files));
}

/**
 * A record for a commit Origin did NOT capture, attributed after the fact by
 * `origin backfill` from evidence outside a session (a transcript that shows
 * the agent making the commit, a co-author trailer naming it). `inferred`
 * evidence carries no session by contract, so a reader sets the commit's agent
 * from it and never makes up a session. Validated like every record; a slug
 * that is not a tool identity gives no record.
 */
export function buildInferredAttributionRecord(
  sha: string,
  agentSlug: string,
  opts: { recordedAt: Date; producerVersion: string },
): AttributionRecordBuild {
  try {
    const revisionId = (sha || '').toLowerCase();
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(revisionId)) return { reason: 'revision id is not a full git sha' };
    const agentId = canonicalAgentId(agentSlug);
    if (!agentId) return { reason: 'not a tool identity' };
    const record = {
      schema_version: ATTRIBUTION_RECORD_SCHEMA_VERSION,
      revision: { vcs: 'git', id: revisionId },
      attribution_level: 'commit',
      recorded_at: opts.recordedAt.toISOString(),
      producer: { name: ATTRIBUTION_RECORD_PRODUCER, version: opts.producerVersion },
      contributions: [{ evidence: 'inferred', agent: { id: agentId } }],
    };
    const result = validateFull(record);
    if (!result.ok) {
      const first = result.schemaErrors[0]
        ? `${result.schemaErrors[0].instancePath || '/'} ${result.schemaErrors[0].message}`
        : `${result.semanticErrors[0]?.rule} ${result.semanticErrors[0]?.message}`;
      return { reason: `record failed validation: ${first}` };
    }
    return { record };
  } catch (err) {
    return { reason: `record build error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The turn that made each commit, as a cumulative zero-based prompt index.
 *
 * Only the post-commit attestation counts: the hook watched the commit land
 * inside a running turn. A transcript sighting is the agent SAYING it committed
 * (prose can carry an old sha), so it names no iteration. A sha attested under
 * two different turns, or a turn id this launch never numbered, is ambiguous and
 * names none either.
 */
export function iterationIndexByShaFromState(
  state: Pick<SessionState, 'commitTurns' | 'promptTurnIds' | 'promptIndexBase'>,
): Record<string, number> {
  const turnsBySha = new Map<string, Set<string>>();
  for (const ct of state.commitTurns || []) {
    if (!ct || ct.via !== 'post-commit' || typeof ct.sha !== 'string' || !ct.turnId) continue;
    const sha = ct.sha.toLowerCase();
    if (!turnsBySha.has(sha)) turnsBySha.set(sha, new Set());
    turnsBySha.get(sha)!.add(ct.turnId);
  }
  const out: Record<string, number> = {};
  const ids = state.promptTurnIds || [];
  for (const [sha, turnIds] of turnsBySha) {
    if (turnIds.size !== 1) continue;
    const [turnId] = [...turnIds];
    const local = ids.indexOf(turnId);
    if (local < 0 || ids.lastIndexOf(turnId) !== local) continue;
    out[sha] = serverRowForLocalTurn(local, state.promptIndexBase);
  }
  return out;
}

/**
 * The canonical hash of each attested iteration's prompt, where provable
 * (prompt-hash.ts). An iteration's index is cumulative; its prompt is the
 * local turn `index - promptIndexBase` this launch captured whole. A turn this
 * launch did not capture, or a prompt the served record may differ from, gets
 * no hash.
 */
export function promptHashesForIterations(
  state: Pick<SessionState, 'prompts' | 'promptIndexBase'>,
  indexes: number[],
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const index of indexes) {
    const local = localTurnForServerRow(index, state.promptIndexBase);
    if (local === null) continue;
    const hash = provablePromptHash(state.prompts?.[local]);
    if (hash) out[index] = hash;
  }
  return out;
}

/**
 * The record source for a session, shared by every note writer (post-commit,
 * Stop, SessionEnd) so the three cannot drift.
 *
 * `agentSlug`/`model` are what the calling hook resolved; `connected` and
 * `apiUrl` decide whether the session has a server record to point at.
 */
export function attributionSourceFromState(
  state: SessionState,
  opts: {
    agentSlug?: string;
    model?: string;
    costUsd?: number;
    connected: boolean;
    apiUrl?: string;
    /** Line projection decisions (lineClaimsForCommits), keyed by full sha. */
    lineClaims?: LineClaimDecisions;
  },
): AttributionRecordSource {
  const pending = (state as { pendingRegistration?: boolean }).pendingRegistration === true;
  // `local-*` ids are reserved before (or instead of) server registration, so
  // no server record exists behind them.
  const serverKnown = opts.connected && !!opts.apiUrl && !pending && !state.sessionId.startsWith('local-');
  // A resumed or adopted conversation started before this launch; the state's
  // startedAt is the relaunch, not the session's start.
  const resumed = typeof state.promptIndexBase === 'number' && state.promptIndexBase > 0;
  const iterationIndexBySha = iterationIndexByShaFromState(state);
  return {
    sessionId: state.sessionId,
    agentId: opts.agentSlug || state.agentSlug,
    modelId: opts.model || state.model,
    sessionReferenceUri: serverKnown ? `${opts.apiUrl!.replace(/\/+$/, '')}/sessions/${state.sessionId}` : undefined,
    sessionStartedAt: resumed ? undefined : state.startedAt,
    costUsd: opts.costUsd,
    iterationIndexBySha,
    promptHashByIndex: promptHashesForIterations(state, Object.values(iterationIndexBySha)),
    ...(opts.lineClaims && Object.keys(opts.lineClaims).length > 0 && { lineClaims: opts.lineClaims }),
  };
}
