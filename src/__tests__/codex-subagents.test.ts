// Codex sub-agents (`spawn_agent`, multi-agent mode) belong to the chat that
// spawned them.
//
// Each sub-agent runs in a thread of its own with its own rollout. Its
// `session_meta` names the chat (`parent_thread_id`, `source.subagent.
// thread_spawn`), then the rollout REPLAYS the chat's history — the chat's
// prompt and its token_count lines included. Codex fires no SessionStart,
// UserPromptSubmit or Stop for it; its tool hooks carry the CHAT's session_id.
// So it is folded into the chat, as auto-review threads are: never a session
// (the watcher and the by-cwd lookups skip it), its usage counted once in the
// chat, its spawn recorded on the chat.
//
// The fixture pair under fixtures/codex-subagent is a real `codex exec`
// (0.145.0) run, trimmed: the chat runs `ls`, then spawns one sub-agent that
// creates d.txt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  codexParentThreadFromMeta,
  codexParentThreadOf,
  findCodexChildRollouts,
  findCodexRolloutByCwd,
  parseCodexReviewRollout,
  parseCodexRollout,
  parseCodexRolloutLive,
} from '../agents/codex.js';
import { listActiveRollouts } from '../codex-watch.js';
import { buildCodexThreadByCwdQuery } from '../codex-thread-query.js';
import { isSubagentSpawnTool, isSubagentCompanionTool, detectRenamedSpawner } from '../subagent-tools.js';
import { cleanPrompt, codexUserPromptText } from '../transcript.js';
import { mergeCodexSubagentSpawns } from '../commands/hooks/stop.js';
import type { SessionState } from '../session-state.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-subagent');
const DAY = '2026/10/15';
const CHAT_ID = '01a13fe0-9e28-7991-b57e-752570a1d1ad';
const CHILD_ID = '01a13fe0-b43e-7d33-a123-923054790ec5';
const CHAT_NAME = `rollout-2026-10-15T10-04-07-${CHAT_ID}.jsonl`;
const CHILD_NAME = `rollout-2026-10-15T10-04-13-${CHILD_ID}.jsonl`;

let codexDir = '';
let chat = '';
let child = '';

beforeEach(() => {
  // A fresh copy per test: the head classification is cached by path, and the
  // watcher only looks at recently written files.
  codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codex-subagent-'));
  fs.cpSync(FIXTURE, codexDir, { recursive: true });
  chat = path.join(codexDir, 'sessions', DAY, CHAT_NAME);
  child = path.join(codexDir, 'sessions', DAY, CHILD_NAME);
  // The child is written last, as it is live: newest-first finds it first.
  const now = Date.now() / 1000;
  fs.utimesSync(chat, now - 5, now - 5);
  fs.utimesSync(child, now, now);
});
afterEach(() => { fs.rmSync(codexDir, { recursive: true, force: true }); });

describe('which Codex threads are children', () => {
  it('a spawned sub-agent names its chat', () => {
    expect(codexParentThreadOf(child)).toBe(CHAT_ID);
    expect(codexParentThreadOf(chat)).toBeNull();
  });

  it('reads every shape Codex has written', () => {
    // Spawned sub-agent: parent in the source even without the top-level field.
    expect(codexParentThreadFromMeta({
      id: 'c', source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 2 } } }, thread_source: 'subagent',
    })).toBe('p');
    // Auto-review, including the old shape that named the chat as a fork.
    expect(codexParentThreadFromMeta({ id: 'r', parent_thread_id: 'p', source: { subagent: { other: 'guardian' } } })).toBe('p');
    expect(codexParentThreadFromMeta({ id: 'r', forked_from_id: 'p', source: { subagent: { other: 'guardian' } } })).toBe('p');
    // A user's own fork of a chat is a conversation of its own.
    expect(codexParentThreadFromMeta({ id: 'f', forked_from_id: 'p', source: 'vscode' })).toBeNull();
    expect(codexParentThreadFromMeta({ id: 'u', source: 'exec', thread_source: 'user' })).toBeNull();
  });

  it("finds the chat's sub-agents and theirs, not another chat's", () => {
    const grandchild = path.join(codexDir, 'sessions', DAY, 'rollout-grandchild.jsonl');
    fs.writeFileSync(grandchild, JSON.stringify({ type: 'session_meta', payload: {
      id: 'gc-1', parent_thread_id: CHILD_ID, cwd: '/repo',
      source: { subagent: { thread_spawn: { parent_thread_id: CHILD_ID, depth: 2 } } }, thread_source: 'subagent',
    } }) + '\n');
    const stranger = path.join(codexDir, 'sessions', DAY, 'rollout-stranger.jsonl');
    fs.writeFileSync(stranger, JSON.stringify({ type: 'session_meta', payload: {
      id: 's-1', parent_thread_id: 'someone-else', cwd: '/repo', source: { subagent: { thread_spawn: { parent_thread_id: 'someone-else' } } },
    } }) + '\n');
    expect(findCodexChildRollouts(chat, CHAT_ID).sort()).toEqual([child, grandchild].sort());
  });
});

describe("a sub-agent's usage", () => {
  it("counts the sub-agent's own calls, not the chat's replayed one", () => {
    // The child opens with the chat's first call (13,364 tokens) replayed and
    // carries on from that running total.
    const calls = parseCodexReviewRollout(child).map((c) => c.usage);
    expect(calls).toEqual([
      { model: 'gpt-5.6-sol', inputTokens: 15_615 - 11_264, cacheReadTokens: 11_264, outputTokens: 60, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
      { model: 'gpt-5.6-sol', inputTokens: 15_699 - 15_488, cacheReadTokens: 15_488, outputTokens: 13, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
  });

  it('is added to the chat once, on the prompt that spawned it', () => {
    const r = parseCodexRollout(codexDir, chat, CHAT_ID)!;
    // Chat: 53,659 in (50,816 cached), 148 out. Sub-agent: 4,562 + 26,752 cached, 73 out.
    expect(r.inputTokens).toBe(2_843 + 4_562);
    expect(r.cacheReadTokens).toBe(50_816 + 26_752);
    expect(r.outputTokens).toBe(148 + 73);
    expect(r.userPrompts).toHaveLength(1);
    expect(r.turnUsage?.map((t) => t.promptIndex)).toEqual([0]);
  });

  it('the live parser agrees with the Stop parser', () => {
    const live = parseCodexRolloutLive(chat)!;
    const stop = parseCodexRollout(codexDir, chat, CHAT_ID)!;
    expect(live.inputTokens).toBe(stop.inputTokens);
    expect(live.outputTokens).toBe(stop.outputTokens);
    expect(live.cacheReadTokens).toBe(stop.cacheReadTokens);
  });
});

describe("the chat's record of its sub-agents", () => {
  it('the Stop parser lists each spawn_agent call', () => {
    const r = parseCodexRollout(codexDir, chat, CHAT_ID)!;
    expect(r.subagentSpawns).toEqual([
      expect.objectContaining({ toolCallId: 'call_378ea38f998c4dbda5e30dd83569e075', description: 'create_d', subagentType: null, promptIndex: 0 }),
    ]);
  });

  it("the live parser marks the turn, whose patches are not all in the chat's rollout", () => {
    expect(parseCodexRolloutLive(chat)!.spawnedAgentPrompts).toEqual([0]);
  });

  it('Stop records each spawn once on the session', () => {
    const state = { subagentSpawns: [] } as unknown as SessionState;
    const spawns = parseCodexRollout(codexDir, chat, CHAT_ID)!.subagentSpawns;
    mergeCodexSubagentSpawns(state, spawns);
    mergeCodexSubagentSpawns(state, spawns); // the next Stop re-reads the same rollout
    expect(state.subagentSpawns).toHaveLength(1);
    expect(state.subagentSpawns![0]).toMatchObject({ subagentType: null, description: 'create_d', promptIndex: 0 });
  });
});

describe('a sub-agent is never its own session', () => {
  it('the watcher skips its rollout', () => {
    const found = listActiveRollouts(path.join(codexDir, 'sessions'), Date.now());
    expect(found.map((r) => r.threadId)).toEqual([CHAT_ID]);
  });

  it('the disk lookup by cwd returns the chat, though the sub-agent is newer', () => {
    expect(findCodexRolloutByCwd(codexDir, '/repo')).toEqual({ path: chat, threadId: CHAT_ID });
  });

  it('the SQLite lookup by cwd leaves out child threads', () => {
    // threads.source is `{"subagent":{…}}` for a child, a plain string otherwise.
    expect(buildCodexThreadByCwdQuery('id', '/repo')).toContain(`instr(source, '"subagent"') = 0`);
  });
});

describe('Codex sub-agent tool names', () => {
  it('spawn_agent is a spawner, however it is namespaced', () => {
    expect(isSubagentSpawnTool('spawn_agent')).toBe(true);
    expect(isSubagentSpawnTool('collaborationspawn_agent')).toBe(true); // hook payload
    expect(isSubagentSpawnTool('collaboration.spawn_agent')).toBe(true);
    expect(isSubagentSpawnTool('exec')).toBe(false);
  });

  it('wait_agent and friends are companions, so a lost spawner is still noticed', () => {
    expect(isSubagentCompanionTool('collaborationwait_agent')).toBe(true);
    expect(isSubagentCompanionTool('close_agent')).toBe(true);
    expect(detectRenamedSpawner(['collaborationspawn_agent', 'collaborationwait_agent'], 0).broken).toBe(true);
    expect(detectRenamedSpawner(['collaborationwait_agent'], 1).broken).toBe(false);
  });
});

describe('multi-agent envelopes are not prompts', () => {
  const mode = '<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation no longer applies.</multi_agent_mode>';
  const note = '<subagent_notification>{"agent_id":"019f…","status":{"completed":"Created b.txt"}}</subagent_notification>';

  it('are stripped from a Codex message', () => {
    expect(codexUserPromptText(mode)).toBeNull();
    expect(codexUserPromptText(note)).toBeNull();
    expect(codexUserPromptText('<multi_agent_role>worker</multi_agent_role>\nfix the build')).toBe('fix the build');
  });

  it('are stripped by cleanPrompt, closing tag or not', () => {
    expect(cleanPrompt(note)).toBeNull();
    expect(cleanPrompt(`${note}\nnow commit it`)).toBe('now commit it');
    expect(cleanPrompt('<subagent_notification>{"agent_id":"019f…","status":{"compl')).toBeNull();
  });

  it("the fixture's chat has one prompt, the user's", () => {
    expect(parseCodexRolloutLive(chat)!.userPrompts).toEqual([
      "First run the shell command 'ls' yourself. Then use spawn_agent (fork all turns) to start exactly one sub-agent and tell it: create d.txt containing the word world. Wait for it, then reply DONE.",
    ]);
  });
});
