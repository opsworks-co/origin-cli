// Copilot fires no tool-level hook — its hook document registers sessionStart /
// userPromptSubmitted / agentStop / sessionEnd and nothing else — and until now
// it had no transcript extractor either. So no Copilot edit was ever witnessed:
// its turns could only be inferred from working-tree state, which cannot tell
// the agent's writes from a sibling agent's or from the user's own.
//
// Its event log turns out to carry everything needed. The fixture here is
// derived from a REAL session (~/.copilot/session-state/<id>/events.jsonl),
// trimmed in length but not in shape, because every property this extractor
// depends on is a quirk of the actual format rather than something the docs
// would tell you.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { capturePromptEdits } from '../prompt-capture/index.js';
import { editSourceForAgent } from '../prompt-capture/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'copilot-events.jsonl');
// The absolute paths in the fixture live under this root; the extractor makes
// them repo-relative against it.
const REPO = '/Users/artemdolobanko/copilot-worktrees/origin-demo-1/artemdolobanko-sturdy-broccoli';

const capture = () => capturePromptEdits({ agent: 'copilot', repoPath: REPO, transcriptPath: FIXTURE });

describe('Copilot prompt capture', () => {
  it('is now declared as a transcript agent', () => {
    // The counterpart to agent-edit-sources.test.ts, which asserted this was a
    // KNOWN GAP. Closing the gap is what flips it.
    const src = editSourceForAgent('copilot');
    expect(src.kind).toBe('transcript');
    expect(src.captureAgent).toBe('copilot');
  });

  it('splits turns on user.message, not on turnId', () => {
    // turnId RESETS per prompt — one real session runs 6,8,10 under prompt 0
    // and then 3,5 under prompt 1. Using it as promptIndex would interleave
    // every turn's edits with every other turn's.
    const caps = capture();
    expect(caps.length).toBeGreaterThan(1);
    expect(caps.map((c) => c.promptIndex)).toEqual(caps.map((_, i) => i));
  });

  it('reads the user\'s text, not the injected workspace envelope', () => {
    // `transformedContent` wraps the prompt in <copilot_tauri_workspace>…;
    // reading that is what made Copilot prompts duplicate (#1188).
    const first = capture()[0];
    expect(first.promptText).toBe('create some nice code');
    expect(first.promptText).not.toContain('copilot_tauri_workspace');
  });

  it('recovers apply_patch from character-indexed arguments', () => {
    // Copilot serializes the patch STRING as {0:'*',1:'*',2:'*',…}. A plain
    // `args.patch` read finds nothing at all, so this is the difference between
    // capturing every apply_patch edit and capturing none of them.
    const edits = capture().flatMap((c) => c.edits);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => !!e.file)).toBe(true);
  });

  it('marks every witnessed edit as tool_call evidence', () => {
    // The whole point of the extractor: these are PROOF, not the working-tree
    // inference Copilot was limited to. parseApplyPatch is shared with Codex and
    // stamps no evidence of its own, so the caller has to.
    const edits = capture().flatMap((c) => c.edits);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.evidence === 'tool_call')).toBe(true);
    expect(edits.every((e) => e.source === 'tool_call')).toBe(true);
  });

  it('makes paths repo-relative', () => {
    const edits = capture().flatMap((c) => c.edits);
    expect(edits.every((e) => !e.file.startsWith('/'))).toBe(true);
  });

  it('leaves a chat-only turn empty instead of borrowing a neighbour\'s work', () => {
    // The fixture's "normalno ebashim?" turn made no edits. An extractor that
    // grouped by anything other than prompt order would hand it the next turn's.
    const caps = capture();
    const chatOnly = caps.find((c) => c.promptText.startsWith('normalno'));
    expect(chatOnly).toBeDefined();
    expect(chatOnly!.edits).toEqual([]);
  });

  it('drops a tool call the log records as failed', () => {
    // A rejected edit is not authored work. Capturing one is how a turn read
    // +240 against git's +124 (#1249). Copilot reports success/error on
    // tool.execution_complete, joinable by toolCallId — so this class is
    // avoidable here from the start.
    const events = [
      { type: 'user.message', data: { content: 'do it' } },
      { type: 'tool.execution_start', data: { toolCallId: 'ok1', toolName: 'create', arguments: { path: `${REPO}/kept.txt`, file_text: 'kept\n' } } },
      { type: 'tool.execution_start', data: { toolCallId: 'bad1', toolName: 'create', arguments: { path: `${REPO}/rejected.txt`, file_text: 'nope\n' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'ok1', success: true } },
      { type: 'tool.execution_complete', data: { toolCallId: 'bad1', success: false, error: 'permission denied' } },
    ];
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-copilot-'));
    const p = path.join(dir, 'events.jsonl');
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    try {
      const caps = capturePromptEdits({ agent: 'copilot', repoPath: REPO, transcriptPath: p });
      const files = caps.flatMap((c) => c.edits).map((e) => e.file);
      expect(files).toContain('kept.txt');
      expect(files).not.toContain('rejected.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for a missing transcript rather than throwing', () => {
    expect(capturePromptEdits({ agent: 'copilot', repoPath: REPO, transcriptPath: '/does/not/exist.jsonl' })).toEqual([]);
  });
});
