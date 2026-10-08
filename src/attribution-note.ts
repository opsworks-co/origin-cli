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
}

export type AttributionRecordBuild =
  | { record: Record<string, any>; reason?: undefined }
  | { record?: undefined; reason: string };

// Patterns are read from the schema itself, so a prefilter can never be looser
// or stricter than the contract it guards.
let patternCache: { model: RegExp; referenceUri: RegExp; sessionId: RegExp } | null = null;
function patterns() {
  if (!patternCache) {
    const defs = attributionRecordSchema().$defs;
    patternCache = {
      model: new RegExp(defs.model.properties.id.allOf[0].pattern),
      referenceUri: new RegExp(defs.reference_uri.pattern),
      sessionId: new RegExp(defs.opaque_id.pattern),
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
  opts: { agentSlug?: string; model?: string; costUsd?: number; connected: boolean; apiUrl?: string },
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
  };
}
