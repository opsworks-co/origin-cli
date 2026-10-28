// Launching an agent installed by npm on Windows.
//
// npm (and pnpm, yarn, bun) install a CLI on Windows as a `.cmd` shim that
// runs `node <package>\cli.js %*`. Node refuses to spawn a `.cmd`/`.bat`
// without a shell (EINVAL, since 18.20.2 / 20.12.2), and with a shell the
// arguments are parsed by cmd.exe — twice, once for the command line and once
// for the shim's `%*` — so an issue's title or body (untrusted text holding
// `&`, `|`, `%`, `"`) could run commands. No quoting survives both passes.
//
// So the shim is never run: its target is read out of it, and node (or the
// .exe it points at) is spawned directly with the prompt as argv. A shim this
// cannot read is refused rather than handed to cmd.exe; the caller prints the
// prompt instead.
import fs from 'fs';
import path from 'path';

export interface LaunchTarget {
  file: string;
  args: string[];
}

const SCRIPT = /\.(c|m)?js$/i;
const NATIVE = /\.(exe|com)$/i;

/** The program and argv that run `exe args` without a shell. */
export function launchTarget(
  exe: string, args: string[],
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; findNode?: () => string | null } = {},
): LaunchTarget {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { file: exe, args };
  const target = shimTarget(exe);
  if (!target) throw new Error(`${path.basename(exe)} is a shim Origin cannot read, and running it through cmd.exe would let cmd.exe parse the prompt`);
  if (NATIVE.test(target)) return { file: target, args };
  const local = path.join(path.dirname(exe), 'node.exe');
  const node = isFile(local) ? local : (opts.findNode ?? (() => nodeOnPath(opts.env ?? process.env)))() ?? process.execPath;
  return { file: node, args: [target, ...args] };
}

/**
 * The file a package-manager shim hands `%*` to: the last quoted path before
 * `%*` on a line, with the shim's own folder (`%dp0%`, `%~dp0`) filled in.
 * Null when no line names one that exists, or something other than spaces
 * sits between it and `%*` (extra arguments this does not reproduce).
 */
export function shimTarget(shim: string): string | null {
  let text: string;
  try { text = fs.readFileSync(shim, 'utf-8'); } catch { return null; }
  const dir = path.dirname(shim);
  for (const line of text.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*%\*\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1].replace(/%~?dp0%?/gi, dir + path.sep).replace(/\\/g, path.sep);
    if (raw.includes('%')) continue;
    const file = path.resolve(raw);
    if ((SCRIPT.test(file) || NATIVE.test(file)) && isFile(file)) return file;
  }
  return null;
}

/** The node a shim without its own node.exe would run: the first on PATH. */
function nodeOnPath(env: NodeJS.ProcessEnv): string | null {
  for (const d of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, 'node.exe');
    if (isFile(p)) return p;
  }
  return null;
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
