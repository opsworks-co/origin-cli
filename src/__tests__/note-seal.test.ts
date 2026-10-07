// Sealed prompts in git notes (note-seal.ts): what the cipher guarantees, the
// strict opt-in, the key cache, one unwrap call per batch of history, and a
// sealed note that carries no clear text.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const seal = await import('../note-seal.js');
const { withSealedPrompts, buildNotePayload } = await import('../git-notes.js');

const key = (kid = 'repo-1/2026-10') => ({ kid, key: crypto.randomBytes(32) });

function repo(cfg?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-seal-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/acme/${path.basename(dir)}.git`], { cwd: dir });
  if (cfg !== undefined) fs.writeFileSync(path.join(dir, '.origin.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return dir;
}

beforeEach(() => { try { fs.rmSync(seal.NOTE_KEY_CACHE_PATH); } catch { /* none */ } });

describe('seal / open', () => {
  it('round-trips, and fails closed on a wrong key, a tampered blob or a swapped key id', () => {
    const k = key();
    const blob = seal.seal({ promptSummary: 'add the cache', prompts: [{ index: 0, text: 'add the cache' }] }, k);
    expect(blob.ct).not.toContain('cache');
    expect(seal.openWithKey(blob, k.key)).toEqual({ promptSummary: 'add the cache', prompts: [{ index: 0, text: 'add the cache' }] });
    expect(seal.openWithKey(blob, crypto.randomBytes(32))).toBeNull();
    const ct = Buffer.from(blob.ct, 'base64'); ct[0] ^= 1;
    expect(seal.openWithKey({ ...blob, ct: ct.toString('base64') }, k.key)).toBeNull();
    // Bound to its key id: relabelling it as another repo's or month's fails.
    expect(seal.openWithKey({ ...blob, kid: 'repo-2/2026-10' }, k.key)).toBeNull();
  });
});

describe('opt-in', () => {
  it('only a literal true in a valid .origin.json seals', () => {
    expect(seal.sealingRequested(repo({ notesEncryptPrompts: true }))).toBe(true);
    for (const cfg of [undefined, {}, { notesEncryptPrompts: 'true' }, { notesEncryptPrompts: 1 }, 'not json', '[]']) {
      expect(seal.sealingRequested(repo(cfg)), JSON.stringify(cfg)).toBe(false);
    }
  });
});

describe('write key cache', () => {
  it('fetches once, caches owner-only, and is used without the network', async () => {
    const dir = repo({ notesEncryptPrompts: true });
    const raw = crypto.randomBytes(32).toString('base64');
    const fetchKey = vi.fn(async () => ({ kid: 'repo-1/2026-10', key: raw, validUntil: new Date(Date.now() + 86_400_000).toISOString() }));
    await seal.ensureWriteKey(dir, fetchKey);
    await seal.ensureWriteKey(dir, fetchKey);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    expect(seal.cachedWriteKey(dir)?.key.toString('base64')).toBe(raw);
    if (process.platform !== 'win32') expect(fs.statSync(seal.NOTE_KEY_CACHE_PATH).mode & 0o077).toBe(0);
  });

  it('a repo that did not opt in never asks; a failed fetch leaves no key', async () => {
    const fetchKey = vi.fn(async () => { throw new Error('offline'); });
    await seal.ensureWriteKey(repo(), fetchKey);
    expect(fetchKey).not.toHaveBeenCalled();
    const dir = repo({ notesEncryptPrompts: true });
    await seal.ensureWriteKey(dir, fetchKey);
    expect(seal.cachedWriteKey(dir)).toBeNull();
  });
});

describe('reading history', () => {
  it('opens many notes with ONE unwrap call per batch, and refused keys stay sealed', async () => {
    const oct = key('repo-1/2026-10');
    const sep = key('repo-1/2026-09');
    const denied = key('repo-9/2026-10');
    const blobs = [
      seal.seal({ promptSummary: 'a' }, oct), seal.seal({ promptSummary: 'b' }, oct),
      seal.seal({ promptSummary: 'c' }, sep), seal.seal({ promptSummary: 'd' }, denied),
    ];
    const unwrap = vi.fn(async (kids: string[]) => ({
      keys: Object.fromEntries(kids.filter((k) => k !== denied.kid).map((k) => [k, (k === oct.kid ? oct : sep).key.toString('base64')])),
    }));
    const opened = await seal.openSealedMany(blobs, unwrap);
    expect(opened.map((o) => o?.promptSummary ?? null)).toEqual(['a', 'b', 'c', null]);
    expect(unwrap).toHaveBeenCalledTimes(1);
    expect(unwrap.mock.calls[0][0].sort()).toEqual([oct.kid, sep.kid, denied.kid].sort());
    // Cached now: the same history opens with no further call (except the refused key).
    await seal.openSealedMany(blobs.slice(0, 3), unwrap);
    expect(unwrap).toHaveBeenCalledTimes(1);
  });
});

describe('a sealed note', () => {
  const data = {
    sessionId: 's1', model: 'claude-opus-5-5', agentSlug: 'claude-code', promptCount: 1,
    promptSummary: 'rotate the signing key', fullPrompt: 'rotate the signing key now',
    prompts: [{ index: 0, text: 'rotate the signing key', files: ['a.ts'] }],
    markers: { decision: ['kept the old key for a day'] },
    originUrl: 'https://getorigin.io/sessions/s1', linesAdded: 3, linesRemoved: 1,
  } as any;

  it('carries no clear prompt text, and opens back to it', () => {
    const k = key();
    const metadataOnly = JSON.parse(buildNotePayload(data, false));
    const note = withSealedPrompts(metadataOnly, data, k);
    const text = JSON.stringify(note);
    for (const secret of ['rotate the signing key', 'kept the old key']) expect(text).not.toContain(secret);
    expect(note.origin.promptTextWithheld).toBe(true);
    const opened = seal.openWithKey(note.origin.sealed as any, k.key)!;
    expect(opened.promptSummary).toBe('rotate the signing key');
    expect(opened.prompts).toEqual([{ index: 0, text: 'rotate the signing key' }]);
    expect((opened.markers as any).decision).toEqual(['kept the old key for a day']);
  });

  it('with nothing to seal the note is unchanged', () => {
    const bare = { ...data, promptSummary: '', fullPrompt: undefined, prompts: [{ index: 0, text: '' }], markers: undefined };
    const metadataOnly = JSON.parse(buildNotePayload(bare, false));
    expect(withSealedPrompts(metadataOnly, bare, key())).toBe(metadataOnly);
  });
});
