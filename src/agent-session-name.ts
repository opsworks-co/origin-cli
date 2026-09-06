// The name the AGENT gave the conversation.
//
// Every agent that shows a session list names its chats, and users navigate by
// those names. Origin was showing its own LLM-written title for the same
// conversation ("Investigated AI Blame Capture Is…" next to Claude Code's "AI
// blame capture for prompts"), which reads as the two products disagreeing
// about what you did. When the agent has a name, it wins.
//
// Availability is per-agent and was verified against real stores:
//   claude-code  ✓  transcript records {"type":"custom-title","customTitle":…}
//                   (a rename, or the desktop app naming the chat) and
//                   {"type":"ai-title","aiTitle":…} (the title the terminal
//                   REPL generates from the first prompt). Claude Code's own
//                   /resume picker shows customTitle ?? aiTitle; so do we.
//                   A custom title may also sit in a sidecar next to the
//                   transcript: <transcript dir>/<sessionId>/custom-title.json
//   cursor       ✓  state.vscdb → composerHeaders.value.name
//   codex        ✗  rollout files carry no conversation title (the `summary`
//                   fields there are reasoning traces, not names)
//   antigravity  ✗  brain transcripts carry tool names only
//
// Returning null is the normal path for the last two — they keep the aiTitle.

import fs from 'fs';
import path from 'path';
import os from 'os';

/** Reject junk before it reaches a UI: blanks, absurd lengths, control chars. */
function clean(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Agents cap their own titles well under this; anything longer is a bug or a
  // pasted prompt body, and a whole prompt in the name column is worse than
  // falling back to the aiTitle.
  if (t.length > 200) return null;
  return t;
}

/** Everything Claude Code has recorded as this conversation's name. */
export interface ClaudeSessionTitles {
  /** The transcript exists and was readable. */
  transcriptRead: boolean;
  /** Last `custom-title` record in the transcript — null when none, or when the last one cleared the title. */
  customTitle: string | null;
  /** Whether any `custom-title` record was seen at all (a cleared title still counts). */
  hasCustomTitleRecord: boolean;
  /** `<transcript dir>/<sessionId>/custom-title.json`, when present. */
  sidecarTitle: string | null;
  /** Last `ai-title` record — the auto-generated title. */
  aiTitle: string | null;
}

/**
 * Read every title source Claude Code keeps for one transcript.
 *
 * Both record types are rewritten on change — Claude Code itself treats them
 * as "last-wins" — so the LAST record of each kind is current, and one
 * backward scan finds both. Exposed separately from claudeSessionName so a
 * caller that ends up with no name can log WHICH sources were empty: the
 * Windows sessions that shipped nameless for weeks were indistinguishable in
 * hooks.log from sessions nobody had named.
 */
export function claudeSessionTitles(transcriptPath: string): ClaudeSessionTitles {
  const out: ClaudeSessionTitles = { transcriptRead: false, customTitle: null, hasCustomTitleRecord: false, sidecarTitle: null, aiTitle: null };
  if (!transcriptPath) return out;
  try {
    if (!fs.existsSync(transcriptPath)) return out;
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    out.transcriptRead = true;
    let sawAi = false;
    // Scan backwards: the title is rewritten on rename, and these files run to
    // tens of thousands of lines. Stop once both kinds have been seen.
    for (let i = lines.length - 1; i >= 0 && !(out.hasCustomTitleRecord && sawAi); i--) {
      const line = lines[i];
      if (!line) continue;
      const isCustom = !out.hasCustomTitleRecord && line.indexOf('custom-title') !== -1;
      const isAi = !sawAi && line.indexOf('ai-title') !== -1;
      if (!isCustom && !isAi) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type === 'custom-title' && !out.hasCustomTitleRecord) {
          // The newest record wins even when it is blank: a blank one is how
          // Claude Code records "title cleared", and an older non-blank record
          // behind it is stale, not a fallback.
          out.hasCustomTitleRecord = true;
          out.customTitle = clean(rec.customTitle);
        } else if (rec?.type === 'ai-title' && !sawAi) {
          sawAi = true;
          out.aiTitle = clean(rec.aiTitle);
        }
      } catch { /* partial line mid-write — keep scanning */ }
    }
  } catch { /* an unreadable transcript is not worth failing a session over */ }
  // Claude Code also persists a custom title beside the transcript (and reads
  // it back from there), keyed by the session id the transcript is named for.
  try {
    const sidecar = path.join(
      path.dirname(transcriptPath),
      path.basename(transcriptPath, path.extname(transcriptPath)),
      'custom-title.json',
    );
    if (fs.existsSync(sidecar)) {
      out.sidecarTitle = clean(JSON.parse(fs.readFileSync(sidecar, 'utf8'))?.customTitle);
    }
  } catch { /* a torn or absent sidecar is not a name */ }
  return out;
}

/**
 * The name Claude Code shows for this conversation: the user's own title when
 * there is one, otherwise the title Claude Code generated — the same
 * precedence as its /resume picker. A transcript whose newest custom-title
 * record is blank has had its title cleared, so the sidecar (which Claude Code
 * deletes on clear) is consulted only when the transcript carries no
 * custom-title record at all.
 */
export function claudeSessionName(transcriptPath: string): string | null {
  const t = claudeSessionTitles(transcriptPath);
  if (t.customTitle) return t.customTitle;
  if (!t.hasCustomTitleRecord && t.sidecarTitle) return t.sidecarTitle;
  return t.aiTitle;
}

function cursorStatePath(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * Cursor keeps one row per composer in `composerHeaders`, whose `value` JSON
 * carries the chat name. A composer that hasn't been named yet has no `name`
 * key at all — that's a null here, not an empty string.
 *
 * `query` is injected (the CLI's querySqlite) because that wrapper falls back
 * to a WASM backend on Windows; it returns a delimited STRING, not rows, and
 * takes no bind parameters — hence the manual quote-escaping below.
 */
export function cursorSessionName(
  composerId: string,
  query: (dbPath: string, sql: string, opts?: { separator?: string; timeoutMs?: number }) => string,
  // Injectable so the parsing is testable on a machine with no Cursor
  // install — locating the file and reading it are separate concerns, and
  // only one of them is worth a test.
  dbPathOverride?: string,
): string | null {
  const dbPath = dbPathOverride ?? cursorStatePath();
  if (!dbPath || !composerId) return null;
  // querySqlite has no bind-parameter support, so the id goes inline. Composer
  // ids are UUIDs, but doubling any quote keeps a malformed one from ending
  // the literal rather than trusting the shape.
  const safeId = composerId.replace(/'/g, "''");
  try {
    const raw = query(
      dbPath,
      `SELECT value FROM composerHeaders WHERE composerId = '${safeId}' LIMIT 1`,
      { separator: '\u0001' },
    );
    if (!raw || !raw.trim()) return null;
    return clean(JSON.parse(raw.trim())?.name);
  } catch {
    // Cursor holds a write lock while it saves; a failed read here just means
    // "no name this heartbeat", and the next one picks it up.
    return null;
  }
}
