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

/**
 * Claude Code writes the sidebar title into the transcript as its own record
 * type, rewritten on every rename — so the LAST one is current.
 */
export function claudeSessionName(transcriptPath: string): string | null {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    // Scan backwards: the title is rewritten on rename, and these files run to
    // tens of thousands of lines.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.indexOf('custom-title') === -1) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type === 'custom-title') {
          const name = clean(rec.customTitle);
          if (name) return name;
        }
      } catch { /* partial line mid-write — keep scanning */ }
    }
  } catch { /* an unreadable transcript is not worth failing a session over */ }
  return null;
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
