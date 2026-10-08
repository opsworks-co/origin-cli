// Claude Code runs `origin hooks claude-code pre-tool-use` and `post-tool-use`
// around EVERY tool call, so the entrypoint's own load time is paid twice per
// tool call. When index.ts statically imported every command module, that was
// ~250 ms of loading ~90 modules no hook ever runs. Command modules now load on
// first use; this pins that a new command can't quietly bring the static
// import back.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf-8');

// Local modules the entrypoint itself needs at startup: tiny, and
// error-sanitize must patch console before any command runs.
const ALLOWED_STATIC = new Set(['./build-info.js', './error-sanitize.js']);

describe('index.ts loads command modules lazily', () => {
  it('statically imports no local module beyond the startup allowlist', () => {
    const staticLocal = [...index.matchAll(/^import\s[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => m[1]);
    expect(staticLocal.filter((p) => !ALLOWED_STATIC.has(p))).toEqual([]);
  });

  it('still binds every handler through a dynamic import', () => {
    // Spot-check the hot path and a few ordinary commands.
    for (const name of ['hooksCommand', 'handlePostCommit', 'loginCommand', 'sessionsCommand', 'checkForUpdate']) {
      expect(index).toMatch(new RegExp(`const ${name} = lazy\\(\\(\\) => import\\('\\./[^']+'\\), '${name}'\\);`));
    }
  });
});
