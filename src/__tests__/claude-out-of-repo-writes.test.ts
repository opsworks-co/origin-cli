// A claude-code turn that writes only OUTSIDE the repo — Origin's own memory
// notes under ~/.claude, a scratch file in /tmp, a sibling project — has those
// paths dropped by scopeCapturedPath. Correctly: they are not this repo's diff.
//
// But the turn then renders "0 files changed", which is indistinguishable from
// a capture that broke, and that reading is the one people reach for. agy has
// recorded the dropped paths since #1273; this brings the claude-code
// transcript route to parity.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPromptFileMappings } from '../transcript.js';

const REPO = '/repo';

function transcript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-oor-tx-'));
  const f = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const wrote = (filePath: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: filePath, content: 'x' } }] },
});

const mappingsFor = (lines: unknown[]) =>
  extractPromptFileMappings(transcript(lines), { repoRoots: [REPO] }) as any[];

describe('claude-code out-of-repo writes', () => {
  it('records a write that landed outside the repo', () => {
    const m = mappingsFor([user('write a scratch file'), wrote('/tmp/scratch.py')]);
    expect(m[0].filesChanged).toEqual([]);
    expect(m[0].outOfRepoFiles).toEqual(['/tmp/scratch.py']);
  });

  it('collapses the home directory so the account name is not stored', () => {
    const p = path.join(os.homedir(), '.claude', 'memory', 'note.md');
    const m = mappingsFor([user('save a memory note'), wrote(p)]);
    const [only] = m[0].outOfRepoFiles;
    expect(only.startsWith('~/')).toBe(true);
    expect(only).not.toContain(os.homedir());
  });

  it('says nothing for a turn whose writes were all IN the repo', () => {
    const m = mappingsFor([user('edit source'), wrote(`${REPO}/src/a.ts`)]);
    expect(m[0].filesChanged).toEqual(['src/a.ts']);
    expect(m[0].outOfRepoFiles).toBeUndefined();
  });

  it('records only the outside half of a mixed turn', () => {
    const m = mappingsFor([user('both'), wrote(`${REPO}/src/a.ts`), wrote('/tmp/b.py')]);
    expect(m[0].filesChanged).toEqual(['src/a.ts']);
    expect(m[0].outOfRepoFiles).toEqual(['/tmp/b.py']);
  });

  it('does not treat a RELATIVE path as out-of-repo', () => {
    // scopeCapturedPath also returns null-ish for shapes that are already
    // repo-scoped; only an ABSOLUTE path outside the root is evidence.
    const m = mappingsFor([user('relative'), wrote('src/rel.ts')]);
    expect(m[0].outOfRepoFiles).toBeUndefined();
  });

  it('attributes each write to the turn that made it', () => {
    const m = mappingsFor([
      user('turn one'), wrote('/tmp/one.py'),
      user('turn two'), wrote('/tmp/two.py'),
    ]);
    expect(m[0].outOfRepoFiles).toEqual(['/tmp/one.py']);
    expect(m[1].outOfRepoFiles).toEqual(['/tmp/two.py']);
  });

  it('dedups repeated writes to the same outside file', () => {
    const m = mappingsFor([user('twice'), wrote('/tmp/same.py'), wrote('/tmp/same.py')]);
    expect(m[0].outOfRepoFiles).toEqual(['/tmp/same.py']);
  });
});
