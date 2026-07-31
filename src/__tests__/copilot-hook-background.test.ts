// Copilot's user-prompt-submit hook is re-dispatched to a DETACHED background
// process so it never blocks Copilot's prompt (Copilot runs hooks synchronously
// and waits for them; the capture path takes 6-14s). A detached child has no
// stdin, so the parent hands the payload over via a temp file named in
// ORIGIN_HOOK_INPUT_FILE. readHookInput reads (and deletes) that file instead of
// blocking on a closed stdin. These tests pin that hand-off contract.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readHookInput } from '../commands/hooks.js';

describe('readHookInput — background hook payload hand-off', () => {
  const saved = process.env.ORIGIN_HOOK_INPUT_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ORIGIN_HOOK_INPUT_FILE;
    else process.env.ORIGIN_HOOK_INPUT_FILE = saved;
  });

  it('reads the payload from ORIGIN_HOOK_INPUT_FILE and deletes the file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hookin-')), 'input.json');
    const payload = { prompt: 'what the heck', cwd: 'C:/soft/origin-demo-1', session_id: 'abc' };
    fs.writeFileSync(file, JSON.stringify(payload));
    process.env.ORIGIN_HOOK_INPUT_FILE = file;

    const input = await readHookInput();

    expect(input).toEqual(payload);
    // The temp file must be cleaned up so it can't leak or be re-read.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns {} and cleans up when the payload file is corrupt', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hookin-')), 'input.json');
    fs.writeFileSync(file, '{not valid json');
    process.env.ORIGIN_HOOK_INPUT_FILE = file;

    const input = await readHookInput();

    expect(input).toEqual({});
    expect(fs.existsSync(file)).toBe(false);
  });
});
