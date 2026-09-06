// The hook handlers used to live in one file, commands/hooks.ts, and a family
// of guard tests read that file as TEXT to assert that a rule is wired where
// it must be — "the mirror is consulted after the in-repo lookups", "every
// producer stamps a captureId". Those guards are worth keeping, but the code
// now lives in commands/hooks.ts plus commands/hooks/<handler>.ts. This is the
// one place that knows the layout: read everything, in a stable order, so an
// ordering assertion within a handler still holds and a presence assertion
// finds the code wherever it moved.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const commands = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands');

/** Every hooks source file, keyed by its path relative to `commands/`. */
export function hooksSourceFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  out['hooks.ts'] = fs.readFileSync(path.join(commands, 'hooks.ts'), 'utf-8');
  // The ORIGINAL order of the handlers in the one big file, so a guard that
  // slices "from handleStop to handleSessionEnd" still gets handleStop.
  const order = ['session-start', 'user-prompt-submit', 'stop', 'session-end', 'post-commit', 'tool-use', 'after-file-edit', 'git-hooks', 'antigravity'];
  const dir = path.join(commands, 'hooks');
  const present = fs.readdirSync(dir).filter((n) => n.endsWith('.ts')).map((n) => n.replace(/\.ts$/, ''));
  const ordered = [...order.filter((n) => present.includes(n)), ...present.filter((n) => !order.includes(n)).sort()];
  for (const n of ordered) out[`hooks/${n}.ts`] = fs.readFileSync(path.join(dir, `${n}.ts`), 'utf-8');
  return out;
}

/** All hooks source concatenated: hooks.ts first, then the handlers in their original order. */
export function hooksSource(): string {
  return Object.values(hooksSourceFiles()).join('\n');
}

/** The source of ONE handler module (e.g. 'post-commit'), for ordering assertions. */
export function hookModuleSource(name: string): string {
  return fs.readFileSync(path.join(commands, 'hooks', `${name}.ts`), 'utf-8');
}
