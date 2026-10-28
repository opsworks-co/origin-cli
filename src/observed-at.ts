/**
 * When this update was BUILT, by our clock, so the server can date the
 * activity it carries by that rather than by when it arrived. Set on the
 * caller's object, and only once: a send that fails is queued as that same
 * object, and its replay — minutes later, from the queue — must still say when
 * the work happened. Race arm f5556b20 (2026-10-14): a prompt-submit update
 * held in the queue for 12 minutes replayed first and stamped its arrival as
 * the session's last activity, past the Stop that ended the turn.
 */
export function stampObservedAt(data: any): void {
  if (data && typeof data === 'object' && !Array.isArray(data) && data.observedAt === undefined) {
    data.observedAt = new Date().toISOString();
  }
}
