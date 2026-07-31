import { describe, it, expect } from 'vitest';
import {
  isValidCodexThreadId,
  buildCodexThreadByIdQuery,
  buildCodexThreadByCwdQuery,
} from '../codex-thread-query.js';

// The heartbeat daemon used to resolve a session's Codex thread with
// `cwd LIKE '%<repoBasename>%' ORDER BY updated_at DESC` — any newer thread
// whose cwd merely CONTAINED the repo basename (sibling dir, foreign repo,
// meta-call thread) matched first, and pushInflightCodexState then overwrote
// state.prompts with that foreign conversation. These tests pin the shared
// strict builder: exact id, exact cwd, never LIKE, never newest-overall.
describe('codex-thread-query strict builder', () => {
  it('builds an exact by-id query for a valid thread id', () => {
    const q = buildCodexThreadByIdQuery('id, rollout_path', '019f35c3-edd0-7891-bbf6-3e219058578c');
    expect(q).toBe(
      "SELECT id, rollout_path FROM threads WHERE id = '019f35c3-edd0-7891-bbf6-3e219058578c' LIMIT 1;",
    );
  });

  it('returns null (no by-id query) for missing or unsafe thread ids', () => {
    expect(buildCodexThreadByIdQuery('id', undefined)).toBeNull();
    expect(buildCodexThreadByIdQuery('id', null)).toBeNull();
    expect(buildCodexThreadByIdQuery('id', '')).toBeNull();
    expect(buildCodexThreadByIdQuery('id', "abc' OR 1=1 --")).toBeNull(); // injection shape
    expect(buildCodexThreadByIdQuery('id', 'has space')).toBeNull();
  });

  it('builds an exact-cwd query — IN over separator variants, not LIKE', () => {
    const q = buildCodexThreadByCwdQuery('id', '/Users/x/code/origin');
    expect(q).toMatch(/WHERE cwd IN \(/);
    expect(q).toContain("'/Users/x/code/origin'");
    expect(q).toMatch(/ORDER BY updated_at DESC LIMIT 1;$/);
    expect(q).not.toMatch(/LIKE/i);
    expect(q).not.toContain('%');
  });

  it('matches Codex\'s native backslash cwd on Windows (the empty-session bug)', () => {
    // Origin normalizes repoPath to forward slashes; Codex (native) stores the
    // OS-native backslash cwd. The IN list must contain BOTH so the lookup
    // succeeds on Windows instead of returning zero prompts → empty session.
    const q = buildCodexThreadByCwdQuery('id', 'C:/soft/origin-demo-1');
    expect(q).toContain("'C:/soft/origin-demo-1'");
    expect(q).toContain("'C:\\soft\\origin-demo-1'");
  });

  it('escapes single quotes in every cwd variant', () => {
    const q = buildCodexThreadByCwdQuery('id', "/Users/x/it's-a-repo");
    expect(q).toContain("'/Users/x/it''s-a-repo'");
  });

  it('a basename-substring sibling cwd can never match (still strict content, no LIKE)', () => {
    // With the old LIKE '%origin%' both '/Users/x/code/origin' and
    // '/Users/x/code/origin-backup' matched; exact-content IN pins the path.
    const q = buildCodexThreadByCwdQuery('id', '/Users/x/code/origin');
    expect(q).toContain("'/Users/x/code/origin'");
    expect(q).not.toContain('origin-backup');
    expect(q).not.toContain('%');
  });

  it('isValidCodexThreadId accepts uuid-ish ids and rejects everything else', () => {
    expect(isValidCodexThreadId('019f35c3-edd0-7891-bbf6-3e219058578c')).toBe(true);
    expect(isValidCodexThreadId('abc_DEF-123')).toBe(true);
    expect(isValidCodexThreadId("x'; DROP TABLE threads; --")).toBe(false);
    expect(isValidCodexThreadId('')).toBe(false);
    expect(isValidCodexThreadId(undefined)).toBe(false);
    expect(isValidCodexThreadId(null)).toBe(false);
  });
});
