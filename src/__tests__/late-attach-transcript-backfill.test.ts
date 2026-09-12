import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recoverLateAttachTranscript } from '../commands/hooks/user-prompt-submit.js';

const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

function transcript(entries: unknown[]): string {
  const file = path.join(os.tmpdir(), `origin-late-attach-${process.pid}-${Date.now()}.jsonl`);
  files.push(file);
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

describe('late SessionStart attachment', () => {
  it('backfills prior Claude turns while leaving the incoming prompt for the hook to anchor', () => {
    const file = transcript([
      { type: 'user', timestamp: '2026-09-12T10:00:00.000Z', message: { content: 'first change' } },
      { type: 'assistant', timestamp: '2026-09-12T10:00:01.000Z', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.ts', content: 'first' } }] } },
      { type: 'user', timestamp: '2026-09-12T10:01:00.000Z', message: { content: 'second change' } },
      { type: 'assistant', timestamp: '2026-09-12T10:01:01.000Z', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'b.ts', old_string: 'old', new_string: 'new' } }] } },
      // Some Claude builds append this before firing UserPromptSubmit. It must
      // still be added by the normal path so it receives a real baseline.
      { type: 'user', timestamp: '2026-09-12T10:02:00.000Z', message: { content: 'continue with the fix' } },
    ]);

    const recovered = recoverLateAttachTranscript(file, 'continue with the fix', [path.dirname(file)]);

    expect(recovered.prompts).toEqual(['first change', 'second change']);
    expect(recovered.mappings.map((m) => [m.promptIndex, m.filesChanged])).toEqual([
      [0, ['a.ts']],
      [1, ['b.ts']],
    ]);
    expect(recovered.startedAt).toBe('2026-09-12T10:00:00.000Z');
  });
});
