// Repo brief — a cached, LLM-generated "what this repo IS" summary (purpose,
// architecture, key entry points, conventions, gotchas), injected at session
// start ALONGSIDE the per-session memory (which is "what sessions DID"). Unlike
// session memory, this is a retrospective pass over the repo itself.
//
// P0 (this file): opt-in, MANUAL generation (`origin context brief --refresh`),
// cached in a shared git note, injected from cache only (never generated in the
// session-start hot path). P1 will add background auto-generation on first
// session + staleness auto-refresh — the signature/staleness helpers here exist
// so P1 is a small addition, not a rewrite.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { git, gitOrNull } from './utils/exec.js';
import { loadConfig } from './config.js';
import { isRepoIgnored } from './ignore-repos.js';
import { isBakeoffRepo } from './memory.js';
import { callLLM, getAnthropicKey } from './llm.js';
import { resolveAgentKeys } from './agent-keys.js';

const BRIEF_REF = 'origin-repo-brief';
const BRIEF_MODEL = 'claude-sonnet-4-6';
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days TTL (auto-refresh belt)
// Don't re-spawn a background generation more than once per this window per repo
// — so a slow or failing generation doesn't fire on every single session start.
const GEN_ATTEMPT_DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_FILE_BYTES = 8_000;   // cap any single file we feed the model
const MAX_BUNDLE_BYTES = 40_000; // cap the whole context bundle

export interface RepoBrief {
  version: 1;
  brief: string;
  signature: string;   // repo content signature at generation time
  generatedAt: string; // ISO
  model: string;
}

// ── Enablement ───────────────────────────────────────────────────────────────

/** Opt-in: the feature does nothing until the user enables it. */
export function isRepoBriefEnabled(): boolean {
  return loadConfig()?.repoBrief === true;
}

// ── Context bundle ───────────────────────────────────────────────────────────

const MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'tsconfig.json',
  'pyproject.toml', 'requirements.txt', 'setup.py',
  'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle',
  'Dockerfile', 'docker-compose.yml', 'Makefile',
];
const README_CANDIDATES = ['README.md', 'README', 'readme.md', 'Readme.md', 'README.rst'];

function readCapped(repoPath: string, rel: string): string | null {
  try {
    const p = path.join(repoPath, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    const buf = fs.readFileSync(p, 'utf-8');
    return buf.length > MAX_FILE_BYTES ? buf.slice(0, MAX_FILE_BYTES) + '\n…[truncated]' : buf;
  } catch { return null; }
}

/**
 * Assemble a BOUNDED, curated snapshot of the repo for the model — README,
 * manifests, the tracked-file tree, and recent commit subjects. Deliberately
 * NOT the whole repo: keeps the call cheap and fast. Exported for testing.
 */
export function buildRepoContextBundle(repoPath: string): string {
  const opts = { cwd: repoPath, timeoutMs: 10_000 };
  const parts: string[] = [];

  const readme = README_CANDIDATES.map((r) => readCapped(repoPath, r)).find(Boolean);
  if (readme) parts.push(`# README\n${readme}`);

  for (const m of MANIFESTS) {
    const content = readCapped(repoPath, m);
    if (content) parts.push(`# ${m}\n${content}`);
  }

  // Tracked-file tree (top ~200 paths) — structure without content.
  const tree = gitOrNull(['ls-files'], opts);
  if (tree) {
    const files = tree.split('\n').filter(Boolean).slice(0, 200);
    parts.push(`# Tracked files (${files.length}${tree.split('\n').length > 200 ? '+' : ''})\n${files.join('\n')}`);
  }

  // Recent commit subjects — what's been happening.
  const log = gitOrNull(['log', '-30', '--pretty=%s'], opts);
  if (log) parts.push(`# Recent commits\n${log}`);

  let bundle = parts.join('\n\n');
  if (bundle.length > MAX_BUNDLE_BYTES) bundle = bundle.slice(0, MAX_BUNDLE_BYTES) + '\n…[bundle truncated]';
  return bundle;
}

/**
 * A cheap content signature: HEAD sha + a hash of the manifests/tree that define
 * the repo's shape. When this drifts, the brief is stale (used by --refresh and,
 * later, P1 auto-refresh). Exported for testing.
 */
export function computeRepoSignature(repoPath: string): string {
  const opts = { cwd: repoPath, timeoutMs: 10_000 };
  const head = gitOrNull(['rev-parse', 'HEAD'], opts) || '';
  const manifestBlob = MANIFESTS.map((m) => `${m}:${readCapped(repoPath, m) || ''}`).join('\n');
  const tree = gitOrNull(['ls-files'], opts) || '';
  return crypto.createHash('sha256').update(head + '\n' + manifestBlob + '\n' + tree).digest('hex').slice(0, 16);
}

// ── Generate ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You write a tight orientation brief for an AI coding agent about to work in a repository it has never seen. ' +
  'From the provided README, manifests, file tree, and recent commits, produce 120–220 words covering: what the ' +
  'project is and does; the stack and high-level architecture; the key directories and entry points; notable ' +
  'conventions; and any gotchas a new contributor should know. Be concrete and specific to THIS repo — no generic ' +
  'filler, no restating the file list. Plain prose with short labeled lines is fine. Output only the brief.';

/**
 * Resolve an Anthropic key with full precedence: a shell export / local
 * config.anthropicApiKey (via getAnthropicKey), then the LOCAL agent-keys file,
 * then the ORG's key stored in Origin (resolveAgentKeys, best-effort). So a user
 * with no personal key still generates briefs using the org's configured key —
 * the same key the bake-off runner uses. Async because the org fetch hits the API.
 */
export async function resolveAnthropicKey(): Promise<string | null> {
  const local = getAnthropicKey();
  if (local) return local;
  try {
    const keys = await resolveAgentKeys();
    return keys.anthropic || null;
  } catch {
    return null;
  }
}

/**
 * Generate the brief via one LLM call, using an env/local/org-resolved key.
 * Returns null when no key resolves or the call fails. Does NOT cache — the
 * caller decides whether to persist.
 */
export async function generateRepoBrief(repoPath: string): Promise<RepoBrief | null> {
  const key = await resolveAnthropicKey();
  if (!key) return null;
  const bundle = buildRepoContextBundle(repoPath);
  if (!bundle.trim()) return null;
  // callLLM reads the key from getAnthropicKey() (env / config). Point it at the
  // resolved key (which may be the org's) for this call, then restore — so we
  // don't need to thread a key param through the shared client.
  const prevEnv = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = key;
  let text: string;
  try {
    text = await callLLM(
      SYSTEM_PROMPT,
      [{ role: 'user', content: `Repository context:\n\n${bundle}` }],
      { maxTokens: 700, model: BRIEF_MODEL },
    );
  } catch {
    return null;
  } finally {
    if (prevEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevEnv;
  }
  const brief = (text || '').trim();
  if (!brief) return null;
  return {
    version: 1,
    brief,
    signature: computeRepoSignature(repoPath),
    generatedAt: new Date().toISOString(),
    model: BRIEF_MODEL,
  };
}

// ── Cache (shared git note on the root commit — travels with the repo) ────────

function rootCommit(repoPath: string): string | null {
  const raw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
  const c = raw ? raw.split('\n')[0] : null;
  return c && /^[a-fA-F0-9]+$/.test(c) ? c : null;
}

export function writeRepoBrief(repoPath: string, brief: RepoBrief): void {
  try {
    const root = rootCommit(repoPath);
    if (!root) return;
    git(['notes', `--ref=${BRIEF_REF}`, 'add', '-f', '-m', JSON.stringify(brief, null, 2), root],
      { cwd: repoPath, timeoutMs: 10_000 });
  } catch { /* non-fatal */ }
}

export function readRepoBrief(repoPath: string): RepoBrief | null {
  try {
    const root = rootCommit(repoPath);
    if (!root) return null;
    const raw = git(['notes', `--ref=${BRIEF_REF}`, 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    const data = JSON.parse(raw);
    return data?.version === 1 && typeof data.brief === 'string' ? data : null;
  } catch { return null; }
}

export function clearRepoBrief(repoPath: string): boolean {
  try {
    const root = rootCommit(repoPath);
    if (!root) return false;
    git(['notes', `--ref=${BRIEF_REF}`, 'remove', root], { cwd: repoPath, timeoutMs: 10_000 });
    return true;
  } catch { return false; }
}

/** True when the cached brief is missing, older than the TTL, or its signature
 *  no longer matches the repo. Drives --refresh and (P1) background refresh. */
export function isRepoBriefStale(repoPath: string, cached = readRepoBrief(repoPath)): boolean {
  if (!cached) return true;
  if (Date.now() - new Date(cached.generatedAt).getTime() > STALE_AFTER_MS) return true;
  return cached.signature !== computeRepoSignature(repoPath);
}

// ── Injection (cache-only; safe for the session-start hot path) ───────────────

/**
 * The brief text to inject at session start, or null. Cache-only and fast — it
 * NEVER generates here. Respects the opt-in flag and skips bake-off/ignored
 * repos (same guards as session memory).
 */
export function buildRepoBriefContext(repoPath: string): string | null {
  if (!isRepoBriefEnabled()) return null;
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return null;
  const cached = readRepoBrief(repoPath);
  if (!cached) return null;
  return `About this repository:\n${cached.brief}`;
}

// ── P1: background auto-generate on first session + staleness refresh ─────────

function attemptMarkerPath(repoPath: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.origin', 'brief-attempts', `${hash}.json`);
}

/** Last time we spawned a generation for this repo, or 0. */
export function lastGenerationAttempt(repoPath: string): number {
  try {
    const raw = fs.readFileSync(attemptMarkerPath(repoPath), 'utf-8');
    const t = JSON.parse(raw)?.at;
    return typeof t === 'number' ? t : 0;
  } catch { return 0; }
}

function markGenerationAttempt(repoPath: string, nowMs: number): void {
  try {
    const p = attemptMarkerPath(repoPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ at: nowMs }), { mode: 0o600 });
  } catch { /* best effort */ }
}

/**
 * Pure decision: should session-start spawn a background generation right now?
 * Yes when the feature is enabled, the repo is trackable, the cached brief is
 * missing/stale, and we haven't already attempted within the debounce window
 * (so a slow/failing generation doesn't re-fire every session). Exported for
 * testing.
 */
export function shouldAttemptBriefGeneration(i: {
  enabled: boolean;
  skipRepo: boolean;      // bake-off or ignored
  stale: boolean;         // missing or out of date
  lastAttemptMs: number;
  nowMs: number;
}): boolean {
  if (!i.enabled || i.skipRepo || !i.stale) return false;
  return i.nowMs - i.lastAttemptMs >= GEN_ATTEMPT_DEBOUNCE_MS;
}

/**
 * From session-start (P1): if the brief is enabled and missing/stale, spawn a
 * DETACHED background process that generates + caches it for the NEXT session.
 * Non-blocking, debounced, and fully guarded — session start never waits on it,
 * and generation resolves the key from env/local/org so it works with the org's
 * configured Anthropic key. Best-effort: any failure is swallowed.
 */
export function maybeSpawnBriefGeneration(repoPath: string, nowMs: number = Date.now()): void {
  try {
    const decide = shouldAttemptBriefGeneration({
      enabled: isRepoBriefEnabled(),
      skipRepo: isBakeoffRepo(repoPath) || isRepoIgnored(repoPath),
      stale: isRepoBriefStale(repoPath),
      lastAttemptMs: lastGenerationAttempt(repoPath),
      nowMs,
    });
    if (!decide) return;
    const bin = process.argv[1];
    if (!bin) return;
    markGenerationAttempt(repoPath, nowMs); // mark BEFORE spawn so we don't double-fire
    const child = spawn(process.execPath, [bin, 'context', 'brief', '--generate'], {
      cwd: repoPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ORIGIN_BRIEF_BG: '1' },
    });
    child.unref();
  } catch { /* best-effort — the brief is a nicety, never break session start */ }
}

/**
 * The background worker body: resolve the key, generate, cache. Silent (no
 * console output — it runs detached). Invoked by `origin context brief
 * --generate`, which session-start spawns.
 */
export async function runBackgroundGeneration(repoPath: string): Promise<void> {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    const brief = await generateRepoBrief(repoPath);
    if (brief) writeRepoBrief(repoPath, brief);
  } catch { /* silent */ }
}
