import { describe, it, expect } from 'vitest';
import { stripBom } from '../commands/hooks.js';

// Cursor on Windows hands its hook payload to the CLI as UTF-8 *with BOM*.
// JSON.parse rejects the leading U+FEFF, so every Cursor hook silently no-oped:
// beforeSubmitPrompt never created the session, the poll watcher noticed it only
// after the turn had ended, and its headShaAtStart already contained the commit
// the agent had just made — which then read back as "uncommitted".
describe('stripBom', () => {
  const BOM = String.fromCharCode(0xfeff);

  it('parses a BOM-prefixed hook payload', () => {
    const raw = BOM + JSON.stringify({ conversation_id: 'babb42e6', hook_event_name: 'beforeSubmitPrompt' });
    expect(() => JSON.parse(raw)).toThrow();
    expect(JSON.parse(stripBom(raw))).toEqual({
      conversation_id: 'babb42e6',
      hook_event_name: 'beforeSubmitPrompt',
    });
  });

  it('leaves a plain payload untouched', () => {
    const raw = JSON.stringify({ session_id: 'x' });
    expect(JSON.parse(stripBom(raw))).toEqual({ session_id: 'x' });
  });

  it('handles a BOM followed by whitespace and a trailing newline', () => {
    const raw = `${BOM}\n  {"cwd":"C:/soft/origin-demo-1"}\n`;
    expect(JSON.parse(stripBom(raw))).toEqual({ cwd: 'C:/soft/origin-demo-1' });
  });

  it('does not strip a BOM that is inside the payload', () => {
    const raw = JSON.stringify({ prompt: `hello${BOM}world` });
    expect(JSON.parse(stripBom(raw)).prompt).toBe(`hello${BOM}world`);
  });
});
