/** A request the fake API recorded. */
export type RecordedHit = { method: string; url?: string; body: any };

/**
 * The turn rows ONE producer sent after `since` (an index into `hits`), for
 * one `promptIndex`, in send order.
 *
 * Every send stamps its rows with a `captureId` whose prefix names the
 * producer (`afe_` after-file-edit, `hb_` heartbeat, `w_` transcript watch …;
 * see capture-stamp.ts). The index window alone does not name a producer:
 * `user-prompt-submit` sends fire-and-forget, and a heartbeat or watcher can
 * land a PATCH inside the window under load, with the same `promptIndex` and
 * a different view of the tree. Selecting by content (file names, diff) would
 * make the assertion that follows a tautology, so only provenance is used.
 */
export function rowsFromProducer(hits: ReadonlyArray<RecordedHit>, since: number, promptIndex: number, prefix: string): any[] {
  return hits.slice(since)
    .filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges))
    .flatMap((h) => h.body.promptChanges)
    .filter((r: any) => r?.promptIndex === promptIndex && typeof r.captureId === 'string' && r.captureId.startsWith(`${prefix}_`));
}
