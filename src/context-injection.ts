// ─── Session-start repo-context assembly ─────────────────────────────────────
//
// Origin injects several overlapping context blocks at session start:
//   - repo brief        → what the repo IS (opt-in, LLM)
//   - attribution       → commit-level "X% AI", recent AI activity, top AI files
//   - session memory    → session-level "what past sessions did" + hot files + TODOs
//   - handoff           → the last session's in-progress work
//
// Attribution and memory BOTH carry a "recent work" list and a "hot files" list,
// derived differently (commits vs sessions). Injecting both makes the agent
// reconcile two near-duplicate lists (the "four flattened blocks" problem). This
// assembler deduplicates: when memory is present it supersedes attribution's
// activity/file lists, so we keep only attribution's unique signal — the
// one-line AI-authorship headline. Blocks are ordered what-it-IS → AI% →
// what-sessions-DID → in-progress so the agent reads a single coherent section.

/**
 * First line of the attribution block — the "Repository AI context: X% of recent
 * commits (n/m) are AI-generated." headline, which is its unique contribution
 * once memory covers recent work + hot files. Pure + exported for testing.
 */
export function attributionHeadline(attribution: string): string {
  return attribution.split('\n')[0].trim();
}

/**
 * Assemble the deduplicated repo-context section from the individual rendered
 * blocks. Returns null when there is nothing to inject. Pure — the hook resolves
 * each block (with its own error handling) and passes the strings in.
 */
export function assembleRepoContext(blocks: {
  brief?: string | null;
  attribution?: string | null;
  memory?: string | null;
  handoff?: string | null;
}): string | null {
  const brief = (blocks.brief || '').trim();
  let attribution = (blocks.attribution || '').trim();
  const memory = (blocks.memory || '').trim();
  const handoff = (blocks.handoff || '').trim();

  // Memory (session-level) supersedes attribution's commit-level activity/file
  // lists. Keep only attribution's AI-authorship headline to avoid two
  // redundant recent-work + hot-file lists.
  if (attribution && memory) {
    attribution = attributionHeadline(attribution);
  }

  const ordered = [brief, attribution, memory, handoff].filter(Boolean);
  if (ordered.length === 0) return null;
  return ordered.join('\n\n');
}
