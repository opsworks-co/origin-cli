// Deferred backfill of Devin turn data.
//
// Devin writes its ATIF transcript only when a CONVERSATION ends — verified on
// disk: `sweet-duck.json` appeared exactly when the NEXT conversation started,
// and the live conversation had no transcript file at all. So at Stop time
// there is usually nothing to read and the turn lands with no response, no tool
// count and a prompt-text token ESTIMATE (reported: "32 tokens" / "No response
// or code changes captured"). Those turns queue themselves; a later Devin hook
// drains the queue once the transcript exists.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  queueDevinBackfill,
  listDevinBackfills,
  buildDevinBackfillPatch,
  drainDevinBackfills,
  __devinBackfillQueueDir,
  type DevinBackfillRecord,
} from '../devin-backfill.js';

const QUEUE = __devinBackfillQueueDir();

const clearQueue = () => { try { fs.rmSync(QUEUE, { recursive: true, force: true }); } catch { /* ignore */ } };

const rec = (over: Partial<DevinBackfillRecord> = {}): Omit<DevinBackfillRecord, 'queuedAt'> => ({
  sessionId: 'sess-1',
  prompts: ['what the hell is going on here?'],
  startedAt: '2026-07-23T23:26:00Z',
  ...over,
});

beforeEach(clearQueue);
afterEach(clearQueue);

describe('queueDevinBackfill', () => {
  it('queues a real session', () => {
    queueDevinBackfill(rec());
    expect(listDevinBackfills().map((e) => e.rec.sessionId)).toEqual(['sess-1']);
  });

  it('never queues a local-only session or one with no prompts', () => {
    queueDevinBackfill(rec({ sessionId: 'local-abc' }));
    queueDevinBackfill(rec({ sessionId: 'sess-2', prompts: [] }));
    expect(listDevinBackfills()).toEqual([]);
  });
});

describe('buildDevinBackfillPatch', () => {
  const full = {
    model: 'SWE-1.6 Slow', tokensUsed: 39451, inputTokens: 38856, outputTokens: 595,
    cacheReadTokens: 0, toolCalls: 4, prompts: ['p'], transcript: '[{"role":"user"}]',
  };

  it('recovers model, real tokens, tool calls and the response', () => {
    const patch = buildDevinBackfillPatch({ ...rec(), queuedAt: '' } as DevinBackfillRecord, () => full as any);
    expect(patch).toMatchObject({
      model: 'SWE-1.6 Slow', tokensUsed: 39451, inputTokens: 38856,
      outputTokens: 595, toolCalls: 4, transcript: '[{"role":"user"}]',
    });
  });

  it('returns null while the transcript still does not exist (retry later)', () => {
    const patch = buildDevinBackfillPatch({ ...rec(), queuedAt: '' } as DevinBackfillRecord, () => null);
    expect(patch).toBeNull();
  });

  it('omits zero metrics so a PATCH never overwrites good data with zeros', () => {
    const patch = buildDevinBackfillPatch(
      { ...rec(), queuedAt: '' } as DevinBackfillRecord,
      () => ({ ...full, tokensUsed: 0, toolCalls: 0, transcript: undefined }) as any,
    );
    expect(patch).toEqual({ model: 'SWE-1.6 Slow' });
  });
});

describe('drainDevinBackfills', () => {
  it('PATCHes the session and drops the record', async () => {
    queueDevinBackfill(rec());
    // Seed a transcript the discovery will match by prompt.
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-bf-'));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    const dir = path.join(dataHome, 'devin', 'cli', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catkin-lamprey.json'), JSON.stringify({
      schema_version: 'ATIF-v1.7', session_id: 'catkin-lamprey',
      agent: { model_name: 'SWE-1.6 Slow' },
      steps: [
        { source: 'user', message: 'what the hell is going on here?' },
        { source: 'agent', message: 'Here is what is going on.', tool_calls: [{ function_name: 'read' }] },
      ],
      final_metrics: { total_prompt_tokens: '900', total_completion_tokens: '100' },
    }));

    const updateSession = vi.fn().mockResolvedValue({});
    const res = await drainDevinBackfills(updateSession);

    expect(res.patched).toBe(1);
    expect(updateSession).toHaveBeenCalledTimes(1);
    const [id, patch] = updateSession.mock.calls[0];
    expect(id).toBe('sess-1');
    expect(patch).toMatchObject({ model: 'SWE-1.6 Slow', tokensUsed: 1000, toolCalls: 1 });
    expect(String(patch.transcript)).toContain('Here is what is going on.');
    expect(listDevinBackfills()).toEqual([]);   // record consumed

    if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it('keeps the record when the transcript is still absent', async () => {
    queueDevinBackfill(rec({ prompts: ['a prompt in no transcript'] }));
    const updateSession = vi.fn().mockResolvedValue({});
    const res = await drainDevinBackfills(updateSession);
    expect(res.patched).toBe(0);
    expect(updateSession).not.toHaveBeenCalled();
    expect(listDevinBackfills()).toHaveLength(1);   // retried later
  });

  it('expires records older than the retention window', async () => {
    queueDevinBackfill(rec());
    const updateSession = vi.fn().mockResolvedValue({});
    const res = await drainDevinBackfills(updateSession, { now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
    expect(res.expired).toBe(1);
    expect(listDevinBackfills()).toEqual([]);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('is a no-op (and never throws) when the queue is empty', async () => {
    const updateSession = vi.fn();
    await expect(drainDevinBackfills(updateSession)).resolves.toMatchObject({ patched: 0 });
    expect(updateSession).not.toHaveBeenCalled();
  });
});
