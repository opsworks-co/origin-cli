import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { stripCopilotEnvelopes } from './transcript.js';

/**
 * The GitHub Copilot desktop app names a new chat by running a SECOND,
 * throwaway Copilot session in the same working tree (claude-haiku-4.5, one
 * prompt, no tools). It fires the same sessionStart / userPromptSubmitted /
 * agentStop / sessionEnd hooks as the real chat, so Origin registered it as a
 * session of its own: prod 586d9dd8 (2026-09-29) was titled with the naming
 * prompt, stayed RUNNING, and left a state file in the worktree that the git
 * hooks kept as a candidate owner of the real chat's commits.
 *
 * Its only prompt is a fixed template wrapping the user's first message:
 *
 *   Name this session based on the user's first message:
 *
 *   <user_message>
 *   …
 *   </user_message>
 *
 * The template lives in the app binary, so an app update can reword it. The
 * match is on its SHAPE, not its sentence: a short instruction that asks for a
 * name or title of a session / chat / conversation / thread, followed by one
 * message tag (`<user_message>`, `<first_message>`, `<user_request>`, …)
 * that wraps the rest of the prompt. A reworded sentence, or a renamed tag,
 * still matches. A real prompt that merely mentions naming a session does not
 * end in a wrapped message, and pasted markup (`<div>…</div>`) is not a
 * message tag — this drops every hook of the session it matches, so a real
 * chat mistaken for one would not be captured at all.
 */
const WRAPPED_MESSAGE = /^([\s\S]{1,300}?)<([a-z][a-z0-9_-]{0,40})>[\s\S]*<\/\2>$/i;
const MESSAGE_TAG = /message|user|request|prompt|input|query/i;
const ASKS_FOR_A_NAME = /\b(name|title)\b/i;
const OF_A_CHAT = /\b(session|chat|conversation|thread)s?\b/i;

export function isCopilotTitlePrompt(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const m = WRAPPED_MESSAGE.exec(stripCopilotEnvelopes(text));
  if (!m || !MESSAGE_TAG.test(m[2])) return false;
  const instruction = m[1];
  return ASKS_FOR_A_NAME.test(instruction) && OF_A_CHAT.test(instruction);
}

function markerPath(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(os.homedir(), '.origin', 'copilot-title-sessions', key);
}

/** Markers older than this belong to naming sessions long finished. */
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

function pruneOldMarkers(dir: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - MARKER_TTL_MS;
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true }); } catch { /* raced */ }
  }
}

/**
 * True when this Copilot hook belongs to a naming session and must not be
 * captured. The prompt reaches us on userPromptSubmitted (`prompt`) and on
 * sessionStart (`initialPrompt`) — Copilot fires them in either order — and
 * the first one seen marks the session id so its agentStop / sessionEnd,
 * which carry no prompt, are dropped too.
 */
export function skipCopilotTitleSessionHook(input: Record<string, unknown>): boolean {
  const sessionId = [input.session_id, input.sessionId]
    .find((id): id is string => typeof id === 'string' && id.length > 0);
  if (!sessionId) return false;
  const file = markerPath(sessionId);
  if (isCopilotTitlePrompt(input.prompt) || isCopilotTitlePrompt(input.initialPrompt)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      pruneOldMarkers(path.dirname(file));
      fs.writeFileSync(file, '', { mode: 0o600 });
    } catch { /* the prompt still identifies this hook; later ones may slip through */ }
    return true;
  }
  return fs.existsSync(file);
}
