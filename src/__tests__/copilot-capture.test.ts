// Copilot capture: its session dir is an opaque id and workspace.yaml records
// `cwd: /`, so the repo can only come from absolute paths in tool arguments.
// (Copilot uses keys the generic extractor doesn't know, e.g. `paths`.)
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { harvestCopilotPaths, copilotAdapter, readCopilotCwd, decodeCursorWorkspacePath } from '../transcript-adapters.js';

describe('Copilot capture', () => {
  it('harvests only EXISTING absolute paths from tool arguments', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cop-'));
    const real = path.join(tmp, 'repo');
    fs.mkdirSync(real);
    const f = path.join(tmp, 'events.jsonl');
    const j = (o: any) => JSON.stringify(o);
    fs.writeFileSync(f, [
      // A real path under a `paths` key (not a key the generic extractor knows).
      j({ type: 'tool.execution_start', data: { toolName: 'glob', arguments: { pattern: '*', paths: real } } }),
      // Prose example inside a question — must NOT be harvested (doesn't exist).
      j({ type: 'tool.execution_start', data: { toolName: 'ask_user', arguments: { question: 'Type a path (e.g., C:\path\to\repo)' } } }),
    ].join('\n') + '\n');

    const paths = harvestCopilotPaths(f);
    expect(paths).toContain(real);
    expect(paths.some((p) => p.includes('path\to\repo'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses prompts, model and a DisplayMessage[] transcript from events.jsonl', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cop2-'));
    const f = path.join(tmp, 'events.jsonl');
    const j = (o: any) => JSON.stringify(o);
    fs.writeFileSync(f, [
      j({ type: 'session.start', data: { sessionId: 's1' }, timestamp: '2026-07-28T10:00:00Z' }),
      j({ type: 'user.message', data: { content: 'add a row' }, timestamp: '2026-07-28T10:00:01Z' }),
      j({ type: 'assistant.message', data: { messageId: 'm1', model: 'gpt-5-mini', content: 'Done.', outputTokens: 7 }, timestamp: '2026-07-28T10:00:02Z' }),
    ].join('\n') + '\n');

    const parsed = copilotAdapter.parse(f)!;
    expect(parsed.userPrompts).toEqual(['add a row']);
    expect(parsed.model).toBe('gpt-5-mini');
    const msgs = JSON.parse(parsed.transcript);
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Copilot session.start context', () => {
  it('uses the authoritative gitRoot/cwd, and ignores the remote "/" placeholder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cop3-'));
    const local = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(local, JSON.stringify({
      type: 'session.start',
      // gitRoot wins over cwd when both are present.
      data: { context: { cwd: 'C:/some/other', gitRoot: 'C:/repo/x', repository: 'o/x', branch: 'main' } },
    }) + '\n');
    expect(readCopilotCwd(local)).toBe('C:/repo/x');

    // Remote read-only cloud task: cwd "/" is a placeholder, not a repo.
    const remote = path.join(tmp, 'remote.jsonl');
    fs.writeFileSync(remote, JSON.stringify({ type: 'session.start', data: { context: { cwd: '/' } } }) + '\n');
    expect(readCopilotCwd(remote)).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Cursor workspace-name decoding', () => {
  it('resolves the ambiguous dash-flattened folder name to a real directory', () => {
    const sep = path.sep;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
    // A directory whose own name contains dashes — the ambiguity this decoder
    // has to resolve (a dash may be a separator OR part of the name).
    const target = path.join(tmp, 'my-repo-x');
    fs.mkdirSync(target);

    const root = path.parse(target).root;          // "C:\" on Windows, "/" on posix
    const drive = root.replace(/[^A-Za-z]/g, '');  // "C" on Windows, "" on posix
    if (drive) {
      // Rebuild Cursor's encoding: drop the root, flatten separators to '-',
      // prefix the lowercased drive letter.
      const encoded = (drive + '-' + target.slice(root.length).split(sep).join('-')).toLowerCase();
      const decoded = decodeCursorWorkspacePath(encoded);
      // Compare on a normalized form — the decoder emits forward slashes.
      expect(decoded?.toLowerCase()).toBe(target.split(sep).join('/').toLowerCase());
    }

    // Names that aren't drive-prefixed paths decode to null, not a bogus path.
    expect(decodeCursorWorkspacePath('empty-window')).toBeNull();
    expect(decodeCursorWorkspacePath('nodash')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
