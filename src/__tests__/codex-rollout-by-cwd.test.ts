// Regression: Codex sessions never captured on native Windows because Codex
// holds state_*.sqlite open in WAL mode and sql.js reads the raw main .db →
// "database disk image is malformed" → every thread lookup fails → empty
// session → swept. findCodexRolloutByCwd resolves the thread straight from the
// append-only rollout .jsonl on disk, matching cwd separator-insensitively.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findCodexRolloutByCwd } from '../agents/codex.js';

let codexDir = '';

function writeRollout(threadId: string, cwd: string, dateParts: [string, string, string]) {
  const [y, m, d] = dateParts;
  const dir = path.join(codexDir, 'sessions', y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${y}-${m}-${d}T10-00-00-${threadId}.jsonl`);
  const meta = {
    timestamp: `${y}-${m}-${d}T10:00:05.000Z`,
    type: 'session_meta',
    payload: { id: threadId, timestamp: `${y}-${m}-${d}T10:00:00.000Z`, cwd, originator: 'codex_cli_rs' },
  };
  const turn = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n' + JSON.stringify(turn) + '\n');
  return file;
}

describe('findCodexRolloutByCwd', () => {
  beforeEach(() => { codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codexdir-')); });
  afterEach(() => { try { fs.rmSync(codexDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('matches Codex\'s native backslash cwd when Origin passes a forward-slash path', () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, 'C:\\soft\\origin-demo-1', ['2026', '07', '22']);
    // Origin normalizes repoPath to forward slashes:
    const found = findCodexRolloutByCwd(codexDir, 'C:/soft/origin-demo-1');
    expect(found).not.toBeNull();
    expect(found!.path).toBe(file);
    expect(found!.threadId).toBe(tid);
  });

  it('matches a POSIX cwd as-is', () => {
    const tid = '019d0d9c-c097-7c62-a4e4-2b1b2657f89f';
    const file = writeRollout(tid, '/Users/x/code/origin', ['2026', '07', '22']);
    const found = findCodexRolloutByCwd(codexDir, '/Users/x/code/origin');
    expect(found!.path).toBe(file);
    expect(found!.threadId).toBe(tid);
  });

  it('does NOT match a sibling repo whose path merely shares a prefix', () => {
    writeRollout('019f0000-0000-7000-8000-000000000001', 'C:\\soft\\origin-demo-1-backup', ['2026', '07', '22']);
    const found = findCodexRolloutByCwd(codexDir, 'C:/soft/origin-demo-1');
    expect(found).toBeNull();
  });

  it('returns null when no rollout matches the cwd', () => {
    writeRollout('019f0000-0000-7000-8000-000000000002', 'C:\\other\\repo', ['2026', '07', '22']);
    expect(findCodexRolloutByCwd(codexDir, 'C:/soft/origin-demo-1')).toBeNull();
  });
});
