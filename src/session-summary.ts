// ─── LLM-synthesized session summaries ───────────────────────────────────────
//
// The heuristic summary (first prompt / commit message) is often weak — a
// multi-turn session collapses to its opening ask, and a chat-heavy turn yields
// "net -54 lines / No summary". This synthesizes a real one-line "what this
// session accomplished" from the session's prompts + files, reusing the repo
// brief's Anthropic key resolution (env → config → local agent-keys → org key).
//
// Opt-in (config.memorySummary = 'llm'), because it makes an external call and
// costs tokens. Returns null whenever it can't produce one — no opt-in, no key,
// no real work, or the call failed — and the caller falls back to the heuristic.
import { callLLM } from './llm.js';
import { resolveAnthropicKey } from './repo-brief.js';
import { loadConfig } from './config.js';
import { api } from './api.js';

const SUMMARY_MODEL = 'claude-sonnet-4-6';
// How much of the code diff to send. Bounded so a large session stays a cheap,
// single, low-latency call — enough for the model to see WHAT changed in code.
const MAX_DIFF_CHARS = 6000;

const SYSTEM_PROMPT =
  'You write a ONE-LINE summary of a coding session for a repo history log. ' +
  'You are given, in order of authority: the user prompts (their intent), the commit messages, ' +
  'and the actual code diff. Ground the summary in what the CODE and COMMITS show was accomplished — ' +
  'the concrete feature, fix, or change — and use the prompts only for intent. ' +
  'Write it concretely and in the imperative, at most ~18 words, naming the main files/area when it clarifies. ' +
  'No preamble, no quotes, no trailing period, no line breaks. Output only the summary line.';

export type MemorySummaryMode = 'heuristic' | 'llm';

export function memorySummaryMode(): MemorySummaryMode {
  return loadConfig()?.memorySummary === 'llm' ? 'llm' : 'heuristic';
}

export interface SessionSummaryInput {
  prompts: string[];
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  // The commit messages this session produced — high-signal intent-of-record.
  commitSubjects?: string[];
  // A (bounded) unified diff of the session's code changes, so the model can
  // summarize from what actually changed, not just prompts/messages.
  diff?: string;
}

export interface SessionSummaryResult {
  summary: string;
  // path → one-line "what changed", so a future agent knows a file's recent
  // change without re-reading the diff. Only the server (org-key) path fills
  // this; the local-key path returns {} (summary only).
  fileNotes: Record<string, string>;
  // Notable decisions/trade-offs the session made (choice + why). Server path only.
  decisions: string[];
}

function hasWork(i: SessionSummaryInput): boolean {
  return (i.filesChanged?.length || 0) > 0 || (i.linesAdded || 0) > 0 || (i.linesRemoved || 0) > 0;
}

/**
 * Synthesize a session summary (+ per-file change notes) via the LLM. Self-
 * gating: returns null unless memorySummary='llm', a key resolves, and the
 * session did real work — so callers can invoke it unconditionally and fall back
 * to the heuristic on null. Never throws.
 */
export async function synthesizeSessionSummary(input: SessionSummaryInput): Promise<SessionSummaryResult | null> {
  try {
    if (memorySummaryMode() !== 'llm') return null;
    if (!hasWork(input)) return null;

    const prompts = (input.prompts || []).filter((p) => p && p.trim()).slice(-6).map((p) => p.slice(0, 400));
    if (prompts.length === 0) return null;

    const key = await resolveAnthropicKey();
    // No CLI-visible key (env / config / local agent-keys / bake-off agent key)?
    // Ask the SERVER to summarize with the org's "AI provider" LLM key — that
    // key is deliberately kept server-only, so this reuses it without shipping it
    // to the machine. The server path also returns per-file change notes. Works
    // only when connected/authed; returns null otherwise (→ heuristic fallback).
    if (!key) return await summarizeViaServer(input);

    const files = (input.filesChanged || []).slice(0, 20).join(', ');
    const commits = (input.commitSubjects || []).map((s) => (s || '').trim()).filter(Boolean).slice(0, 12);
    const diff = (input.diff || '').trim();
    const parts = [
      `Prompts this session (oldest→newest):\n${prompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
    ];
    if (commits.length) parts.push(`Commit messages:\n${commits.map((c) => `- ${c}`).join('\n')}`);
    parts.push(`Files changed: ${files || '(none recorded)'}\nLines: +${input.linesAdded || 0} -${input.linesRemoved || 0}`);
    if (diff) {
      const bounded = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + '\n… (diff truncated)' : diff;
      parts.push(`Code diff:\n${bounded}`);
    }
    const userContent = parts.join('\n\n');

    // callLLM reads the key from the env; point it at the resolved key (which
    // may be the org's) for this call, then restore — same pattern the repo
    // brief uses so we don't thread a key through the shared client.
    const prevEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = key;
    let text: string;
    try {
      text = await callLLM(SYSTEM_PROMPT, [{ role: 'user', content: userContent }], { maxTokens: 80, model: SUMMARY_MODEL });
    } finally {
      if (prevEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevEnv;
    }

    // Collapse to a single clean line; guard against a chatty model.
    const line = (text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    const cleaned = line.replace(/^["'`]|["'`.]$/g, '').trim();
    return cleaned.length >= 3 ? { summary: cleaned.slice(0, 200), fileNotes: {}, decisions: [] } : null;
  } catch {
    return null;
  }
}

// Ask the server to synthesize the summary + per-file notes with the org's
// AI-provider LLM key. Non-fatal: any error (offline, not authed, no org key,
// 5xx) → null so the caller falls back to the heuristic.
async function summarizeViaServer(input: SessionSummaryInput): Promise<SessionSummaryResult | null> {
  try {
    const res = (await api.summarizeSession({
      prompts: input.prompts || [],
      commitSubjects: input.commitSubjects || [],
      filesChanged: input.filesChanged || [],
      linesAdded: input.linesAdded || 0,
      linesRemoved: input.linesRemoved || 0,
      diff: input.diff || '',
    })) as { summary?: string | null; fileNotes?: Record<string, string>; decisions?: string[] };
    const s = (res?.summary || '').trim();
    if (s.length < 3) return null;
    const fileNotes = res?.fileNotes && typeof res.fileNotes === 'object' ? res.fileNotes : {};
    const decisions = Array.isArray(res?.decisions) ? res!.decisions.filter((d) => typeof d === 'string' && d.trim()).slice(0, 8) : [];
    return { summary: s.slice(0, 200), fileNotes, decisions };
  } catch {
    return null;
  }
}
