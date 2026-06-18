// parseTranscript must emit a structured tool breakdown + files-read list
// (not just a count) so the server can store them and the PR-detail
// "behind the work" view stops depending on transcript-text markers.

import { describe, expect, it, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { parseTranscript } from '../transcript.js';

let tmp: string | null = null;
afterEach(() => { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } tmp = null; } });

function writeJsonl(lines: object[]): string {
  tmp = path.join(os.tmpdir(), `origin-tt-${process.pid}-${lines.length}.jsonl`);
  fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n'));
  return tmp;
}

describe('parseTranscript tool/files capture', () => {
  it('builds a per-tool breakdown and a Read-only files list', () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/b.ts' } },
      ] } },
    ]);
    const p = parseTranscript(file);

    expect(p.toolCalls).toBe(4);
    // Sorted by count desc; Read appears twice.
    expect(p.toolBreakdown[0]).toEqual({ name: 'Read', count: 2 });
    expect(p.toolBreakdown.find((t) => t.name === 'Edit')?.count).toBe(1);
    expect(p.toolBreakdown.find((t) => t.name === 'Bash')?.count).toBe(1);

    // filesRead carries the Read-tool paths; Edit goes to filesChanged.
    expect([...p.filesRead].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(p.filesChanged).toContain('src/a.ts');
    // b.ts was read but never changed — the "files read, not changed" signal.
    expect(p.filesChanged).not.toContain('src/b.ts');
  });

  it('returns empty structured fields when no tools were used', () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'just chat' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const p = parseTranscript(file);
    expect(p.toolCalls).toBe(0);
    expect(p.toolBreakdown).toEqual([]);
    expect(p.filesRead).toEqual([]);
  });
});
