/**
 * inheritedWithStartDirt: an inherited file's before-state with the work the
 * turn started with laid on top. Session 690e594c turn 1 (2026-09-27) was
 * billed turn 0's uncommitted lines after a rebase replayed them over an
 * upstream change to the same file; see capture-e2e-rebase-replays-earlier-turn-dirt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createShadowCommit, inheritedWithStartDirt, mergeFileContents } from '../git-capture.js';

const lines = (edit: Record<number, string> = {}) =>
  Array.from({ length: 30 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

describe('inheritedWithStartDirt', () => {
  let shadow = '';
  let head = '';

  beforeAll(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-start-dirt-')));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'f.ts'), lines());
    fs.writeFileSync(path.join(repo, 'clean.ts'), lines());
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    head = git('rev-parse', 'HEAD');
    // An earlier turn's uncommitted edit, captured in the turn's shadow.
    fs.writeFileSync(path.join(repo, 'f.ts'), lines({ 3: 'line 3 by turn A' }));
    shadow = createShadowCommit(repo, 'prompt-test') || '';
  });
  afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('lays the starting dirt over an upstream change to another part of the file', () => {
    expect(shadow).toMatch(/^[0-9a-f]{40}$/);
    const started = lines({ 3: 'line 3 by turn A' });
    const upstream = lines({ 25: 'line 25 upstream' });
    expect(inheritedWithStartDirt(repo, shadow, 'f.ts', started, upstream))
      .toBe(lines({ 3: 'line 3 by turn A', 25: 'line 25 upstream' }));
  });

  it('leaves a file the turn started clean on alone', () => {
    expect(inheritedWithStartDirt(repo, shadow, 'clean.ts', lines(), lines({ 25: 'x' }))).toBeNull();
  });

  it('keeps the inherited bytes when the dirt and upstream conflict', () => {
    const started = lines({ 3: 'line 3 by turn A' });
    expect(inheritedWithStartDirt(repo, shadow, 'f.ts', started, lines({ 3: 'line 3 upstream' }))).toBeNull();
  });

  it('asks nothing of a baseline that is not a shadow (a clean start)', () => {
    expect(inheritedWithStartDirt(repo, head, 'f.ts', lines({ 3: 'a' }), lines({ 25: 'b' }))).toBeNull();
  });

  it('mergeFileContents reports a conflict as null', () => {
    expect(mergeFileContents(repo, 'a\n', 'b\n', 'c\n')).toBeNull();
    expect(mergeFileContents(repo, 'a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')).toBe('A\nb\nc\nd\nE\n');
  });
});
