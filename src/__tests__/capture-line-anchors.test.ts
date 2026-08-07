// Regression: AI Blame credited a turn with the WRONG lines. A turn that
// appended rows 13-17 to a file rendered as `@@ -1,1 +1,6 @@` — lines 2-6 —
// because its edits shipped with no line anchor and the server's synthesized
// diff falls back to a cursor that starts at line 1.
//
// anchorEditPositions existed and worked, but only commands/hooks.ts called it.
// Agents captured by the poll-based transcript watcher never fire a hook (on
// Windows no GUI agent does), so every Cursor/Gemini edit reached the server
// unanchored. capturePromptEdits now anchors for every caller.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { capturePromptEdits } from '../prompt-capture/index.js';

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

describe('capturePromptEdits stamps real file line anchors', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-anchor-cap-')));
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  function transcript(lines: string[]): string {
    const f = path.join(repo, 't.jsonl');
    fs.writeFileSync(f, lines.join('\n') + '\n');
    return f;
  }
  const user = (t: string) =>
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${t}\n</user_query>` }] } });
  const assistant = (blocks: any[]) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
  const turnEnded = () => JSON.stringify({ type: 'turn_ended', status: 'success' });

  it('anchors an append deep in the file at its real line, not line 1', () => {
    // Final on-disk state: 17 rows. The second turn appended 13-17 after Row 12.
    fs.writeFileSync(path.join(repo, 'shisha'), rows(1, 17));
    const f = transcript([
      user('create a file shisha with 12 rows in it'),
      assistant([{ type: 'tool_use', name: 'Write', input: { path: path.join(repo, 'shisha'), contents: rows(1, 12) } }]),
      turnEnded(),
      user('add 5 more rows and commit'),
      assistant([{
        type: 'tool_use',
        name: 'StrReplace',
        input: { path: path.join(repo, 'shisha'), old_string: 'Row 12\n', new_string: rows(12, 17) },
      }]),
      turnEnded(),
    ]);

    const turns = capturePromptEdits({ agent: 'cursor', repoPath: repo, transcriptPath: f, sessionCommitShas: [] });
    expect(turns.length).toBe(2);
    // A whole-file write starts at the top.
    expect(turns[0].edits[0].newStart).toBe(1);
    // The append: `Row 12` sits on file line 12, so the added rows land on
    // 13-17. Before the fix this was undefined and rendered as line 1.
    expect(turns[1].edits[0].oldStart).toBe(12);
    expect(turns[1].edits[0].newStart).toBe(12);
  });

  it.runIf(process.platform === 'win32')('relativizes a path whose drive letter case differs from the repo root', () => {
    // One real Cursor transcript spells the repo root `c:\…` on some turns and
    // `C:\…` on others. The case-sensitive prefix test left the odd ones
    // absolute, so editsJson had turns claiming `c:/repo/shisha` and turns
    // claiming `shisha` — the same file under two identities.
    fs.writeFileSync(path.join(repo, 'shisha'), rows(1, 12));
    const lower = repo.replace(/^([A-Za-z]):/, (_m, d) => d.toLowerCase() + ':');
    const upper = repo.replace(/^([A-Za-z]):/, (_m, d) => d.toUpperCase() + ':');
    const f = transcript([
      user('create it'),
      assistant([{ type: 'tool_use', name: 'Write', input: { path: path.join(lower, 'shisha'), contents: rows(1, 12) } }]),
      turnEnded(),
    ]);

    const turns = capturePromptEdits({ agent: 'cursor', repoPath: upper, transcriptPath: f, sessionCommitShas: [] });
    expect(turns[0].edits.map((e) => e.file)).toEqual(['shisha']);
  });

  it('leaves an edit unanchored when the file no longer contains it (never guesses)', () => {
    // The watcher polls late — a later turn can overwrite the region. An anchor
    // that cannot be resolved must stay unset so the server falls back to its
    // cursor, rather than pointing blame at an arbitrary line.
    fs.writeFileSync(path.join(repo, 'shisha'), 'something else entirely\n');
    const f = transcript([
      user('append rows'),
      assistant([{
        type: 'tool_use',
        name: 'StrReplace',
        input: { path: path.join(repo, 'shisha'), old_string: 'Row 12\n', new_string: rows(12, 17) },
      }]),
      turnEnded(),
    ]);

    const turns = capturePromptEdits({ agent: 'cursor', repoPath: repo, transcriptPath: f, sessionCommitShas: [] });
    expect(turns[0].edits[0].newStart).toBeUndefined();
    expect(turns[0].edits[0].oldStart).toBeUndefined();
  });
});
