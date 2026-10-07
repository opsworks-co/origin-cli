// The built CLI's session start, in a repo whose CLAUDE.md an older Origin
// created for its notice alone: Claude Code then skips the user's AGENTS.md.
// Origin warns on the session's first screen and leaves the file where it is —
// deleting a file in the user's repo is the user's call, not Origin's.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { commitFiles, createHarness, haveDist } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const M = '<!-- origin-managed -->';
const T = 60_000 * WINDOWS_SLOWDOWN;

describe.skipIf(!haveDist)('a CLAUDE.md holding only Origin\'s block', () => {
  it('is reported at session start and never deleted', async () => {
    const h = await createHarness('origin-only-claude-md-0001', 'origin-only-claude-md-server');
    try {
      commitFiles(h, {
        'CLAUDE.md': `${M}\nOrigin: Session tracking active.\n${M}\n`,
        'AGENTS.md': '# Use pnpm, never npm\n',
      }, 'base');
      const s = await h.run('session-start', { source: 'startup' });
      expect(s.code, s.stderr).toBe(0);
      expect(s.stderr).toContain("this repo's CLAUDE.md holds only Origin's block");
      expect(fs.existsSync(path.join(h.repo, 'CLAUDE.md'))).toBe(true);
      expect(fs.readFileSync(path.join(h.repo, 'AGENTS.md'), 'utf-8')).toBe('# Use pnpm, never npm\n');
    } finally {
      await h.close();
    }
  }, T);

  it('says nothing once the user has their own line in CLAUDE.md', async () => {
    const h = await createHarness('origin-only-claude-md-0002', 'origin-only-claude-md-server-2');
    try {
      commitFiles(h, {
        'CLAUDE.md': `# Claude notes\n\n${M}\nOrigin: Session tracking active.\n${M}\n`,
        'AGENTS.md': '# Use pnpm, never npm\n',
      }, 'base');
      const s = await h.run('session-start', { source: 'startup' });
      expect(s.code, s.stderr).toBe(0);
      expect(s.stderr).not.toContain('holds only Origin');
    } finally {
      await h.close();
    }
  }, T);
});
