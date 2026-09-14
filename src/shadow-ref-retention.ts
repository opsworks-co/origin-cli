import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { git, gitDetailed } from './utils/exec.js';
import { SHADOW_IDENTITY_EMAIL } from './git-capture.js';

const PREFIX = 'refs/origin/shadow/';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
interface ShadowRef { name: string; sha: string }

/** Read ALL saved sessions, including ended/unsynced ones. Staleness is not
 * evidence that a session can no longer resume. Include legacy per-worktree
 * state, the sandbox fallback/mirror, durable uploads and journal boundaries.
 * Any incomplete/unreadable evidence aborts cleanup rather than acting empty.
 */
function protectionInventory(commonDir: string, originHome: string) {
  const hashes = new Set<string>();
  const owners = new Set<string>();
  const fingerprint = crypto.createHash('sha256');
  let bytes = 0;
  function strings(value: unknown, key = ''): void {
    if (typeof value === 'string') {
      for (const hash of value.match(/\b[0-9a-f]{7,64}\b/gi) || []) hashes.add(hash.toLowerCase());
      if (/^(sessionId|sessionTag|agentSessionId|claudeSessionId)$/.test(key) && value) {
        owners.add(value);
        owners.add(value.slice(0, 12));
      }
    } else if (Array.isArray(value)) {
      for (const item of value) strings(item);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        strings(k); // Some records key their snapshots by SHA.
        strings(v, k);
      }
    }
  }
  function entries(dir: string): fs.Dirent[] {
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Not a regular directory: ${dir}`);
      return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  function scan(dir: string, accepts: (name: string) => boolean, sessionRecord = false) {
    for (const entry of entries(dir)) {
      if (!accepts(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (!entry.isFile()) throw new Error(`Cannot inspect capture evidence: ${file}`);
      // An atomic writer's temporary file means this inventory is in flux.
      if (!/\.jsonl?$/.test(entry.name)) throw new Error(`Capture write in progress: ${file}`);
      const size = fs.statSync(file).size;
      bytes += size;
      if (size > 32 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error('Capture evidence exceeds the cleanup scan limit');
      const raw = fs.readFileSync(file, 'utf8');
      fingerprint.update(file).update('\0').update(raw).update('\0');
      const records = entry.name.endsWith('.jsonl') ? raw.split('\n').filter(line => line.trim()) : [raw];
      for (const record of records) {
        const parsed: unknown = JSON.parse(record);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid capture evidence: ${file}`);
        if (sessionRecord && (typeof (parsed as { sessionId?: unknown }).sessionId !== 'string' || !(parsed as { sessionId: string }).sessionId)) {
          throw new Error(`Missing session identity in capture evidence: ${file}`);
        }
        strings(parsed);
      }
    }
  }
  const stateFile = (name: string) => /^origin-session.*\.json(?:\.|$)/.test(name);
  scan(commonDir, stateFile, true);
  for (const entry of entries(path.join(commonDir, 'worktrees'))) {
    if (!entry.isDirectory()) throw new Error('Cannot inspect worktree state');
    scan(path.join(commonDir, 'worktrees', entry.name), stateFile, true);
  }
  for (const dir of ['sessions', 'queue', 'journals']) {
    scan(path.join(originHome, dir), name => /\.jsonl?(?:\.|$)/.test(name), dir !== 'journals');
  }
  return { hashes, owners, fingerprint: fingerprint.digest('hex') };
}

/** Explicit maintenance only: no hook latency, session expiry, or object GC.
 * Apply rechecks the complete inventory, then deletes refs in one Git
 * transaction with expected old SHAs. A concurrent ref update aborts it all.
 */
export function cleanShadowRefs(repoPath: string, opts: { apply?: boolean; now?: number; originHome?: string } = {}) {
  const gitOpts = { cwd: repoPath, timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 };
  const commonDir = path.resolve(repoPath, git(['rev-parse', '--git-common-dir'], gitOpts).trim());
  const originHome = opts.originHome ?? path.join(os.homedir(), '.origin');
  const inventory = protectionInventory(commonDir, originHome);
  const rows = git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)%09%(authoremail)%09%(committerdate:unix)%09%(symref)%09%(subject)', PREFIX], gitOpts).trim();
  const candidates: ShadowRef[] = [];
  const lines = rows ? rows.split('\n') : [];
  const cutoff = (opts.now ?? Date.now()) - RETENTION_MS;
  for (const line of lines) {
    const [name, sha, type, author, committed, symref, subject] = line.split('\t');
    if (!name.startsWith(PREFIX) || type !== 'commit' || symref || author !== `<${SHADOW_IDENTITY_EMAIL}>`) continue;
    const tag = name.slice(PREFIX.length);
    const messagePrefix = `origin shadow ${tag} `;
    if (!subject?.startsWith(messagePrefix)) continue;
    const created = Date.parse(subject.slice(messagePrefix.length));
    const committedMs = Number(committed) * 1000;
    if (!Number.isFinite(created) || !Number.isFinite(committedMs) || created >= cutoff || committedMs >= cutoff) continue;
    // Also protect abbreviated SHAs without an O(refs × recorded hashes) scan.
    if (Array.from({ length: sha.length - 6 }, (_, i) => sha.slice(0, i + 7)).some(hash => inventory.hashes.has(hash))) continue;
    if ([...inventory.owners].some(owner => tag.includes(owner))) continue;
    candidates.push({ name, sha });
  }
  let removed = 0;
  if (opts.apply && candidates.length) {
    if (protectionInventory(commonDir, originHome).fingerprint !== inventory.fingerprint) {
      throw new Error('Capture evidence changed during cleanup; retry when capture is idle');
    }
    const input = ['start', ...candidates.map(ref => `delete ${ref.name} ${ref.sha}`), 'prepare', 'commit', ''].join('\n');
    const result = gitDetailed(['update-ref', '--no-deref', '--stdin'], { ...gitOpts, input });
    if (result.status !== 0) throw new Error(`Ref transaction aborted: ${result.stderr.trim()}`);
    removed = candidates.length;
  }
  return { total: lines.length, candidates, removed };
}
