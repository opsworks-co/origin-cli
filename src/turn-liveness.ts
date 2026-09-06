/**
 * Is the turn that a hook left OPEN still running, according to the
 * transcript — or did it die without a Stop?
 *
 * Claude Code fires Stop when a turn ends normally. A turn that ends in an
 * API error (`529 Overloaded`, `Connection dropped`) or an interrupt fires
 * nothing, so `activeTurn` stays open and the next prompt is treated as
 * queued behind it: every write of the retry is filed under the dead turn,
 * and so is its commit. Prod vodka a219d616: turn 2 died at 14:11 on
 * ECONNRESET; turn 5 at 15:01 wrote eight files and committed, and all of it
 * was attested to turn 2.
 *
 * The transcript says which. Read from the moment the turn opened:
 *   • an assistant API-error entry, or a `[Request interrupted by user]`
 *     entry, as the last thing that happened → DEAD;
 *   • a tool_use with no tool_result yet → ALIVE (a queued prompt during a
 *     running tool is exactly the case the open turn exists to protect);
 *   • otherwise, nothing for `idleMs` → DEAD (a Stop that never came).
 * Plain user text entries at the tail are the new or queued prompt itself and
 * decide nothing.
 */
import fs from 'fs';

export type TurnLiveness = 'alive' | 'dead' | 'unknown';

export function openTurnLiveness(
  transcriptPath: string | null | undefined,
  openedAt: string | number | null | undefined,
  opts: { now?: number; idleMs?: number } = {},
): TurnLiveness {
  if (!transcriptPath) return 'unknown';
  let text = '';
  try { text = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return 'unknown'; }
  const openedMs = typeof openedAt === 'number' ? openedAt : Date.parse(String(openedAt || ''));
  const since = Number.isFinite(openedMs) ? openedMs - 2000 : 0;
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? 120_000;

  const pending = new Set<string>();
  let last: 'error' | 'interrupt' | 'tool_use' | 'tool_result' | 'assistant' | null = null;
  let lastTs = 0;
  let sawAny = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e?.timestamp || '');
    if (Number.isFinite(ts) && ts < since) continue;
    const content = e?.message?.content;
    if (e?.type === 'assistant') {
      sawAny = true;
      if (Number.isFinite(ts)) lastTs = ts;
      if (e.isApiErrorMessage === true) { last = 'error'; continue; }
      let tool = false;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_use' && b.id) { pending.add(b.id); tool = true; }
        }
      }
      last = tool ? 'tool_use' : 'assistant';
    } else if (e?.type === 'user') {
      if (Array.isArray(content)) {
        let result = false;
        for (const b of content) {
          if (b?.type === 'tool_result' && b.tool_use_id) { pending.delete(b.tool_use_id); result = true; }
        }
        if (result) { sawAny = true; if (Number.isFinite(ts)) lastTs = ts; last = 'tool_result'; continue; }
        const texts = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text.trim());
        if (texts.some((t: string) => /^\[Request interrupted by user( for tool use)?\]$/.test(t))) {
          sawAny = true; if (Number.isFinite(ts)) lastTs = ts; last = 'interrupt';
        }
      } else if (typeof content === 'string' && /^\[Request interrupted by user( for tool use)?\]$/.test(content.trim())) {
        sawAny = true; if (Number.isFinite(ts)) lastTs = ts; last = 'interrupt';
      }
    } else if (e?.type === 'system' && e?.subtype === 'api_error') {
      sawAny = true; if (Number.isFinite(ts)) lastTs = ts; last = 'error';
    }
  }
  if (!sawAny) return 'unknown';
  if (last === 'error' || last === 'interrupt') return 'dead';
  if (pending.size > 0) return 'alive';
  if (lastTs > 0 && now - lastTs > idleMs) return 'dead';
  return 'alive';
}
