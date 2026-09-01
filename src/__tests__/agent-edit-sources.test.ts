// Every agent Origin supports must declare WHERE its proof-grade edits come
// from. Before this table there was no such list, and each capture path
// invented its own fallback for an agent it didn't recognise — with the two
// paths disagreeing, and both wrong:
//
//   • the hook path ended its ternary in `: 'claude'`, so Antigravity, Devin,
//     Copilot and Aider all had their session files handed to the Claude Code
//     JSONL parser — a parser for a format none of them writes. It returned
//     nothing, and "nothing" is indistinguishable from a correctly-captured
//     chat-only turn, which is why it never surfaced as a failure.
//   • the watcher path left `promptCaptureAgent` undefined for copilot and
//     antigravity, hit `default: return []`, and produced nothing silently.
//
// The table replaces both guesses with a statement, and these tests pin the
// two properties that matter: it covers every supported agent, and it never
// routes an agent to a parser for someone else's format.
import { describe, it, expect } from 'vitest';
import { AGENT_EDIT_SOURCES, editSourceForAgent } from '../prompt-capture/types.js';
import type { AgentType } from '../commands/enable.js';

// The canonical product list. Kept literal on purpose: importing a derived
// value would let both sides drift together and still agree.
const SUPPORTED: AgentType[] = [
  'claude-code', 'cursor', 'gemini', 'devin', 'codex', 'aider', 'antigravity', 'copilot',
];

describe('AGENT_EDIT_SOURCES', () => {
  it('covers every agent the product supports', () => {
    // The failure this prevents: shipping an agent that captures sessions for
    // months without ever emitting a structured edit, because nothing declares
    // that it has no edit source.
    const missing = SUPPORTED.filter((a) => !AGENT_EDIT_SOURCES[a]);
    expect(missing).toEqual([]);
  });

  it('gives a transcript extractor only to agents whose format we parse', () => {
    // The exact regression: an agent routed to 'claude' whose transcript is not
    // Claude Code JSONL.
    const transcriptAgents = Object.entries(AGENT_EDIT_SOURCES)
      .filter(([, v]) => v.kind === 'transcript')
      .map(([k]) => k)
      .sort();
    expect(transcriptAgents).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'gemini']);
  });

  it('every transcript agent names its extractor, and no other kind does', () => {
    for (const [slug, src] of Object.entries(AGENT_EDIT_SOURCES)) {
      if (src.kind === 'transcript') expect(src.captureAgent, slug).toBeTruthy();
      else expect(src.captureAgent, slug).toBeUndefined();
    }
  });

  it('routes the hook-only agents to the live ledger, not to a parser', () => {
    // Antigravity and Devin both fire PostToolUse, so their edits are recorded
    // as they happen. Returning no transcript captures for them is correct.
    expect(editSourceForAgent('antigravity').kind).toBe('ledger');
    expect(editSourceForAgent('devin').kind).toBe('ledger');
  });

  it('reports the agents that have no edit source at all', () => {
    // Aider is the last agent with no way to witness an edit: no extractor, and
    // no tool-level hook, so its turns can only be inferred from working-tree
    // state — which cannot separate its writes from a sibling agent's or the
    // user's. Documentation of a KNOWN GAP: when Aider gains an edit source,
    // this fails and gets updated.
    //
    // Copilot was here too until its event log turned out to carry full edit
    // payloads (see copilot-prompt-capture.test.ts). That is the intended
    // lifecycle for this assertion.
    expect(editSourceForAgent('aider').kind).toBe('none');
  });

  it('treats an unknown agent as unsupported rather than as Claude', () => {
    // The whole point. A slug nobody has taught the table about must not be
    // handed to some other agent's parser.
    expect(editSourceForAgent('brand-new-agent').kind).toBe('none');
    expect(editSourceForAgent('brand-new-agent').captureAgent).toBeUndefined();
    expect(editSourceForAgent(undefined).kind).toBe('none');
    expect(editSourceForAgent('').kind).toBe('none');
  });

  it('is case-insensitive on the slug', () => {
    expect(editSourceForAgent('Claude-Code').captureAgent).toBe('claude');
  });
});
