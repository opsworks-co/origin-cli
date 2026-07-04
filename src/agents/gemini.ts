// ── Gemini agent adapter: transcript discovery & model detection ────────────
// Extracted verbatim from commands/hooks.ts (R3 phase C). Knows where Gemini
// keeps its chat files (~/.gemini/tmp/<hash>/chats), how to pick the right
// one, and how to read the model + per-prompt timeline out of it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { debugLog } from '../debug-log.js';
import type { PromptTimelineEntry } from './codex.js';

/**
 * Gemini CLI has used several storage layouts across versions:
 *   - ~/.gemini/tmp/<workspace>/chats/session-*.json    (older)
 *   - ~/.gemini/tmp/<projectHash>/chats/session-*.json  (hash-based)
 *   - ~/.gemini/tmp/<projectHash>/checkpoints/*.json    (newer checkpoints)
 *   - ~/.gemini/projects/<projectHash>/checkpoints/*.json
 *
 * Walk every plausible location and pick the newest matching JSON. The hook
 * may also receive `transcript_path` via stdin — that wins over discovery.
 */
/**
 * Read the actual model identifier from a Gemini transcript file.
 *
 * Gemini CLI's hook stdin doesn't include `model`, so without this
 * the dashboard falls back to the bare brand string "gemini" and every
 * commit row reads "Gemini" instead of e.g. "Gemini 2.5 Pro".
 *
 * Gemini writes its session metadata in the FIRST JSONL line of the
 * chat file (header with model/projectId/created) and includes a
 * `model` field on each model-response event. We scan the file for
 * either signal — the LATEST event with a model field wins (mid-
 * session model switches via /chat command are then reflected).
 *
 * Returns null when no model is found OR when the file isn't a Gemini
 * chat (e.g. stale path). Caller falls back to the bare "gemini".
 */
export function readGeminiModel(transcriptPath: string): string | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  let latestModel: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    // Header line at top of file usually has shape
    // { sessionId, model, projectId, created, ... }. The exact key
    // varies (`model`, `modelName`, `metadata.model`); accept any.
    const candidate =
      (typeof evt?.model === 'string' && evt.model) ||
      (typeof evt?.modelName === 'string' && evt.modelName) ||
      (typeof evt?.metadata?.model === 'string' && evt.metadata.model) ||
      (typeof evt?.payload?.model === 'string' && evt.payload.model) ||
      (typeof evt?.config?.model === 'string' && evt.config.model) ||
      null;
    if (candidate && candidate !== 'gemini' && candidate !== 'unknown') {
      latestModel = candidate;
    }
  }
  return latestModel;
}

export function discoverGeminiTranscriptPath(opts: { maxAgeMs?: number; sessionId?: string } = {}): string | null {
  // Default: 60-minute window. Mid-session, Gemini may not touch its chat
  // file for many minutes between user prompts (it's only re-written on
  // /chat save or end-of-turn), so a 10-minute gate dropped active sessions.
  //
  // STRICT mode: when a sessionId is supplied, we only return a file whose
  // basename embeds that id. The legacy "newest file across all
  // .gemini/ dirs" fallback was the smoking gun for cross-conversation
  // contamination — Gemini happily kept stale chat files around and we'd
  // pick whichever was last touched, attributing some other chat's
  // prompts to the current session.
  //
  // sessionId-less calls are still supported for the no-stdin-id case
  // (e.g. plain `gemini` CLI invocations); those keep the legacy newest-
  // file behaviour but log every time it fires so we can tell when ID
  // anchoring isn't doing the work.
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
  try {
    const home = os.homedir();
    const candidateRoots: string[] = [
      path.join(home, '.gemini', 'tmp'),
      path.join(home, '.gemini', 'projects'),
    ];

    let newestFile = '';
    let newestMtime = 0;
    let idMatchedFile = '';
    let idMatchedMtime = 0;

    const consider = (fp: string, name: string) => {
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) return;
        if (opts.sessionId && name.includes(opts.sessionId)) {
          if (stat.mtimeMs > idMatchedMtime) {
            idMatchedMtime = stat.mtimeMs;
            idMatchedFile = fp;
          }
        }
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fp;
        }
      } catch { /* ignore */ }
    };

    const isSessionLike = (name: string) =>
      name.endsWith('.json') &&
      (name.startsWith('session-') || name.startsWith('checkpoint') || name.startsWith('chat'));

    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;
      let entries: string[] = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const ws of entries) {
        const wsDir = path.join(root, ws);
        let isDir = false;
        try { isDir = fs.statSync(wsDir).isDirectory(); } catch { /* ignore */ }
        if (!isDir) continue;
        for (const sub of ['chats', 'checkpoints']) {
          const dir = path.join(wsDir, sub);
          if (!fs.existsSync(dir)) continue;
          let files: string[] = [];
          try { files = fs.readdirSync(dir); } catch { continue; }
          for (const f of files) {
            if (isSessionLike(f)) consider(path.join(dir, f), f);
          }
        }
      }
    }

    if (opts.sessionId) {
      if (idMatchedFile && (Date.now() - idMatchedMtime) < maxAgeMs) {
        return idMatchedFile;
      }
      debugLog('gemini', 'discoverGeminiTranscriptPath: no recent file for sessionId', {
        sessionId: opts.sessionId,
      });
      return null;
    }

    if (newestFile && (Date.now() - newestMtime) < maxAgeMs) {
      debugLog('gemini', 'discoverGeminiTranscriptPath: no sessionId, returning newest file', {
        file: newestFile,
      });
      return newestFile;
    }
    return null;
  } catch {
    return null;
  }
}


export function getGeminiPromptsTimeline(transcriptPath: string): PromptTimelineEntry[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    // Gemini transcripts are JSON arrays of {role, parts:[{text}], timestamp}
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PromptTimelineEntry[] = [];
    for (const m of parsed) {
      const role = m?.role;
      if (role !== 'user' && role !== 'human') continue;
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m?.parts)
          ? m.parts.map((p: any) => p?.text || '').join('')
          : '';
      if (!text || !text.trim()) continue;
      const tsRaw = m?.timestamp || m?.ts || m?.created_at;
      const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
      out.push({ text, timestamp: Number.isFinite(ts) ? ts : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

