// agy double-encodes every STRING tool-call arg: the JSON value is itself a
// JSON string literal, so `TargetFile` arrives as `"\"/abs/path\""` — with a
// literal quote as the first character.
//
// Every path consumer gates on path.isAbsolute(), which is false for that, so
// the parser returned filePaths: [], filesEdited: [] and editRecords: [] for
// EVERY real agy transcript. Measured on this machine: 212 file-path args
// across 34 sessions (2026-07-04 → 2026-08-24), 100% double-encoded, 0% plain.
//
// It went unnoticed because the original fixture
// (antigravity-transcript.jsonl) is 100% PLAIN-encoded — it does not match the
// format agy actually writes. This suite pins the real shape, and keeps the
// plain shape working so older transcripts still parse.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseAntigravityTranscript, agyDecodeArg, agyArgs } from '../antigravity-transcript.js';
import { agyToolPaths, agyEvaluatePreTool } from '../commands/hooks.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-transcript-double-encoded.jsonl');

describe('agyDecodeArg', () => {
  it('strips the double-encoding from a quoted string arg', () => {
    expect(agyDecodeArg('"/Users/me/repo/a.ts"')).toBe('/Users/me/repo/a.ts');
  });

  it('leaves an already-plain value untouched (older agy builds)', () => {
    expect(agyDecodeArg('/Users/me/repo/a.ts')).toBe('/Users/me/repo/a.ts');
  });

  it('leaves unquoted scalars alone — agy sends these bare', () => {
    expect(agyDecodeArg('false')).toBe('false');
    expect(agyDecodeArg('500')).toBe('500');
  });

  it('turns escaped newlines back into real ones (edit-record content)', () => {
    expect(agyDecodeArg('"for i in range(42):\\n    pass"')).toBe('for i in range(42):\n    pass');
  });

  it('decodes embedded escaped quotes', () => {
    expect(agyDecodeArg('"git commit -m \\"feat: x\\""')).toBe('git commit -m "feat: x"');
  });

  it('falls back to the raw value when the quoting is malformed', () => {
    expect(agyDecodeArg('"/unterminated')).toBe('"/unterminated');
    expect(agyDecodeArg('"')).toBe('"');
  });

  it('does not mangle a plain string that merely contains quotes', () => {
    expect(agyDecodeArg('say "hi" now')).toBe('say "hi" now');
  });
});

describe('agyArgs', () => {
  it('decodes every string key and leaves non-strings alone', () => {
    const a = agyArgs({ args: { TargetFile: '"/r/a.ts"', EndLine: 18, Overwrite: 'false' } });
    expect(a.TargetFile).toBe('/r/a.ts');
    expect(a.EndLine).toBe(18);
    expect(a.Overwrite).toBe('false');
  });

  it('is safe on a tool call with no args', () => {
    expect(agyArgs({})).toEqual({});
    expect(agyArgs(null)).toEqual({});
  });
});

describe('parseAntigravityTranscript (real double-encoded agy transcript)', () => {
  const parsed = parseAntigravityTranscript(fs.readFileSync(FIXTURE, 'utf-8'));

  it('recovers the absolute paths agy actually wrote', () => {
    expect(parsed.filesEdited.length).toBeGreaterThan(0);
    for (const f of parsed.filesEdited) {
      expect(path.isAbsolute(f)).toBe(true);
      expect(f.startsWith('"')).toBe(false);
    }
    expect(parsed.filesEdited.some((f) => f.endsWith('/scratch/shit_code.py'))).toBe(true);
  });

  it('attributes each write to the prompt that caused it', () => {
    // Turn 3 ("add some more shitcode and commit") wrote into the worktree,
    // turns 1-2 wrote only into agy's own scratch dir.
    expect(parsed.promptFilesEdited[0].some((f) => f.includes('/scratch/'))).toBe(true);
    expect(parsed.promptFilesEdited[2].some((f) => f.includes('my_shit_project'))).toBe(true);
  });

  it('builds edit records whose content has real newlines, not \\n escapes', () => {
    const records = parsed.promptEditRecords.flat();
    expect(records.length).toBeGreaterThan(0);
    const withContent = records.filter((r) => {
      const i: any = r.input;
      return typeof i.content === 'string' || typeof i.new_string === 'string';
    });
    expect(withContent.length).toBeGreaterThan(0);
    for (const r of withContent) {
      const i: any = r.input;
      const text: string = typeof i.content === 'string' ? i.content : i.new_string;
      expect(text.includes('\\n')).toBe(false);
      expect(text.startsWith('"')).toBe(false);
    }
  });

  it('still detects the git commit run through the shell', () => {
    expect(parsed.promptRanCommit.some(Boolean)).toBe(true);
  });
});

describe('FILE_RESTRICTION enforcement against the real agy arg shape', () => {
  const rules = [{
    type: 'FILE_RESTRICTION',
    action: 'block',
    policyName: 'no secrets',
    condition: JSON.stringify({ path: '*.env' }),
  }];

  it('reads a usable path out of a double-encoded arg', () => {
    expect(agyToolPaths({ args: { TargetFile: '"/repo/.env"' } }).filePath).toBe('/repo/.env');
    expect(agyToolPaths({ name: 'run_command', args: { CommandLine: '"git status"' } }).command).toBe('git status');
  });

  it('BLOCKS a write agy encodes the way it really does', () => {
    const real = { name: 'write_to_file', args: { TargetFile: '"/repo/.env"' } };
    expect(agyEvaluatePreTool(real, { enforcementRules: rules }).decision).toBe('deny');
  });

  it('still blocks the plain shape', () => {
    const plain = { name: 'write_to_file', args: { TargetFile: '/repo/.env' } };
    expect(agyEvaluatePreTool(plain, { enforcementRules: rules }).decision).toBe('deny');
  });

  it('still allows a file the policy does not cover', () => {
    const ok = { name: 'write_to_file', args: { TargetFile: '"/repo/src/index.ts"' } };
    expect(agyEvaluatePreTool(ok, { enforcementRules: rules }).decision).toBe('allow');
  });
});
