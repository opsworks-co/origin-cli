/**
 * One answer to "what did this turn change", from everything the capture
 * passes found.
 *
 * Three passes decide a turn's content today, in order, each overwriting the
 * row when its own evidence qualifies: the write journal
 * (applyLedgerToMappings), the shadow window (preferShadowRangeForTurns), then
 * the commit patch (preferCommitPatchForCommittedTurns). The ranking between
 * them is written nowhere. It is the order of three calls plus the exceptions
 * that live inside whichever pass runs later — the shadow pass keeping the
 * ledger's row when an empty window cannot prove "no work", for one.
 *
 * This module writes the ranking down. The passes report what they found
 * through `observe`, `resolveTurn` ranks those observations, and the hooks log
 * where its answer and the passes' answer disagree. The row that is SENT is
 * still the passes' — phase 1 of the capture consolidation runs old and new
 * side by side for a release before anything switches over.
 *
 * The ranking, highest first:
 *   1. commit-patch    — the turn's work is entirely in its commits
 *   2. turn-window     — git between the turn's shadows; an EMPTY window is
 *                        chat-only, unless its start is not a complete baseline
 *                        and the ledger saw writes
 *   3. ledger          — the write journal resolved the turn
 *   4. reconstruction  — the row as the hook built it before the passes ran
 *   —  unavailable     — nothing above has content
 *
 * The turn window outranks the ledger because that is what the code does: it
 * runs after the ledger and replaces its row. The consolidation plan's draft
 * table put the ledger first; the side-by-side logs are the check.
 */

export type TurnSource = 'commit-patch' | 'turn-window' | 'ledger' | 'reconstruction';

export interface TurnContent {
  files: string[];
  diff: string;
  added: number;
  removed: number;
  /** Files the source knows changed but has no content for. */
  contentUnavailable: string[];
}

/** What one pass found for one turn. A pass that never looked reports nothing. */
export type TurnObservation =
  | ({ source: 'reconstruction' } & TurnContent)
  | ({ source: 'ledger'; outcome: 'applied' } & TurnContent)
  | { source: 'ledger'; outcome: 'declined'; reason: string }
  | ({ source: 'turn-window'; outcome: 'applied' } & TurnContent)
  | { source: 'turn-window'; outcome: 'empty'; completeBaseline: boolean }
  | { source: 'turn-window'; outcome: 'declined'; reason: string }
  | ({ source: 'commit-patch'; outcome: 'applied' } & TurnContent)
  | { source: 'commit-patch'; outcome: 'declined'; reason: string };

export type TurnResolution =
  | ({ kind: 'diff'; source: TurnSource; why: string[] } & TurnContent)
  /** The turn really changed no files. */
  | { kind: 'chat-only'; why: string[] }
  /** The evidence cannot answer — never guessed, never silently blank. */
  | { kind: 'unavailable'; reason: string; why: string[] };

type ObservationOf<S extends TurnObservation['source']> = Extract<TurnObservation, { source: S }>;

/** The last report from a source: a pass that ran twice answered twice. */
function latest<S extends TurnObservation['source']>(
  observations: readonly TurnObservation[],
  source: S,
): ObservationOf<S> | undefined {
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].source === source) return observations[i] as ObservationOf<S>;
  }
  return undefined;
}

function contentOf(c: TurnContent): TurnContent {
  return { files: [...c.files], diff: c.diff, added: c.added, removed: c.removed, contentUnavailable: [...c.contentUnavailable] };
}

/** The shadow pass's own test for "this row carries work": files or diff text. */
const wrote = (c: TurnContent) => c.files.length > 0 || !!c.diff.trim();

export function resolveTurn(observations: readonly TurnObservation[]): TurnResolution {
  const why: string[] = [];
  const commit = latest(observations, 'commit-patch');
  const window = latest(observations, 'turn-window');
  const ledger = latest(observations, 'ledger');
  const reconstruction = latest(observations, 'reconstruction');

  if (commit?.outcome === 'applied') {
    why.push('commit-patch: the turn\'s work is entirely in its commits');
    return { kind: 'diff', source: 'commit-patch', ...contentOf(commit), why };
  }
  if (commit) why.push(`commit-patch declined: ${commit.reason}`);

  if (window?.outcome === 'applied') {
    why.push('turn-window: git between the turn\'s shadows');
    return { kind: 'diff', source: 'turn-window', ...contentOf(window), why };
  }
  if (window?.outcome === 'empty') {
    // After-file-edit cuts a shadow at DISCOVERY, after the write that
    // revealed the turn, so an empty window from an incomplete baseline is not
    // proof of no work. The ledger's journal marks bound the turn; keep them.
    if (ledger?.outcome === 'applied' && wrote(ledger) && !window.completeBaseline) {
      why.push('turn-window empty, but its start is not a complete baseline and the ledger saw writes');
      return { kind: 'diff', source: 'ledger', ...contentOf(ledger), why };
    }
    why.push(window.completeBaseline
      ? 'turn-window: empty between complete shadows'
      : 'turn-window: empty, and no journal writes say otherwise');
    return { kind: 'chat-only', why };
  }
  if (window) why.push(`turn-window declined: ${window.reason}`);

  if (ledger?.outcome === 'applied') {
    why.push('ledger: the write journal resolved the turn');
    return { kind: 'diff', source: 'ledger', ...contentOf(ledger), why };
  }
  if (ledger) why.push(`ledger declined: ${ledger.reason}`);

  if (reconstruction && (wrote(reconstruction) || reconstruction.contentUnavailable.length > 0)) {
    why.push('reconstruction: no higher source qualified');
    return { kind: 'diff', source: 'reconstruction', ...contentOf(reconstruction), why };
  }
  return {
    kind: 'unavailable',
    reason: reconstruction ? 'no source has content for this turn' : 'no capture was observed',
    why,
  };
}

// ─── Side by side ───────────────────────────────────────────────────────────

/** A turn row as the hooks build it. Structural, like the passes' own types. */
export interface ResolvableRow {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
  contentUnavailableFiles?: string[];
  diffSource?: string;
}

export interface TurnObserver {
  observe: (promptIndex: number, observation: TurnObservation) => void;
  observations: (promptIndex: number) => TurnObservation[];
}

export function createTurnObserver(): TurnObserver {
  const byTurn = new Map<number, TurnObservation[]>();
  return {
    observe: (promptIndex, observation) => {
      if (!Number.isInteger(promptIndex)) return;
      const list = byTurn.get(promptIndex) || [];
      list.push(observation);
      byTurn.set(promptIndex, list);
    },
    observations: (promptIndex) => [...(byTurn.get(promptIndex) || [])],
  };
}

function rowContent(row: ResolvableRow): TurnContent {
  return {
    files: Array.isArray(row.filesChanged)
      ? (row.filesChanged as unknown[]).filter((f): f is string => typeof f === 'string' && !!f)
      : [],
    diff: row.diff || '',
    added: row.linesAdded ?? 0,
    removed: row.linesRemoved ?? 0,
    contentUnavailable: Array.isArray(row.contentUnavailableFiles) ? [...row.contentUnavailableFiles] : [],
  };
}

/**
 * Record each row as the passes will find it. Call BEFORE the first pass:
 * they mutate the rows in place.
 */
export function observeReconstruction(rows: ReadonlyArray<ResolvableRow | null | undefined>, observer: TurnObserver): void {
  for (const row of rows) {
    if (!row || !Number.isInteger(row.promptIndex)) continue;
    observer.observe(row.promptIndex, { source: 'reconstruction', ...rowContent(row) });
  }
}

export type SideBySideVerdict = 'agree' | 'differ' | 'unavailable';

/**
 * Does the row the passes built carry the content the resolver chose?
 *
 * Content only. A row's `diffSource` is not comparable: the commit-patch pass
 * keeps `'ledger'` on purpose (see commit-patch-for-committed-turn.ts), so the
 * same bytes can carry either label. An empty row against `unavailable` is its
 * own verdict — it is the one difference the consolidation means to make.
 */
export function compareWithRow(row: ResolvableRow, resolution: TurnResolution): { verdict: SideBySideVerdict; fields: string[] } {
  const have = rowContent(row);
  const rowEmpty = have.files.length === 0 && !have.diff.trim() && have.added === 0 && have.removed === 0;
  if (resolution.kind === 'unavailable') {
    return rowEmpty ? { verdict: 'unavailable', fields: [] } : { verdict: 'differ', fields: ['content'] };
  }
  const want: TurnContent = resolution.kind === 'chat-only'
    ? { files: [], diff: '', added: 0, removed: 0, contentUnavailable: [] }
    : resolution;
  const fields: string[] = [];
  if ([...have.files].sort().join('\0') !== [...want.files].sort().join('\0')) fields.push('files');
  if (have.diff !== want.diff) fields.push('diff');
  if (have.added !== want.added) fields.push('linesAdded');
  if (have.removed !== want.removed) fields.push('linesRemoved');
  return { verdict: fields.length > 0 ? 'differ' : 'agree', fields };
}

/**
 * For a sender that runs every few seconds (a watcher poll, a heartbeat tick):
 * pass a difference through, drop the summary line when nothing differs.
 */
export function onlyDifferences(
  log: (event: string, data: Record<string, unknown>) => void,
): (event: string, data: Record<string, unknown>) => void {
  // ORIGIN_RESOLVER_LOG_ALL=1 keeps every summary: a test run has to show the
  // comparison happened, not only that nothing differed.
  const all = process.env.ORIGIN_RESOLVER_LOG_ALL === '1';
  return (event, data) => {
    if (!all && event === 'resolver side by side' && !data.differ) return;
    log(event, data);
  };
}

/**
 * Resolve every observed row and log where the resolver and the passes part
 * ways. Rows no pass looked at are skipped. Never changes a row.
 */
export function compareResolverWithPasses(
  rows: ReadonlyArray<ResolvableRow | null | undefined>,
  observer: TurnObserver,
  log: (event: string, data: Record<string, unknown>) => void,
): Record<SideBySideVerdict, number> {
  const tally: Record<SideBySideVerdict, number> = { agree: 0, differ: 0, unavailable: 0 };
  const sources: Record<string, number> = {};
  for (const row of rows) {
    if (!row || !Number.isInteger(row.promptIndex)) continue;
    const observations = observer.observations(row.promptIndex);
    if (observations.length === 0) continue;
    const resolution = resolveTurn(observations);
    const label = resolution.kind === 'diff' ? resolution.source : resolution.kind;
    sources[label] = (sources[label] || 0) + 1;
    const { verdict, fields } = compareWithRow(row, resolution);
    tally[verdict] += 1;
    if (verdict !== 'differ') continue;
    const have = rowContent(row);
    log('resolver differs from the passes', {
      promptIndex: row.promptIndex,
      fields,
      passes: { diffSource: row.diffSource ?? null, files: have.files.length, lines: `+${have.added}/-${have.removed}` },
      resolver: resolution.kind === 'diff'
        ? { source: resolution.source, files: resolution.files.length, lines: `+${resolution.added}/-${resolution.removed}` }
        : { kind: resolution.kind },
      why: resolution.why,
    });
  }
  log('resolver side by side', { ...tally, sources });
  return tally;
}
