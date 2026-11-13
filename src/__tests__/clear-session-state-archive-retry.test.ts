import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { clearSessionState, getStatePath } from '../session-state.js';

describe('clearSessionState archive replacement', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries a transient Windows refusal before removing the active state', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-clear-'));
    execSync('git init -q', { cwd: repo });
    const tag = 'archivebusy1';
    const statePath = getStatePath(repo, tag);
    const sessionId = 'sess-archive-busy-123456';
    fs.writeFileSync(statePath, JSON.stringify({ sessionId, sessionTag: tag, status: 'ACTIVE', prompts: [] }));
    const archivePath = path.join(tmpHome, '.origin', 'sessions', `${sessionId.slice(0, 12)}.json`);
    const realRename = fs.renameSync.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (to === archivePath && attempts++ < 2) {
        throw Object.assign(new Error('held by Defender'), { code: 'EPERM' });
      }
      return realRename(from, to);
    }) as any);

    clearSessionState(repo, tag);

    expect(attempts).toBe(3);
    expect(JSON.parse(fs.readFileSync(archivePath, 'utf-8')).status).toBe('ENDED');
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('removes the archive temp file when replacement contention outlasts the retry budget', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-clear-'));
    execSync('git init -q', { cwd: repo });
    const tag = 'archivebusy2';
    const statePath = getStatePath(repo, tag);
    const sessionId = 'sess-archive-stuck-123456';
    fs.writeFileSync(statePath, JSON.stringify({ sessionId, sessionTag: tag, status: 'ACTIVE', prompts: [] }));
    const archivePath = path.join(tmpHome, '.origin', 'sessions', `${sessionId.slice(0, 12)}.json`);
    const tmpArchivePath = `${archivePath}.tmp.${process.pid}`;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('target remains held'), { code: 'EPERM' });
    });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 600));

    clearSessionState(repo, tag);

    expect(fs.existsSync(tmpArchivePath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
