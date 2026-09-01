// Origin writes one context file per agent and refreshes it on every session.
// Three places have to agree on which files those are:
//
//   1. packages/cli/src/commands/hooks.ts   MANAGED_REPO_CONTEXT_PATHS  (what we WRITE)
//   2. packages/cli/src/ignore-patterns.ts  ORIGIN_AUTHORED_CONTEXT_PATHS (capture-time)
//   3. apps/api/src/utils/auto-managed-files.ts                          (read-time)
//
// They are three separate builds held together by comments, and they had
// already drifted: a bare `copilot-instructions.md` matched the CLI set and
// not the API set, so the same file was Origin's own bookkeeping at capture
// time and the agent's work at read time. A file in (1) but missing from
// (2)/(3) is worse — Origin bills its own injected context to the agent, in
// every session of every repo that has one.
//
// GOLDEN is duplicated verbatim in the API-side twin of this test on purpose:
// that is what makes a one-sided edit fail a suite instead of drifting.
import { describe, it, expect } from 'vitest';
import {
  ORIGIN_AUTHORED_CONTEXT_PATHS,
  isOriginAutoManagedPath,
  partitionOriginAuthored,
} from '../ignore-patterns.js';
import { MANAGED_REPO_CONTEXT_PATHS } from '../commands/hooks.js';

const GOLDEN = [
  '.devin/rules/origin.md',
  '.github/copilot-instructions.md',
  '.windsurfrules',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
];

describe('Origin-authored context files', () => {
  it('matches the golden list (keep the API-side twin in step)', () => {
    expect([...ORIGIN_AUTHORED_CONTEXT_PATHS].sort()).toEqual(GOLDEN);
  });

  it('covers every file Origin actually writes', () => {
    // MANAGED_REPO_CONTEXT_PATHS is built with path.join, so it is
    // platform-separated; compare on posix form.
    const written = MANAGED_REPO_CONTEXT_PATHS.map((p) => p.split(/[\\/]/).join('/'));
    for (const p of written) {
      expect(isOriginAutoManagedPath(p), `Origin writes ${p} but capture treats it as agent work`).toBe(true);
    }
    expect(written.slice().sort()).toEqual(GOLDEN);
  });

  it('matches a nested file by full path AND by bare basename', () => {
    // The drift that was already live: capture paths pass a repo-relative
    // path, some read paths pass only a basename.
    for (const p of ['.github/copilot-instructions.md', 'copilot-instructions.md']) {
      expect(isOriginAutoManagedPath(p)).toBe(true);
    }
  });

  it('does not claim a user file that merely looks similar', () => {
    for (const p of ['docs/CLAUDE.md.bak', 'src/agents.md.ts', 'my-CLAUDE.md', '.gitignore', 'origin.md', 'docs/origin.md']) {
      expect(isOriginAutoManagedPath(p), `${p} is the user's file`).toBe(false);
    }
  });

  it('partitions a mixed list without losing or duplicating a file', () => {
    const files = ['src/app.ts', 'CLAUDE.md', 'README.md', '.github/copilot-instructions.md'];
    const { agent, origin } = partitionOriginAuthored(files);
    expect(agent).toEqual(['src/app.ts', 'README.md']);
    expect(origin).toEqual(['CLAUDE.md', '.github/copilot-instructions.md']);
    // Every input lands in exactly one half — a surface can show both and
    // still add up to what git reported.
    expect([...agent, ...origin].sort()).toEqual([...files].sort());
  });
});
