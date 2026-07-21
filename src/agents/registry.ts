// ── Agent registry — the ONE table of agent definitions ─────────────────────
//
// hooks.ts historically carried ~37 scattered per-agent branches across ~14
// locations: three copies of the pgrep detection tables, a model-pattern map,
// a bare-brand set, a display-name resolver, and ad-hoc `/gpt|codex|o1-/`
// regexes. Adding an agent meant finding all of them; missing one produced a
// half-supported agent (wrong display name, no process detection, broken
// session reuse).
//
// This registry is Phase A of the adapter extraction: all agent DEFINITION
// DATA lives here, and hooks.ts consumes it. Behavioral extraction (per-agent
// transcript discovery / capture quirks as adapter objects) builds on this in
// later phases. To add an agent today: add ONE entry below (plus, if it needs
// bespoke capture, its discovery functions — still in hooks.ts for now).
//
// The data is a faithful move of the hooks.ts tables — same regexes, same
// strings, same precedence — so behavior is unchanged.

export interface AgentDefinition {
  slug: string;
  // Human name shown on commits/sessions (order in AGENTS matters: composite
  // model strings like "copilot-gpt4" must resolve to Copilot before the
  // generic gpt→Cursor rule fires — see resolveAgentDisplayName).
  displayName: string;
  // Matches this agent's model strings (session↔agent matching).
  modelPattern: RegExp;
  // pgrep pattern used to attribute work to a RUNNING agent process when
  // several sessions are active (post-commit / prepare-commit-msg paths).
  attributionPgrep?: string;
  // pgrep pattern for the no-session standalone detection sweep (post-commit
  // with zero sessions). Narrower list, tuned to CLI binaries only — desktop
  // apps (Cursor/VS Code) have helper processes that would false-positive.
  standalonePgrep?: string;
}

// Order = display-name resolution precedence (specific/composite before
// generic). The final "gpt/o1-/o3-/o4- → Cursor" rule is expressed in
// resolveAgentDisplayName, not here, because it is a fallback, not a match
// for the cursor slug itself.
export const AGENTS: AgentDefinition[] = [
  { slug: 'copilot',  displayName: 'Copilot',     modelPattern: /copilot/i,                      attributionPgrep: 'pgrep -f "copilot.*cli|github-copilot"', standalonePgrep: 'pgrep -f "copilot.*cli|github-copilot"' },
  { slug: 'amp',      displayName: 'Amp',         modelPattern: /amp/i,                          attributionPgrep: 'pgrep -f "amp.*cli|/amp "',              standalonePgrep: 'pgrep -f "amp.*cli|/amp "' },
  { slug: 'junie',    displayName: 'Junie',       modelPattern: /junie|jetbrains/i,              attributionPgrep: 'pgrep -f "junie|jetbrains.*ai"' },
  { slug: 'opencode', displayName: 'Opencode',    modelPattern: /opencode/i,                     attributionPgrep: 'pgrep -f "opencode"',                    standalonePgrep: 'pgrep -f "opencode"' },
  { slug: 'aider',    displayName: 'Aider',       modelPattern: /aider/i,                        attributionPgrep: 'pgrep -f "aider"',                       standalonePgrep: 'pgrep -f "bin/aider|aider.*--model"' },
  { slug: 'devin',    displayName: 'Devin',       modelPattern: /devin|windsurf|codeium|cascade/i, attributionPgrep: 'pgrep -f "devin"' },
  { slug: 'codex',    displayName: 'Codex',       modelPattern: /codex/i,                        attributionPgrep: 'pgrep -f "codex"',                       standalonePgrep: 'pgrep -f "codex"' },
  { slug: 'gemini',   displayName: 'Gemini CLI',  modelPattern: /gemini|google/i,                attributionPgrep: 'pgrep -f "gemini.*cli|/gemini "',        standalonePgrep: 'pgrep -f "gemini.*cli|bin/gemini"' },
  { slug: 'claude',   displayName: 'Claude Code', modelPattern: /claude|anthropic|sonnet|opus|haiku/i, attributionPgrep: 'pgrep -f "claude.*stream-json"',    standalonePgrep: 'pgrep -f "claude.*stream-json"' },
  { slug: 'cursor',   displayName: 'Cursor',      modelPattern: /cursor|composer|gpt|openai/i },
  { slug: 'continue', displayName: 'Continue',    modelPattern: /continue/i,                     attributionPgrep: 'pgrep -f "continue.*dev"' },
  { slug: 'rovo',     displayName: 'Rovo',        modelPattern: /rovo/i,                         attributionPgrep: 'pgrep -f "rovo.*dev"' },
  { slug: 'droid',    displayName: 'Droid',       modelPattern: /droid/i,                        attributionPgrep: 'pgrep -f "droid"' },
];

const BY_SLUG = new Map(AGENTS.map((a) => [a.slug, a]));

export function agentDefinition(slug: string | undefined | null): AgentDefinition | undefined {
  return slug ? BY_SLUG.get(slug.toLowerCase()) : undefined;
}

// Bare agent-brand strings that are NOT real model identifiers — never worth
// persisting over a captured real model ("claude-opus-4-8" etc.).
export const BARE_BRAND_MODELS = new Set([
  'claude', 'gemini', 'cursor', 'codex', 'devin', 'aider',
  'copilot', 'amp', 'opencode', 'continue', 'junie', 'rovo', 'droid',
  'ai', 'unknown', 'default', '',
]);

/**
 * A "specific" model is a real provider model identifier
 * ("claude-opus-4-8", "gemini-2.5-pro", "gpt-5-codex") — i.e. not the bare
 * agent-brand fallback. Used to decide whether a value is worth persisting
 * onto the session record, so we never downgrade a captured real model back
 * to the brand.
 */
export function isSpecificModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return !BARE_BRAND_MODELS.has(model.trim().toLowerCase());
}

/**
 * Does this session belong to the given agent? Stored agentSlug is
 * authoritative; model-pattern matching covers old sessions without one;
 * unknown agents fall back to substring matching.
 */
export function sessionMatchesAgent(
  session: { agentSlug?: string | null; model?: string | null },
  agentSlug: string,
): boolean {
  if (session.agentSlug) {
    return session.agentSlug.toLowerCase() === agentSlug.toLowerCase();
  }
  const model = (session.model || '').toLowerCase();
  const slug = agentSlug.toLowerCase();
  const pattern = BY_SLUG.get(slug)?.modelPattern;
  if (pattern) return pattern.test(model);
  return model.includes(slug) || slug.includes(model);
}

// Codex-family model detection ("shell-based edits, rollout capture"): gpt-*
// and OpenAI reasoning models behave like Codex for capture purposes. This
// regex used to be copy-pasted at every call site.
const CODEX_LIKE_MODEL_RE = /gpt|codex|o1-|o3-|o4-/i;
export function isCodexLikeModel(model: string | undefined | null): boolean {
  return !!model && CODEX_LIKE_MODEL_RE.test(model);
}

/** pgrep checks for attributing a commit to one of several ACTIVE sessions. */
export function attributionPgrepChecks(): Array<{ cmd: string; slug: string }> {
  return AGENTS.filter((a) => a.attributionPgrep)
    .map((a) => ({ cmd: a.attributionPgrep!, slug: a.slug }));
}

/** pgrep checks for detecting a standalone AI process when NO session exists. */
export function standalonePgrepChecks(): Array<{ cmd: string; model: string }> {
  return AGENTS.filter((a) => a.standalonePgrep)
    .map((a) => ({ cmd: a.standalonePgrep!, model: a.slug }));
}

/**
 * Human display name for a session's agent. The slug is authoritative when
 * present — Antigravity runs Gemini models, so resolving by model alone would
 * mislabel it "Gemini CLI". Model matching walks AGENTS in order (composite
 * names like "copilot-gpt4" hit Copilot before the generic gpt→Cursor rule).
 */
export function resolveAgentDisplayName(model: string | undefined, agentSlug?: string): string {
  // The slug is authoritative when present. Copilot and Windsurf run Claude/GPT
  // models, so resolving by model alone mislabels them (a Copilot session on
  // claude-haiku-4.5 came out "Claude Code"; a Codex session on gpt-5 → "Cursor").
  const slug = (agentSlug || '').toLowerCase();
  if (slug) {
    if (slug === 'antigravity') return 'Antigravity';
    // Pipeline slugs like 'claude-code' map to the registry's 'claude' entry.
    const def = BY_SLUG.get(slug === 'claude-code' ? 'claude' : slug);
    if (def) return def.displayName;
  }
  const m = (model || '').toLowerCase();
  if (m.includes('copilot')) return 'Copilot';
  if (m.includes('amp')) return 'Amp';
  if (m.includes('junie')) return 'Junie';
  if (m.includes('opencode')) return 'Opencode';
  if (m.includes('aider')) return 'Aider';
  if (m.includes('devin') || m.includes('windsurf') || m.includes('cascade')) return 'Devin';
  if (m.includes('codex')) return 'Codex';
  if (m.includes('gemini')) return 'Gemini CLI';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return 'Claude Code';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'Cursor';
  return model || 'AI';
}
