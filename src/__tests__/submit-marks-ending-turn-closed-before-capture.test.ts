// user-prompt-submit ends the previous turn when Stop never did (an agent
// that never opens one, or a turn that died). It stamped that turn's captured
// row mid-hook but recorded the close only in its final save, so a heartbeat
// tick in between still read the turn as open, re-derived it and out-stamped
// the observed capture (Origin TODO 4e29fb67). Stop has the same guard
// (markTurnClosedOnDisk before it stamps); this pins it for the submit hook.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks', 'user-prompt-submit.ts'), 'utf-8',
);
const body = src.slice(src.indexOf('export async function handleUserPromptSubmit'));

describe('user-prompt-submit closes the ending turn on disk before it stamps the capture', () => {
  it('marks before the previous turn\'s row is stamped, and before the save', () => {
    const mark = body.indexOf('markTurnClosedOnDisk(');
    const stamp = body.indexOf('stampCaptured(prevMapping)');
    const save = body.indexOf('saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);');
    expect(mark).toBeGreaterThan(0);
    expect(stamp).toBeGreaterThan(mark);
    expect(save).toBeGreaterThan(mark);
  });

  it('closes exactly the turn it marked: the dead-turn close reuses the one decision', () => {
    // One liveness read, before the capture — a second read at the save could
    // disagree with the mark and leave a live turn marked closed.
    expect(body.match(/openTurnLiveness\(/g)?.length).toBe(1);
    expect(body).toContain('if (openTurnDead && state.activeTurn && state.activeTurn.index === openTurn!.index)');
  });
});
