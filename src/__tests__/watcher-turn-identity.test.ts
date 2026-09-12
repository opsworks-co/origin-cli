// `promptIndex` is a POSITION, and a position moves. The hook path learned that
// and mints a `turnId` at submission; the watcher never did — every row it wrote
// was identified by its loop index alone.
//
// That matters more for the watcher than for anything else, because it re-sends
// EVERY prompt on EVERY poll. Once the transcript renumbers — a lost middle
// prompt, a resume, a mid-turn interjection, all of which have shipped fixes —
// position i addresses a different turn, and the server writes there through
// @@unique([sessionId, promptIndex]). That is the mechanism behind "a resumed
// conversation wrote its turns onto turn one's row".
//
// It also matters most on Windows, where GUI agents fire no hooks at all: the
// watcher is the only capture path there, so before this there was no stable
// turn identity on that platform at all.
import { describe, it, expect } from 'vitest';
import { assignTurnIds } from '../transcript-watch.js';

// Deterministic ids so the assertions describe behaviour, not randomness.
const ids = () => { let n = 0; return () => `id${++n}`; };

describe('assignTurnIds', () => {
  it('mints one id per prompt on first sight', () => {
    const out = assignTurnIds(undefined, ['first', 'second'], ids());
    expect(out.map((t) => t.turnId)).toEqual(['id1', 'id2']);
  });

  it('never re-mints across polls', () => {
    // The watcher re-parses the whole transcript every 8 seconds. If identity
    // were re-derived each time, the row would move on every poll.
    const first = assignTurnIds(undefined, ['a', 'b'], ids());
    const second = assignTurnIds(first, ['a', 'b'], ids());
    expect(second.map((t) => t.turnId)).toEqual(first.map((t) => t.turnId));
  });

  it('keeps identity when the transcript loses a middle prompt', () => {
    // THE case this exists for. Positions shift; identity must not. Without it
    // the row that was index 2 silently becomes index 1 and the server
    // overwrites a different turn.
    const before = assignTurnIds(undefined, ['a', 'b', 'c'], ids());
    const cId = before[2].turnId;
    const after = assignTurnIds(before, ['a', 'c'], ids());
    expect(after).toHaveLength(2);
    expect(after[1].turnId).toBe(cId);          // 'c' kept its identity...
    expect(after[1].promptKey).toBe('c');        // ...at a NEW position
  });

  it('gives a repeated prompt its own id rather than reusing one', () => {
    // Prompt text repeats constantly ("try again"). A content-derived id would
    // give two genuinely different turns the same identity, which is worse than
    // the positional bug — it merges turns instead of shifting them.
    const out = assignTurnIds(undefined, ['try again', 'try again'], ids());
    expect(out[0].turnId).not.toBe(out[1].turnId);
  });

  it('matches repeats in order across polls', () => {
    const first = assignTurnIds(undefined, ['go', 'go'], ids());
    const second = assignTurnIds(first, ['go', 'go'], ids());
    expect(second.map((t) => t.turnId)).toEqual(first.map((t) => t.turnId));
  });

  it('mints only for genuinely new prompts as the session grows', () => {
    const first = assignTurnIds(undefined, ['a'], ids());
    const grow = ids();
    const second = assignTurnIds(first, ['a', 'b'], grow);
    expect(second[0].turnId).toBe(first[0].turnId);
    expect(second[1].turnId).toBe('id1');   // only ONE new id was minted
  });

  it('normalizes prompt text the same way the hook path does', () => {
    // Both paths must agree on what "the same prompt" means, or they disagree
    // about which turn a capture belongs to — the exact class this prevents.
    // promptKey collapses whitespace, so these are one prompt seen twice.
    const first = assignTurnIds(undefined, ['do   the\n thing'], ids());
    const second = assignTurnIds(first, ['do the thing'], ids());
    expect(second[0].turnId).toBe(first[0].turnId);
  });

  it('treats a Cursor [Image]-wrapped prompt as the same turn as the inner text', () => {
    const inner = "why the PR doesn't have this session linked";
    const wrapped = `[Image]\n${inner}\n[image]`;
    const first = assignTurnIds(undefined, [wrapped], ids());
    const second = assignTurnIds(first, [inner], ids());
    expect(second).toHaveLength(1);
    expect(second[0].turnId).toBe(first[0].turnId);
  });

  it('handles an empty session without inventing turns', () => {
    expect(assignTurnIds(undefined, [], ids())).toEqual([]);
    expect(assignTurnIds([], [], ids())).toEqual([]);
  });
});
