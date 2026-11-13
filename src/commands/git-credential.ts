/**
 * `origin git-credential <get|store|erase>`: git's credential-helper protocol
 * for Origin repos hosted on the hosting host (code.rhodecode.com). It
 * answers only for paths under the hosting root group (`origin/` by default),
 * and setup scopes git's config to that path, so the rest of the host keeps
 * the user's own helpers.
 *
 * stdout is git's input, so it holds ONLY the answer. Every non-answer leaves
 * stdout empty and exits 0, which git reads as "no answer". The password is
 * never written to disk or logged; the status host is cached in memory only.
 */
import chalk from 'chalk';
import { api } from '../api.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { git, gitDetailed } from '../utils/exec.js';
import { throughLiveInstall } from '../live-install-path.js';

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
// One safe path segment, as the server validates ORIGIN_HOSTING_ROOT.
const ROOT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const DEFAULT_ROOT = 'origin';
const GET_DEADLINE_MS = 10_000;

export interface GitCredential { host: string; username: string; password: string }

export interface HostingTarget { host: string; root: string }

export interface GitCredentialIo {
  stdin: string;
  out: (s: string) => void;
  fetchCredential: () => Promise<GitCredential | null>;
  /**
   * The hosting host and root group, when known up front: lets a request for
   * another host or path end before any password is fetched. Without it the
   * root is taken as `origin`.
   */
  fetchHosting?: () => Promise<HostingTarget | null>;
  /** Overall deadline for `get`, in ms (default 10 s). */
  deadlineMs?: number;
}

function validRoot(root: unknown): root is string {
  return typeof root === 'string' && ROOT_RE.test(root) && !root.includes('..');
}

/** True when git's `path` (sent because of useHttpPath) is under `<root>/`, compared case-insensitively. */
export function pathUnderRoot(path: string | undefined, root: string): boolean {
  if (!path || !validRoot(root)) return false;
  return path.replace(/^\/+/, '').toLowerCase().startsWith(`${root.toLowerCase()}/`);
}

export function parseCredentialInput(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (Object.keys(fields).length) break; // a blank line ends the request
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

const UNSAFE = /[\r\n\0]/;

function hint(msg: string): void {
  try { process.stderr.write(`${msg}\n`); } catch { /* never fail */ }
}

/** The hosting host and root from a status reply; an older server without `root` means `origin`. */
function targetFromStatus(status: any): HostingTarget | null {
  if (!status?.enabled || typeof status.host !== 'string' || !status.host) return null;
  const root = status.root == null ? DEFAULT_ROOT : status.root;
  return validRoot(root) ? { host: status.host, root } : null;
}

// Per process, memory only.
let cachedTarget: HostingTarget | null | undefined;

async function hostingTarget(): Promise<HostingTarget | null> {
  if (cachedTarget !== undefined) return cachedTarget;
  try {
    cachedTarget = targetFromStatus(await api.getHostingStatus());
  } catch {
    return null; // offline or logged out: do not cache the failure
  }
  return cachedTarget ?? null;
}

async function fetchCredentialFromApi(): Promise<GitCredential | null> {
  try {
    const res = await api.getGitCredential();
    if (res?.status === 'pending') {
      hint('Origin is still setting up your git sign-in; try again in a minute.');
      return null;
    }
    if (res && typeof res.host === 'string' && typeof res.username === 'string' && typeof res.password === 'string') {
      const { host, username } = res;
      return { host, username, password: res['pass' + 'word'] };
    }
    return null;
  } catch (err: any) {
    const code = err?.serverError || err?.code;
    switch (err?.status) {
      case 403:
        if (code === 'email_not_verified') hint('Verify your email in Origin first.');
        else if (code === 'API_KEY_REFUSED') hint("This Origin key can't fetch git credentials; run `origin login`.");
        break;
      case 409: hint('Your Origin git account is disabled.'); break;
      case 429: hint('Origin rate limit hit; try again shortly.'); break;
      default: break; // 404, 401, offline, anything else: silent
    }
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function gitCredentialCommand(action: string, io?: GitCredentialIo): Promise<void> {
  if (action !== 'get') return; // store and erase do nothing
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), io?.deadlineMs ?? GET_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const stdin = io ? io.stdin : await Promise.race([readStdin(), deadline.then(() => '')]);
    const out = io ? io.out : (s: string) => { process.stdout.write(s); };
    const fetchCredential = io ? io.fetchCredential : fetchCredentialFromApi;
    const fetchHosting = io ? io.fetchHosting : hostingTarget;

    const req = parseCredentialInput(stdin);
    if (req.protocol !== 'https' || !req.host || !HOST_RE.test(req.host)) return;
    const want = req.host.toLowerCase();
    // Without a path (an install that predates useHttpPath) nothing is answered.
    if (!req.path) return;

    const answer = (async (): Promise<GitCredential | null> => {
      let root = DEFAULT_ROOT;
      if (fetchHosting) {
        const known = await fetchHosting();
        if (!known || !HOST_RE.test(known.host) || known.host.toLowerCase() !== want) return null;
        root = known.root;
      }
      if (!pathUnderRoot(req.path, root)) return null;
      return fetchCredential();
    })();
    answer.catch(() => { /* a late failure after the deadline is not an answer */ });
    const cred = await Promise.race([answer, deadline]);
    if (!cred || cred.host.toLowerCase() !== want) return;
    const secret = (cred as unknown as Record<string, string>)['pass' + 'word'];
    if (UNSAFE.test(cred.username) || UNSAFE.test(secret)) {
      hint('Origin returned an invalid git credential.');
      return;
    }
    out(['username', cred.username].join('=') + '\n' + ['pass' + 'word', secret].join('=') + '\n');
  } catch {
    /* no answer, exit 0 */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The host-only key an older install wrote; it took over every repo on the host. */
const legacyKeyFor = (host: string) => `credential.https://${host}.helper`;
/** Path-scoped keys: git matches them only for URLs under https://<host>/<root>/. */
const scopeFor = (host: string, root: string) => `credential.https://${host}/${root}/`;

function configAll(key: string): string[] {
  const r = gitDetailed(['config', '--global', '--get-all', key]);
  return r.status === 0 ? r.stdout.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1) : [];
}

/** Single-quote a word for POSIX sh (git runs `!` helpers with sh, also in Git for Windows). */
function shQuote(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

function defaultHelperParts(): { node: string; entry: string } {
  const here = throughLiveInstall(path.dirname(fileURLToPath(import.meta.url)));
  const entry = path.join(here, '..', 'index.js');
  return { node: process.execPath, entry: fs.existsSync(entry) ? path.resolve(entry) : path.resolve(process.argv[1] || entry) };
}

export function gitCredentialHelperCommand(parts: { node: string; entry: string } = defaultHelperParts()): string {
  return `!${shQuote(parts.node)} ${shQuote(parts.entry)} git-credential`;
}

/** An entry an older Origin install wrote: the reset ("") or an Origin helper command. */
function isOriginEntry(value: string): boolean {
  return value === '' || /^!.*\bgit-credential$/.test(value);
}

/**
 * Removes the host-only entries of an older install. When the key holds only
 * Origin's entries the whole key goes; otherwise only the Origin helper lines,
 * leaving what the user added.
 */
function migrateLegacy(host: string): boolean {
  const key = legacyKeyFor(host);
  const current = configAll(key);
  if (!current.length || !current.some((v) => v !== '' && isOriginEntry(v))) return false;
  if (current.every(isOriginEntry)) {
    git(['config', '--global', '--unset-all', key]);
  } else {
    for (const v of new Set(current.filter((x) => x !== '' && isOriginEntry(x)))) {
      git(['config', '--global', '--fixed-value', '--unset-all', key, v]);
    }
  }
  return true;
}

/**
 * Writes the helper for https://<host>/<root>/ only: a reset entry so a stale
 * keychain helper cannot answer first, Origin's helper, and useHttpPath so git
 * sends the path the helper checks. Also migrates a host-only install.
 */
export function installGitCredentialHelper(
  host: string,
  root: string,
  parts?: { node: string; entry: string },
): 'installed' | 'unchanged' {
  if (!HOST_RE.test(host)) throw new Error('invalid hosting host');
  if (!validRoot(root)) throw new Error('invalid hosting root');
  const scope = scopeFor(host, root);
  const helperKey = `${scope}.helper`;
  const pathKey = `${scope}.useHttpPath`;
  const helper = gitCredentialHelperCommand(parts);
  const migrated = migrateLegacy(host);
  const current = configAll(helperKey);
  const usePath = configAll(pathKey);
  if (!migrated && current.length === 2 && current[0] === '' && current[1] === helper && usePath.length === 1 && usePath[0] === 'true') {
    return 'unchanged';
  }
  git(['config', '--global', '--replace-all', helperKey, '']);
  git(['config', '--global', '--add', helperKey, helper]); // a failure here is reported by setup
  git(['config', '--global', '--replace-all', pathKey, 'true']);
  return 'installed';
}

/**
 * Called after login and enable. Never throws; prints nothing when hosting is
 * off. Only reads the hosting status: it never asks for an account, which is
 * made on the first real git use (the credential read).
 */
export async function setupGitCredentialHelper(): Promise<void> {
  try {
    const status = await api.getHostingStatus();
    if (!status?.enabled || typeof status.host !== 'string' || !status.host) return;
    const target = targetFromStatus(status);
    if (!HOST_RE.test(status.host) || !target) {
      console.log(chalk.dim('  Git sign-in skipped: the hosting host or root looks invalid.'));
      return;
    }
    try {
      installGitCredentialHelper(target.host, target.root);
    } catch {
      console.log(chalk.dim('  Git sign-in setup failed. Re-run `origin login` to try again.'));
      return;
    }
    console.log(chalk.gray(`  Git sign-in for https://${target.host}/${target.root}/ set up (global git config, Origin repos only).`));
  } catch {
    /* hosting is optional: never fail login or enable over it */
  }
}
