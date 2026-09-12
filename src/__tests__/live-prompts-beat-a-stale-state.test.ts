// A commit made mid-turn was attributed to the PREVIOUS turn, every time the
// turn's `user-prompt-submit` had been killed before it wrote `state.prompts`.
//
// Prod 376378e3 — measured mid-turn, while the turn below was running:
//
//   state.prompts      27   last = "yes"
//   transcript prompts 28   last = "fix the write-side lag"   ← in flight
//   activeTurn.index   26   (points at "yes")
//
// So the two readers that run at `git commit` both answered 26:
//   • resolvePromptForCommit returns `state.prompts.length - 1`
//   • buildOriginTrailers takes `state.prompts?.length` and the trailer's
//     count IS the ordinal the server anchors on
// They agree, so post-commit's "attested turn disagreed with the attributed
// one" reconciliation never fires and nothing catches it. Three commits in one
// session landed one turn early this way: 93fb6335 (trailer said 12, turn 13),
// c9f08424 (20, turn 21), 17776dd6 (22, turn 23).
//
// That hook is killed because it exceeds the agent's timeout during its git
// work — the same session logged 5 `prompt saved` events across 24 prompts.
// The agent writes the transcript itself, so the in-flight prompt is always
// there.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { livePrompts } from '../transcript.js';

let dir: string;
const STARTED = '2026-09-10T10:00:00.000Z';

function userLine(text: string, ts: string) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}
function assistantLine(ts: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
}

function writeTranscript(prompts: string[], startHour = 10): string {
  const p = path.join(dir, 'transcript.jsonl');
  const lines: string[] = [];
  prompts.forEach((text, i) => {
    const ts = `2026-09-10T${String(startHour + i).padStart(2, '0')}:30:00.000Z`;
    lines.push(userLine(text, ts));
    lines.push(assistantLine(ts));
  });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('livePrompts — the transcript wins when state.prompts is behind', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-live-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('returns the in-flight prompt the killed submit hook never stored', () => {
    const transcriptPath = writeTranscript(['one', 'two', 'three']);
    const state = { prompts: ['one', 'two'], transcriptPath, startedAt: STARTED };

    const live = livePrompts(state);
    expect(live.length).toBe(3);
    expect(live[live.length - 1]).toBe('three');
    // The committing turn is now index 2, not 1 — the whole point.
    expect(live.length - 1).toBe(2);
  });

  it('never shrinks the stored list when the transcript is behind', () => {
    // A rolled or lagging transcript must not renumber turns that already have
    // server rows — state.prompts is the durable record.
    const transcriptPath = writeTranscript(['one']);
    const state = { prompts: ['one', 'two', 'three'], transcriptPath, startedAt: STARTED };
    expect(livePrompts(state)).toEqual(['one', 'two', 'three']);
  });

  it('leaves a healthy session exactly as it was', () => {
    const transcriptPath = writeTranscript(['one', 'two']);
    const state = { prompts: ['one', 'two'], transcriptPath, startedAt: STARTED };
    expect(livePrompts(state)).toEqual(['one', 'two']);
  });

  it('counts only THIS conversation when a resume replays the parent history', () => {
    // A resumed Claude session's transcript carries the parent's turns too.
    // Scoping by startedAt is what stops the count overshooting into them.
    const transcriptPath = writeTranscript(['parent a', 'parent b', 'mine 1', 'mine 2'], 8);
    // Session started after the two parent prompts (08:30, 09:30).
    const state = { prompts: ['mine 1'], transcriptPath, startedAt: '2026-09-10T10:00:00.000Z' };
    const live = livePrompts(state);
    expect(live).toEqual(['mine 1', 'mine 2']);
    expect(live.length).toBe(2);
  });

  it('decides nothing when the transcript is missing or unreadable', () => {
    expect(livePrompts({ prompts: ['a', 'b'], transcriptPath: path.join(dir, 'nope.jsonl'), startedAt: STARTED }))
      .toEqual(['a', 'b']);
    expect(livePrompts({ prompts: ['a'], transcriptPath: null, startedAt: STARTED })).toEqual(['a']);
    expect(livePrompts({})).toEqual([]);
  });
});
