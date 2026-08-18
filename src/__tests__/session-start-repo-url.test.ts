// Every session/start MUST advertise the checkout's remote.
//
// The server's repo resolver reaches its GitHub-identity rung — matching a row
// the UI's GitHub import registered as "github.com/owner/repo" — ONLY via
// repoUrl. Omit it and two things go wrong at once:
//   1. the existing row isn't found, so session/start auto-registers a SECOND
//      row keyed by the local checkout path, and
//   2. that duplicate lands with `fullName: null`, which then defeats the
//      GitHub import's own dedup (it matches CLI rows by fullName) — so the
//      split persists and compounds instead of self-healing.
//
// Prod held two rows each for `vodka`, `karamba` and `origin-test-repo` this
// way. `vodka`: 095a3760 (path "github.com/artemupplabs/vodka", provider
// github) and aa60fb53 (path "/Users/…/vodka", provider local, fullName null),
// with the two sessions of a single turn anchored to DIFFERENT rows. The thin
// caller was the MCP `start_session` tool, which sent only
// { machineId, prompt, model, repoPath }.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { repoRemoteUrl } from '../commands/hooks.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

describe('repoRemoteUrl', () => {
  it('reads the origin remote of a real checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-remote-'));
    git(dir, ['init', '-q', '.']);
    git(dir, ['remote', 'add', 'origin', 'https://github.com/artemupplabs/vodka.git']);

    expect(repoRemoteUrl(dir)).toBe('https://github.com/artemupplabs/vodka.git');
  });

  it('returns undefined for a local-only checkout (no remote) — not a throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-noremote-'));
    git(dir, ['init', '-q', '.']);

    expect(repoRemoteUrl(dir)).toBeUndefined();
  });

  it('returns undefined outside a repo, and for empty/missing paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-notrepo-'));
    expect(repoRemoteUrl(dir)).toBeUndefined();
    expect(repoRemoteUrl('')).toBeUndefined();
    expect(repoRemoteUrl(undefined)).toBeUndefined();
    expect(repoRemoteUrl(null)).toBeUndefined();
  });
});

// Guard the whole surface, not just the one caller that regressed: any NEW
// session/start added without repoUrl re-opens the duplicate-row bug, and a
// unit test on a single call site would not catch it.
describe('every api.startSession call site advertises repoUrl', () => {
  it('has no thin callers left in src/', () => {
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); }
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);

    const thin: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('startSession({')) return;
        // The call spans a handful of lines; repoUrl must appear inside it.
        const block = lines.slice(i, i + 18).join('\n');
        if (!block.includes('repoUrl')) thin.push(`${path.relative(root, f)}:${i + 1}`);
      });
    }

    expect(thin).toEqual([]);
  });
});
