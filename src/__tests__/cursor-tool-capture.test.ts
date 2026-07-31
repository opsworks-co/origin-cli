// Regression: Cursor's transcript uses a `Write` tool with a `contents` key
// (not `content`) and a `StrReplace` tool (old_string/new_string). Neither was
// recognized, so Cursor per-prompt diffs recorded 0 lines / no files. These
// assert extractPromptFileMappings now attributes them correctly.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPromptFileMappings } from '../transcript.js';

function countAdd(diff: string): number {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
}

describe('Cursor tool capture (Write contents + StrReplace)', () => {
  it('attributes each prompt its real per-turn line counts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cap-'));
    const f = path.join(tmp, 't.jsonl');
    const user = (t: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${t}\n</user_query>` }] } });
    const assistant = (blocks: any[]) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
    const rows15 = Array.from({ length: 15 }, (_, i) => `Row ${i + 1}`).join('\n') + '\n';
    const lines = [
      user('check whats in repo'),
      assistant([{ type: 'tool_use', name: 'Read', input: { path: '/repo/README.md' } }]), // read-only
      user('create a file pupkin with 15 rows'),
      assistant([{ type: 'tool_use', name: 'Write', input: { path: '/repo/pupkin', contents: rows15 } }]), // contents key
      user('add 5 more rows'),
      assistant([{ type: 'tool_use', name: 'StrReplace', input: { path: '/repo/pupkin', old_string: 'Row 15\n', new_string: 'Row 15\nRow 16\nRow 17\nRow 18\nRow 19\nRow 20\n' } }]),
    ];
    fs.writeFileSync(f, lines.join('\n') + '\n');

    const maps = extractPromptFileMappings(f);
    const byIdx = Object.fromEntries(maps.map((m) => [m.promptIndex, m]));
    expect(byIdx[0].filesChanged).toEqual([]);                 // read-only prompt: nothing
    expect(byIdx[1].filesChanged).toEqual(['/repo/pupkin']);   // Write(contents) recognized
    expect(countAdd(byIdx[1].diff)).toBe(15);                  // real +15, not +0
    expect(byIdx[2].filesChanged).toEqual(['/repo/pupkin']);   // StrReplace recognized
    expect(countAdd(byIdx[2].diff)).toBe(5);                   // +5 append

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
