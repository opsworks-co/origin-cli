// Claude Code runs a whole turn on a background job's completion notice
// without firing UserPromptSubmit. The first tool call after the last Stop
// stamps that turn's start (noteToolActivity), and the heartbeat reports it
// (reportedTurnStartedAt), so the dashboard's Agents now panel shows the agent
// working instead of waiting for you. The turn's own Stop closes it as usual.
import { describe, it, expect } from 'vitest';
import { noteToolActivity, reportedTurnStartedAt } from '../heartbeat-liveness.js';

const T = 1_800_000_000_000;

describe('noteToolActivity', () => {
  it('stamps the first tool call after a Stop when no prompt opened a turn', () => {
    const st: any = { currentTurnStartedAt: T, lastTurnClosedAt: T + 60_000 };
    expect(noteToolActivity(st, T + 120_000)).toBe(true);
    expect(st.implicitTurnStartedAt).toBe(T + 120_000);
    expect(reportedTurnStartedAt(st)).toBe(T + 120_000);
  });

  it('keeps the first stamp for the rest of that turn', () => {
    const st: any = { currentTurnStartedAt: T, lastTurnClosedAt: T + 60_000 };
    noteToolActivity(st, T + 120_000);
    expect(noteToolActivity(st, T + 180_000)).toBe(false);
    expect(st.implicitTurnStartedAt).toBe(T + 120_000);
  });

  it('leaves a prompt-opened turn alone', () => {
    const st: any = { currentTurnStartedAt: T + 90_000, lastTurnClosedAt: T + 60_000 };
    expect(noteToolActivity(st, T + 120_000)).toBe(false);
    expect(st.implicitTurnStartedAt).toBeUndefined();
    expect(reportedTurnStartedAt(st)).toBe(T + 90_000);
  });

  it('does nothing before the first Stop (the first prompt turn is open)', () => {
    const st: any = { currentTurnStartedAt: T };
    expect(noteToolActivity(st, T + 5_000)).toBe(false);
    expect(st.implicitTurnStartedAt).toBeUndefined();
  });

  it("the tool-opened turn's Stop closes it: the reported start is older than the close again", () => {
    const st: any = { currentTurnStartedAt: T, lastTurnClosedAt: T + 60_000 };
    noteToolActivity(st, T + 120_000);
    st.lastTurnClosedAt = T + 300_000;          // its Stop
    expect(reportedTurnStartedAt(st)! < st.lastTurnClosedAt).toBe(true);
    // …and the next notice turn stamps afresh.
    expect(noteToolActivity(st, T + 400_000)).toBe(true);
    expect(st.implicitTurnStartedAt).toBe(T + 400_000);
  });

  it('reports nothing for a state with no stamps', () => {
    expect(reportedTurnStartedAt({})).toBeUndefined();
  });
});
