// Repo brief P0 — the deterministic pieces (context bundle, content signature,
// shared-git-note cache, staleness). The LLM call itself (generateRepoBrief) is
// network and covered by manual/E2E, not unit tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildRepoContextBundle, computeRepoSignature,
  writeRepoBrief, readRepoBrief, clearRepoBrief, isRepoBriefStale,
  shouldAttemptBriefGeneration,
  type RepoBrief,
} from '../repo-brief.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('repo-brief (P0)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-brief-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Widget\nA thing that widgets.\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial widget scaffold');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  const brief = (over?: Partial<RepoBrief>): RepoBrief => ({
    version: 1, brief: 'Widget is a TS lib. Entry: src.ts. No gotchas.',
    signature: computeRepoSignature(repo), generatedAt: new Date().toISOString(), model: 'claude-sonnet-4-6', ...over,
  });

  it('bundle includes README, manifest, tracked files, and recent commits', () => {
    const b = buildRepoContextBundle(repo);
    expect(b).toContain('# README');
    expect(b).toContain('A thing that widgets');
    expect(b).toContain('# package.json');
    expect(b).toContain('"name": "widget"');
    expect(b).toContain('# Tracked files');
    expect(b).toContain('src.ts');
    expect(b).toContain('# Recent commits');
    expect(b).toContain('initial widget scaffold');
  });

  it('signature is stable but changes when a manifest changes', () => {
    const s1 = computeRepoSignature(repo);
    expect(computeRepoSignature(repo)).toBe(s1); // stable
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'widget', version: '2.0.0' }));
    git(repo, 'commit', '-aqm', 'bump');
    expect(computeRepoSignature(repo)).not.toBe(s1); // drifted
  });

  it('cache round-trips through the shared git note', () => {
    expect(readRepoBrief(repo)).toBeNull();
    const b = brief();
    writeRepoBrief(repo, b);
    const got = readRepoBrief(repo);
    expect(got?.brief).toBe(b.brief);
    expect(got?.version).toBe(1);
    // stored on the well-known ref
    expect(git(repo, 'notes', '--ref=origin-repo-brief', 'list')).not.toBe('');
    expect(clearRepoBrief(repo)).toBe(true);
    expect(readRepoBrief(repo)).toBeNull();
  });

  it('staleness: missing → stale; matching signature → fresh; drift → stale', () => {
    expect(isRepoBriefStale(repo, null)).toBe(true);
    const fresh = brief();
    writeRepoBrief(repo, fresh);
    expect(isRepoBriefStale(repo, fresh)).toBe(false);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'widget', version: '9.9.9' }));
    git(repo, 'commit', '-aqm', 'bump2');
    expect(isRepoBriefStale(repo, fresh)).toBe(true); // signature no longer matches
  });
});

describe('shouldAttemptBriefGeneration (P1 background trigger)', () => {
  const DEBOUNCE = 6 * 60 * 60 * 1000;
  const base = { enabled: true, skipRepo: false, stale: true, lastAttemptMs: 0, nowMs: DEBOUNCE + 1 };

  it('fires when enabled, trackable, stale, and outside the debounce window', () => {
    expect(shouldAttemptBriefGeneration(base)).toBe(true);
  });
  it('does NOT fire when disabled', () => {
    expect(shouldAttemptBriefGeneration({ ...base, enabled: false })).toBe(false);
  });
  it('does NOT fire for bake-off / ignored repos', () => {
    expect(shouldAttemptBriefGeneration({ ...base, skipRepo: true })).toBe(false);
  });
  it('does NOT fire when the brief is fresh', () => {
    expect(shouldAttemptBriefGeneration({ ...base, stale: false })).toBe(false);
  });
  it('debounces: no re-fire within the window of the last attempt', () => {
    expect(shouldAttemptBriefGeneration({ ...base, lastAttemptMs: 1000, nowMs: 1000 + DEBOUNCE - 1 })).toBe(false);
    expect(shouldAttemptBriefGeneration({ ...base, lastAttemptMs: 1000, nowMs: 1000 + DEBOUNCE })).toBe(true);
  });
});
