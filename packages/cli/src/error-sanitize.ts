// ─── CLI error-message sanitizer ───────────────────────────────────────────
//
// User-facing error strings from command handlers can contain:
//   • secrets (API keys, tokens) pulled from env vars and config
//   • absolute paths that leak the user's real home directory
//   • machine hostnames
//
// This module installs a global `console.error` wrapper that runs every
// outgoing message through `redactSecrets` plus a home-dir replacer, so
// an accidental `console.error(err.message)` can't dump a token to stdout
// or to shell history.
//
// The wrapper is installed once at CLI entry (index.ts). It preserves the
// original console.error so test harnesses can still see raw output if they
// choose to.

import os from 'os';
import path from 'path';
import { redactSecrets } from './redaction.js';

let installed = false;

function sanitizeOne(v: unknown): unknown {
  if (typeof v === 'string') return sanitizeString(v);
  if (v instanceof Error) {
    // Rewrite the message in place — printing `Error.message` via template
    // literal is by far the most common code path, so we fix that first.
    // Stack traces are left alone; they're dev-oriented and typically off.
    try {
      const cleaned = sanitizeString(v.message || '');
      if (cleaned !== v.message) {
        const clone = new Error(cleaned);
        clone.name = v.name;
        clone.stack = v.stack;
        return clone;
      }
    } catch { /* fall through */ }
    return v;
  }
  return v;
}

function sanitizeString(s: string): string {
  let out: string;
  try {
    out = redactSecrets(s).redacted;
  } catch {
    out = s;
  }
  // Collapse the current user's home directory to ~ so error messages don't
  // leak "/Users/artem/..." into logs or screenshots.
  try {
    const home = os.homedir();
    if (home && home.length > 2) {
      // Escape regex metacharacters in the home path.
      const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '~');
    }
  } catch { /* noop */ }
  return out;
}

/**
 * Sanitize an unknown error value to a short user-safe string.
 * Use for `console.error(chalk.red(cliErrorMessage(err)))` call sites.
 */
export function cliErrorMessage(err: unknown): string {
  if (err instanceof Error) return sanitizeString(err.message || String(err));
  if (typeof err === 'string') return sanitizeString(err);
  try { return sanitizeString(JSON.stringify(err)); } catch { return '[unprintable error]'; }
}

/**
 * Install a global console.error wrapper that sanitizes every argument.
 * Idempotent — safe to call multiple times.
 */
export function installGlobalConsoleSanitizer(): void {
  if (installed) return;
  installed = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args.map(sanitizeOne));
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args.map(sanitizeOne));
  };
}

// Exported for unit tests.
export const __testing = { sanitizeString, sanitizeOne, _resetInstalled: () => { installed = false; } };

// Keep a handle to `path` so TS doesn't complain about the unused import in
// case future edits add path-based redaction paths.
void path;
