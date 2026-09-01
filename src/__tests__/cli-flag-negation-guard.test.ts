// commander reads `--no-foo` as NEGATING `foo`: it sets `opts.foo = false` and
// never defines `opts.noFoo`. So a handler that reads `opts.noFoo` gets
// `undefined` — the flag parses, the help text lists it, the user passes it,
// and it does nothing.
//
// `origin repair-merges --no-turn-rules` was exactly that, and its handler
// then ran the very inference it promised to skip: it rewrote two prod rows,
// stamping a merge onto a chat-only turn. An inert flag is worse than a
// missing one, because it reads as a safeguard.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** camelCase name commander derives from a long flag. */
const camel = (flag: string) =>
  flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

describe('no option is declared --no-* while its handler reads noX', () => {
  const index = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf-8');
  const negated = [...index.matchAll(/\.option\('(--no-[a-z][\w-]*)'/g)].map((m) => m[1]);

  it.each(negated.length ? negated : [['(none declared)']].map(() => '--no-op-placeholder'))(
    '%s does not have a handler reading its noX form',
    (flag) => {
      if (flag === '--no-op-placeholder') return; // nothing declared; vacuously safe
      // What a handler would WRONGLY read: `--no-turn-rules` → `noTurnRules`.
      const wrong = 'no' + camel(flag).charAt(0).toUpperCase() + camel(flag).slice(1);
      const commands = fs.readdirSync(path.join(SRC, 'commands'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => fs.readFileSync(path.join(SRC, 'commands', f), 'utf-8'))
        .join('\n');
      expect(commands).not.toContain(`opts.${wrong}`);
    },
  );

  it('repair-merges reads the affirmative option it actually declares', () => {
    const cmd = fs.readFileSync(path.join(SRC, 'commands', 'repair-merges.ts'), 'utf-8');
    expect(index).toContain(".option('--skip-turn-rules'");
    // The DECLARATION, not the prose: the comment above it names the trap.
    expect(index).not.toContain(".option('--no-turn-rules'");
    expect(cmd).toContain('opts.skipTurnRules');
  });
});
