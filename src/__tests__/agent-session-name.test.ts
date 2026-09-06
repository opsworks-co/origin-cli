import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeSessionName, claudeSessionTitles, cursorSessionName } from '../agent-session-name.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-name-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function transcript(lines: unknown[]): string {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

describe('claudeSessionName', () => {
  it('reads the sidebar title out of a custom-title record', () => {
    // Shape verified against real transcripts in ~/.claude/projects.
    const p = transcript([
      { type: 'user', message: 'hi' },
      { type: 'custom-title', customTitle: 'Commit capture issue', sessionId: 'abc' },
    ]);
    expect(claudeSessionName(p)).toBe('Commit capture issue');
  });

  it('takes the LAST record — the title is rewritten on every rename', () => {
    const p = transcript([
      { type: 'custom-title', customTitle: 'First guess' },
      { type: 'user', message: 'hi' },
      { type: 'custom-title', customTitle: 'What it actually became' },
    ]);
    expect(claudeSessionName(p)).toBe('What it actually became');
  });

  it('returns null when the session was never titled', () => {
    expect(claudeSessionName(transcript([{ type: 'user', message: 'hi' }]))).toBeNull();
  });

  it('survives a torn final line', () => {
    // Transcripts are read while the agent is mid-write, so the tail is
    // routinely half-flushed JSON. That must not lose an earlier good title.
    const p = transcript([{ type: 'custom-title', customTitle: 'Good title' }]);
    fs.appendFileSync(p, '\n{"type":"assistant","message":{"cont');
    expect(claudeSessionName(p)).toBe('Good title');
  });

  it('returns null rather than throwing on a missing file', () => {
    expect(claudeSessionName(path.join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('rejects blank and oversized titles', () => {
    expect(claudeSessionName(transcript([{ type: 'custom-title', customTitle: '   ' }]))).toBeNull();
    // A whole prompt body in the name column is worse than falling back to
    // the aiTitle, so anything absurd is refused outright.
    expect(claudeSessionName(transcript([{ type: 'custom-title', customTitle: 'x'.repeat(400) }]))).toBeNull();
  });

  it('flattens control characters that would break a single-line UI', () => {
    const p = transcript([{ type: 'custom-title', customTitle: 'Two\nlines\there' }]);
    expect(claudeSessionName(p)).toBe('Two lines here');
  });

  // The terminal REPL never writes a custom-title unless the user renames:
  // it generates a title from the first prompt and records it as `ai-title`.
  // Every Windows session shipped nameless because only custom-title was read.
  it('falls back to the ai-title record the terminal REPL writes', () => {
    // Shape from Claude Code 2.1.259's saveAiGeneratedTitle.
    const p = transcript([
      { type: 'user', message: 'hi' },
      { type: 'ai-title', aiTitle: 'Phantom watch events', sessionId: 'abc' },
    ]);
    expect(claudeSessionName(p)).toBe('Phantom watch events');
  });

  it('prefers the custom title over the ai title whatever their order', () => {
    // A rename lands AFTER the auto-title on a normal timeline; a re-appended
    // metadata block can put them in either order. The user's own name wins
    // either way — that is what Claude Code's /resume picker shows.
    expect(claudeSessionName(transcript([
      { type: 'ai-title', aiTitle: 'Auto' },
      { type: 'custom-title', customTitle: 'Mine' },
    ]))).toBe('Mine');
    expect(claudeSessionName(transcript([
      { type: 'custom-title', customTitle: 'Mine' },
      { type: 'ai-title', aiTitle: 'Auto' },
    ]))).toBe('Mine');
  });

  it('a cleared custom title falls through to the ai title, not to the stale custom one', () => {
    const p = transcript([
      { type: 'ai-title', aiTitle: 'Auto' },
      { type: 'custom-title', customTitle: 'Old name' },
      { type: 'custom-title', customTitle: '' },
    ]);
    expect(claudeSessionName(p)).toBe('Auto');
  });

  it('takes the LAST ai-title — the generated title is rewritten too', () => {
    expect(claudeSessionName(transcript([
      { type: 'ai-title', aiTitle: 'First' },
      { type: 'user', message: 'hi' },
      { type: 'ai-title', aiTitle: 'Second' },
    ]))).toBe('Second');
  });

  it('reads the custom-title.json sidecar when the transcript has no title record', () => {
    // Claude Code persists a custom title beside the transcript as well:
    // <dir>/<sessionId>/custom-title.json, and reads it back from there.
    const p = transcript([{ type: 'user', message: 'hi' }, { type: 'ai-title', aiTitle: 'Auto' }]);
    const side = path.join(dir, 'transcript');
    fs.mkdirSync(side);
    fs.writeFileSync(path.join(side, 'custom-title.json'), JSON.stringify({ customTitle: 'From sidecar' }));
    expect(claudeSessionName(p)).toBe('From sidecar');
  });

  it('ignores the sidecar once the transcript says the title was cleared', () => {
    // Claude Code deletes the sidecar on clear; if that delete is lost, the
    // transcript's blank record is the fresher signal.
    const p = transcript([{ type: 'ai-title', aiTitle: 'Auto' }, { type: 'custom-title', customTitle: '' }]);
    const side = path.join(dir, 'transcript');
    fs.mkdirSync(side);
    fs.writeFileSync(path.join(side, 'custom-title.json'), JSON.stringify({ customTitle: 'Stale' }));
    expect(claudeSessionName(p)).toBe('Auto');
  });

  it('reports which sources were empty so a nameless session can explain itself', () => {
    const p = transcript([{ type: 'user', message: 'hi' }]);
    expect(claudeSessionTitles(p)).toEqual({
      transcriptRead: true, customTitle: null, hasCustomTitleRecord: false, sidecarTitle: null, aiTitle: null,
    });
    expect(claudeSessionTitles(path.join(dir, 'nope.jsonl')).transcriptRead).toBe(false);
    expect(claudeSessionTitles('').transcriptRead).toBe(false);
  });
});

describe('cursorSessionName', () => {
  // querySqlite returns a delimited STRING, not rows — the stub matches that.
  const stub = (value: string) => () => value;

  it('pulls the chat name out of the composerHeaders value blob', () => {
    // Shape verified against a real Cursor state.vscdb.
    const name = cursorSessionName('c-1', stub(JSON.stringify({ type: 'head', composerId: 'c-1', name: 'Chill file creation' })), '/fake/state.vscdb');
    expect(name).toBe('Chill file creation');
  });

  it('returns null for a composer Cursor has not named yet', () => {
    // An unnamed composer has no `name` key at all — not an empty one.
    expect(cursorSessionName('c-1', stub(JSON.stringify({ type: 'head', composerId: 'c-1' })), '/fake/state.vscdb')).toBeNull();
  });

  it('returns null without a composer id instead of querying for anything', () => {
    let called = false;
    cursorSessionName('', () => { called = true; return ''; }, '/fake/state.vscdb');
    expect(called).toBe(false);
  });

  it('returns null when the db read fails', () => {
    // Cursor holds a write lock while saving; a failed read is a normal
    // transient, not an error worth surfacing.
    expect(cursorSessionName('c-1', () => { throw new Error('database is locked'); }, '/fake/state.vscdb')).toBeNull();
    expect(cursorSessionName('c-1', stub('not json'), '/fake/state.vscdb')).toBeNull();
    expect(cursorSessionName('c-1', stub(''), '/fake/state.vscdb')).toBeNull();
  });
});
