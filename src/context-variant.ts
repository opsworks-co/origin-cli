// ─── Context variants, for measuring what Origin's context is worth ──────────
//
// A context bake-off runs the same agent on the same task several times, each
// arm with a different slice of what Origin injects, and compares the results.
// The arm is chosen by ORIGIN_CONTEXT_VARIANT in the agent's environment; the
// hooks run as the agent's children, so they inherit it.
//
//   none        nothing from the repo: no memory, brief, attribution, handoff,
//               prompt retrieval or file cards. The tracking notice and the
//               authoring framework stay — every arm gets those, so they cancel.
//   baseline    the repo-level context a normal session gets (session-start
//               block, prompt-scoped retrieval, the memory nudge), no file cards.
//   file-cards  per-file history cards only.
//   search      nothing injected from the repo, as `none` — only a note that
//               `origin search-history` exists, so the agent can look the
//               history up itself when it decides it needs it. Opt-in: not in
//               the replay harness's default set.
//
// Unset means a normal session: everything, gated as usual.
//
// A bake-off repo normally reads no memory at all (isBakeoffRepo), because
// memory from the repo it was cloned from would make every arm a "with memory"
// arm. When a variant is set, the variant decides instead — the replay harness
// is responsible for giving the clone only the history that existed before the
// task. WRITES stay blocked in bake-off repos either way: an arm's session must
// never become memory for the real repo.

export type ContextVariant = 'none' | 'baseline' | 'file-cards' | 'search';

export const CONTEXT_VARIANTS: readonly ContextVariant[] = ['none', 'baseline', 'file-cards', 'search'];

/** What a replay runs when no --variants are given. `search` is opt-in. */
export const DEFAULT_REPLAY_VARIANTS: readonly ContextVariant[] = ['none', 'baseline', 'file-cards'];

/** The variant this process runs under, or null for a normal session. */
export function contextVariant(env: NodeJS.ProcessEnv = process.env): ContextVariant | null {
  const raw = (env.ORIGIN_CONTEXT_VARIANT || '').trim().toLowerCase();
  return (CONTEXT_VARIANTS as readonly string[]).includes(raw) ? raw as ContextVariant : null;
}

/** May repo-level context (session-start block, retrieval, nudges) be injected? */
export function variantAllowsRepoContext(variant: ContextVariant | null = contextVariant()): boolean {
  return variant === null || variant === 'baseline';
}

/** May per-file history cards be injected? */
export function variantAllowsFileCards(variant: ContextVariant | null = contextVariant()): boolean {
  return variant === null || variant === 'file-cards';
}

/** Should the session be told it can search the repo's history itself? */
export function variantAllowsHistorySearchNote(variant: ContextVariant | null = contextVariant()): boolean {
  return variant === 'search';
}

// What a `search` arm is told in place of the memory a `baseline` arm is
// handed: that the history exists and how to ask it — not what is in it, and
// not that it must look. Whether the agent reaches for it is the measurement.
export const HISTORY_SEARCH_NOTE =
  'Origin keeps a searchable record of this repo\'s history: past sessions, commit records, decisions, ' +
  'open TODOs, and the prompts behind each commit. To look something up, run ' +
  '`origin search-history "<what you want to know>" --json` (ranked by relevance; name the feature, ' +
  'symptom, or file). Useful for why something was done, what was tried before, or what was left open.';
