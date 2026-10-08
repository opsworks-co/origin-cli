/**
 * Put Origin's block into a user's existing git hook script right after the
 * shebang line, not at the end. A hook that ends with `exit 0` (or `exec …`)
 * never reaches lines appended after it, so an appended block silently never
 * ran and the repo's commits went uncaptured. Without a shebang the block
 * goes first. `block` is whole lines, each ending in '\n'.
 */
export function insertHookBlockAfterShebang(existing: string, block: string): string {
  if (!existing.startsWith('#!')) return block + existing;
  const nl = existing.indexOf('\n');
  if (nl < 0) return `${existing}\n${block}`;
  return existing.slice(0, nl + 1) + block + existing.slice(nl + 1);
}
