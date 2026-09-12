import fs from 'fs';
import path from 'path';

// ─── Default Ignore Patterns ──────────────────────────────────────────────

const DEFAULT_IGNORE_PATTERNS = [
  // Interpreter caches — never authored, and their atomic-write temp names
  // (`x.cpython-314.pyc.4392877312`) defeat a plain `*.pyc`.
  '__pycache__',
  '__pycache__/**',
  '*.pyc',
  '*.pyc.*',
  // Lock files
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'Pipfile.lock',
  'shrinkwrap.yaml',
  // Generated / minified
  '*.generated.*',
  '*.min.js',
  '*.min.css',
  '*.map',
  // Directories
  '**/node_modules/**',
  // pnpm's content-addressable store. A sandbox `pnpm install` in a worktree
  // materialises `.pnpm-store/v10/**` as untracked files; session 562314d8
  // billed that as 51 files / +5262 on a chat turn. Same class as
  // node_modules — never authored, never the agent's work.
  '**/.pnpm-store/**',
  '**/vendor/**',
  '**/__snapshots__/**',
  '**/dist/**',
  '**/.next/**',
  '**/build/**',
  // Snapshots
  '**/*.snap',
  '**/*.snap.new',
  // Database migrations metadata.
  //
  // `drizzle/meta` is pure bookkeeping — a journal plus snapshot JSON the tool
  // regenerates — so the whole directory goes.
  //
  // Prisma's is NOT. `**/prisma/migrations/**` used to match here too, and it
  // took the migration BODIES with it: a hand-written `migration.sql` is the
  // schema change, reviewed and argued over like any other source file. Losing
  // it is not cosmetic — the file reaches no turn's file list, no per-prompt
  // diff, and no AI Blame, while the session header still counts it (that comes
  // from git, not the journal). The session then reads "11 of 12 files" with no
  // way to find the twelfth. Observed on 824daa22, whose
  // `20260907_repo_memory/migration.sql` was authored, committed and invisible.
  //
  // Only the lock file is genuinely generated bookkeeping, so only it is
  // ignored. A migration body that Prisma DID generate is captured, and that is
  // the right answer for the same reason `package-lock.json`'s sibling
  // generated files are: the agent caused it and it ships in the commit.
  '**/drizzle/meta/**',
  '**/prisma/migrations/migration_lock.toml',
  // Origin auto-managed agent-rules files. The CLI writes these as a
  // per-repo agent rules buffer (`<!-- origin-managed -->` blocks); the
  // churn they generate is bookkeeping, not the agent's actual work, and
  // pollutes per-prompt AI Blame attribution. AGENTS.md / GEMINI.md /
  // .windsurfrules are *exclusively* Origin-managed (users don't hand-edit
  // them), so blanket-ignoring is safe. We DO NOT add CLAUDE.md here —
  // many projects maintain that file themselves; we only strip the
  // Origin-marker section from those, not the whole file.
  'AGENTS.md',
  'GEMINI.md',
  '.windsurfrules',
  '.devin/rules/origin.md',
  // Origin's own hook-config files, written by `origin enable`. They are our
  // bookkeeping, not the agent's work — when enable runs in a repo they land
  // as untracked additions and would otherwise be attributed to the next
  // session (this is exactly what showed up as the phantom "+72" on the first
  // native-Windows session: .devin/hooks.v1.json + .windsurf/hooks.json).
  // Shared settings files (.claude/settings.json, .gemini/settings.json) are
  // deliberately NOT here — a user may hand-edit those.
  '.devin/hooks.v1.json',
  '.windsurf/hooks.json',
  '.cursor/hooks.json',
  '.codex/hooks.json',
  '.github/hooks/origin.json',
  '.agents/hooks.json',
  // Claude Code's dev-server launch config. The harness WRITES THIS ITSELF,
  // unprompted: opening the Browser pane creates `.claude/launch.json` when the
  // project has none, so it appears in a turn nobody asked to configure
  // anything in. Prod 4968c7df turn 1 was "honestly, I think the design of our
  // website is shit… What do you think?" — a pure opinion question, whose
  // ledger recorded `{file: ".claude/launch.json", op: "create"}` and +11
  // authored lines. Turn 7 ("what is next?") then carried the matching -11 when
  // the file was removed, which is why the session footer read
  // `-161 authored · -172 across turns`.
  //
  // Sits with the hook-config files above rather than with
  // `.claude/settings.json` below for one reason: a person writes settings.json,
  // and tooling writes this. A user who does hand-maintain a launch config
  // loses attribution for it, which is the right side to err on — a question
  // turn claiming to have authored a file is the worse error.
  '.claude/launch.json',
  // Claude Code's parallel-branch worktrees. They show up as submodule
  // (160000 mode) entries in git diff when Cursor / other agents run in
  // a repo that previously hosted Claude Code worktrees. They aren't the
  // current agent's work — strip them.
  '**/.claude/worktrees/**',
  '.claude/worktrees/*',
  // Origin's own `origin-sessions` branch publish artifacts. Publishing a
  // session writes exactly these three files under `sessions/<session-id>/`
  // (see session-store.ts — `SessionFile` is a closed set). They live only on
  // the orphan branch, but the publish COMMIT gets swept into a session's
  // capture and stamped onto whichever prompt is open: prod f4704142's
  // chat-only prompt 0 ("what the fuck is going on?") rendered 3 files /
  // +89 lines that were entirely Origin describing itself.
  //
  // Narrow on purpose. `sessions/` is an ordinary directory name, so
  // `sessions/**` would hide a user's own code — the .gitignore mistake in a
  // new costume. Only these three basenames, and only one level down.
  'sessions/*/metadata.json',
  'sessions/*/prompts.md',
  'sessions/*/changes.json',
];

// ─── Glob Matching ────────────────────────────────────────────────────────

/**
 * Simple glob matcher supporting *, **, and ? wildcards.
 * Handles the patterns we need without pulling in a dependency.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(?:.+/)?';
          i += 3;
          continue;
        }
        regex += '.*';
        i += 2;
        continue;
      }
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (c === '.') {
      regex += '\\.';
    } else if (c === '/' || c === '\\') {
      regex += '/';
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp(`^${regex}$`);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check if a file path should be ignored based on patterns.
 * Patterns can be globs (e.g., "*.lock") or exact matches.
 *
 * A `<dir>/**` pattern also matches `<dir>` ITSELF.
 *
 * Every directory entry above compiles to `^(?:.+/)?node_modules/.*$` — a
 * regex that requires a trailing slash and something after it, so it covers
 * the directory's CONTENTS and never the directory. `packages/cli/node_modules`
 * returned false while `packages/cli/node_modules/foo.js` returned true.
 *
 * That is only a distinction on paper until a capture path records a
 * directory as a single entry, which several do: the shell probe stamps
 * whatever the tree walk hands it, and git reports a submodule or a symlinked
 * directory as one path with no children. Measured here — `packages/cli/node_modules`
 * (a symlink) landed in a turn's shellProbes stamps and was not filtered out.
 *
 * Stripping the trailing `/**` and testing that too costs one extra regex per
 * directory pattern and makes `<dir>` and `<dir>/anything` agree, which is what
 * every one of these patterns already meant.
 */
export function shouldIgnoreFile(filePath: string, customPatterns?: string[]): boolean {
  const patterns = [...DEFAULT_IGNORE_PATTERNS, ...(customPatterns || [])];
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized);

  for (const pattern of patterns) {
    // Check against full path and basename
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalized) || regex.test(basename)) {
        return true;
      }
      // …and, for a directory pattern, against the bare directory.
      if (pattern.endsWith('/**')) {
        const dirRegex = globToRegex(pattern.slice(0, -3));
        if (dirRegex.test(normalized) || dirRegex.test(basename)) {
          return true;
        }
      }
    } catch {
      // If glob parsing fails, try exact match
      if (normalized.endsWith(pattern) || basename === pattern) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Load additional ignore patterns from .gitattributes (linguist-generated).
 */
export function loadGitattributesPatterns(repoPath: string): string[] {
  const patterns: string[] = [];
  try {
    const content = fs.readFileSync(path.join(repoPath, '.gitattributes'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.includes('linguist-generated') || trimmed.includes('linguist-vendored')) {
        const filePart = trimmed.split(/\s+/)[0];
        if (filePart) patterns.push(filePart);
      }
    }
  } catch {
    // No .gitattributes or unreadable
  }
  return patterns;
}

/**
 * Get the combined ignore patterns for a repo.
 */
export function getIgnorePatterns(repoPath: string, customPatterns?: string[]): string[] {
  return [
    ...DEFAULT_IGNORE_PATTERNS,
    ...loadGitattributesPatterns(repoPath),
    ...(customPatterns || []),
  ];
}

export { DEFAULT_IGNORE_PATTERNS };

/**
 * Remove `diff --git` sections whose target file is ignored. Walks a
 * unified diff text and drops any section whose `b/<path>` header matches
 * an ignore pattern. Order-preserving, returns the trimmed remainder.
 *
 * Used by git-capture so the per-prompt diffs we ship to the platform
 * don't include Origin's auto-managed agent-rules files (AGENTS.md,
 * GEMINI.md, etc.) — that churn would otherwise show up as
 * AI-attributed lines in the blame view.
 */
// Files Origin writes to on every session start. These are agent-context
// files (the agent reads them at runtime) but they're pure bookkeeping in
// the per-prompt diff / blame view — drop them at capture time so the
// platform never receives a "filesChanged" entry for them.
// The repo files Origin WRITES ITSELF — the per-agent context files whose
// `<!-- origin-managed -->` block Origin refreshes on every session.
//
// KEEP IN SYNC with two other places, or Origin's own bookkeeping is agent
// work on one side of the system and not the other:
//   - packages/cli/src/commands/hooks.ts  MANAGED_REPO_CONTEXT_PATHS (what we write)
//   - apps/api/src/utils/auto-managed-files.ts  (the read-time twin, separate build)
// `origin-authored-parity.test.ts` pins this list on both sides so a change to
// one fails the other's suite instead of drifting silently. It already had:
// a bare `copilot-instructions.md` was Origin-managed to the CLI and agent
// work to the API.
//
// Cursor's `~/.cursor/rules/origin.md` is deliberately absent — it lives in
// $HOME, never in the repo, so it can never appear in a commit.
export const ORIGIN_AUTHORED_CONTEXT_PATHS: readonly string[] = Object.freeze([
  'CLAUDE.md',            // claude-code
  'AGENTS.md',            // codex, antigravity
  'GEMINI.md',            // gemini
  '.devin/rules/origin.md',           // devin
  '.github/copilot-instructions.md',  // copilot
  '.windsurfrules',       // legacy (pre-Devin rebrand); still refreshed where present
]);


// Basenames that may ALSO be matched on their own, for surfaces that pass a
// bare filename. Only names distinctive enough to be unambiguous: a file
// called `copilot-instructions.md` anywhere is Origin's, but `origin.md` is
// not — a user's own `docs/origin.md` must stay their work. Matching every
// basename would hide real files, which is the .gitignore mistake described
// below in a new costume.
export const ORIGIN_AUTHORED_BASENAME_ALIASES: readonly string[] = Object.freeze([
  'copilot-instructions.md',
]);

const ORIGIN_AUTO_MANAGED_BASENAMES = new Set<string>([
  ...ORIGIN_AUTHORED_CONTEXT_PATHS,
  // Match on basename too: the same file is referred to by full path in some
  // capture paths and by basename in others.
  ...ORIGIN_AUTHORED_BASENAME_ALIASES,
  // .gitignore is intentionally NOT in this set — see the matching
  // explanation in apps/api/src/utils/auto-managed-files.ts. Hiding
  // user-requested .gitignore changes from the captured diff caused
  // commit-list vs commit-detail to disagree on totals and silently
  // censored honest agent attribution.
]);

/**
 * Whether a path is one of Origin's OWN bookkeeping files. Exported so the
 * capture paths that build a file LIST (not a diff) can drop them with the
 * same rule `stripIgnoredSectionsFromDiff` applies to diff text — otherwise
 * Origin bills its own injected context as the agent's work.
 */
export function isOriginAutoManagedPath(filePath: string): boolean {
  const clean = String(filePath || '').replace(/^\.\//, '');
  if (!clean) return false;
  if (ORIGIN_AUTO_MANAGED_BASENAMES.has(clean)) return true;
  return ORIGIN_AUTO_MANAGED_BASENAMES.has(clean.split('/').pop() || '');
}

/**
 * Split a file list into the agent's own work and the files ORIGIN wrote.
 *
 * Every existing caller drops Origin's files silently, which is right for
 * attribution (Origin's bookkeeping is not the agent's work) but wrong for
 * disclosure: Origin refreshes CLAUDE.md / AGENTS.md / GEMINI.md on every
 * session, the user commits them along with real work, and no surface ever
 * says so. The reviewer sees a commit touching CLAUDE.md with no indication
 * that a tool wrote it rather than the agent.
 *
 * Returning both halves lets a surface show the split instead of choosing
 * between "misattribute it" and "hide it". Totals stay whatever the caller
 * decides — deliberately NOT changed here, because silently removing files
 * from one total and not another is exactly what made commit-list and
 * commit-detail disagree over .gitignore.
 */
export function partitionOriginAuthored(files: Iterable<string>): {
  agent: string[];
  origin: string[];
} {
  const agent: string[] = [];
  const origin: string[] = [];
  for (const f of files) {
    if (!f) continue;
    (isOriginAutoManagedPath(f) ? origin : agent).push(f);
  }
  return { agent, origin };
}

export function stripIgnoredSectionsFromDiff(
  diffText: string,
  customPatterns?: string[],
): string {
  if (!diffText) return diffText;
  // Split keeping the leading "diff --git " marker on each section.
  const parts = diffText.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  for (const part of parts) {
    const header = part.split('\n', 1)[0] || '';
    const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = m ? m[2] : '';
    if (filePath && shouldIgnoreFile(filePath, customPatterns)) continue;
    const basename = filePath.split('/').pop() || '';
    if (ORIGIN_AUTO_MANAGED_BASENAMES.has(basename)) continue;
    kept.push(part);
  }
  return trimDiffText(kept.join(''));
}

/**
 * Trim diff text WITHOUT destroying a trailing empty context line.
 *
 * `.trim()` cannot be used on a unified diff. An unchanged blank line is
 * emitted as a single space, so a file ending in a blank line produces a diff
 * ending `…\n \n` — and `.trim()` eats that last `" "` along with the newline.
 * The hunk body is then ONE LINE SHORT of the count in its `@@` header: `git
 * apply` rejects it, and `verify-capture` reports `diff_unparseable`.
 *
 * Measured on session `593241fe` turn 9 (2026-09-11): a whole-file diff of
 * `packages/cli/src/transcript.ts`, which ends `}\n\n`, stored with a header
 * claiming `@@ -1,3186 +1,3228 @@` over a body of 3185/3227 lines.
 *
 * `\n+$` is the correct stripper and is what the commit-patch path at
 * git-capture.ts already used: an empty context line is a SPACE, so it
 * survives, while the trailing newline does not. Only `-`/`+` lines for blank
 * lines were ever safe under `.trim()` — they are not whitespace-only.
 */
export function trimDiffText(diffText: string): string {
  return String(diffText || '').replace(/^\n+/, '').replace(/\n+$/, '');
}
