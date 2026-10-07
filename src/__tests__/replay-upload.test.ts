import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { armForUpload, groupByRepo, readLocalReplayRuns } from '../replay-upload.js';
import type { ArmResult } from '../context-replay.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const arm = (over: Partial<ArmResult> = {}): ArmResult => ({
  runId: '2026-09-29-7748c3', taskId: 'gzip', variant: 'none', repeat: 2,
  agentOk: true, testsPassed: true, costUsd: 1, turns: 10, durationMs: 1000,
  inputTokens: 1, outputTokens: 2, filesChanged: [], fileRecall: null,
  finishedAt: '2026-09-29T10:00:00.000Z', ...over,
});

describe('replay upload', () => {
  it('reads every run on disk, oldest first, skipping a torn last line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-replay-upload-'));
    dirs.push(root);
    const write = (runId: string, text: string) => {
      fs.mkdirSync(path.join(root, 'runs', runId), { recursive: true });
      fs.writeFileSync(path.join(root, 'runs', runId, 'results.jsonl'), text);
    };
    write('2026-09-30-e29d65', JSON.stringify(arm({ runId: '2026-09-30-e29d65' })) + '\n{"runId":"2026-09-30-e29');
    write('2026-09-29-7748c3', [arm(), arm({ variant: 'baseline' })].map((a) => JSON.stringify(a)).join('\n') + '\n');
    fs.mkdirSync(path.join(root, 'runs', '2026-09-29-empty'), { recursive: true });

    const runs = readLocalReplayRuns(root);
    expect(runs.map((r) => [r.runId, r.arms.length])).toEqual([['2026-09-29-7748c3', 2], ['2026-09-30-e29d65', 1]]);
  });

  it('finds nothing when no run was ever made', () => {
    expect(readLocalReplayRuns(path.join(os.tmpdir(), 'origin-replay-upload-missing'))).toEqual([]);
  });

  it('names an arm from a run written before arm names were recorded', () => {
    expect(armForUpload(arm()).armName).toBe('gzip-none-2');
    expect(armForUpload(arm({ armName: 'kept' })).armName).toBe('kept');
  });

  it('keeps the local repo path off the wire', () => {
    expect(armForUpload(arm({ sourceRepo: '/Users/me/origin' }))).not.toHaveProperty('sourceRepo');
  });

  it('groups arms by the repo they replayed, older arms under the fallback', () => {
    const groups = groupByRepo([arm({ sourceRepo: '/a' }), arm(), arm({ sourceRepo: '/b' })], '/cwd');
    expect([...groups.entries()].map(([k, v]) => [k, v.length])).toEqual([['/a', 1], ['/cwd', 1], ['/b', 1]]);
    expect([...groupByRepo([arm()]).keys()]).toEqual([null]);
  });
});
