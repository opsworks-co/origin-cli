// Google retired the Gemini CLI for personal accounts ("This client is no
// longer supported for Gemini Code Assist for individuals … migrate to
// Antigravity", 2026-10-13). Installed is not usable: the machine reports
// `gemini-api-key` only where Gemini can still run, and the web's Start menu
// reads it.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { geminiCanRun } from '../tools-detector.js';

function home(files: Record<string, string> = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gemini-home-'));
  fs.mkdirSync(path.join(h, '.gemini'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(h, '.gemini', f), c);
  return h;
}

describe('geminiCanRun', () => {
  it('a personal Google login cannot run it any more', () => {
    expect(geminiCanRun({}, home({ 'settings.json': JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }) }))).toBe(false);
    expect(geminiCanRun({}, home())).toBe(false);
  });

  it('an API key, Vertex or cloud credentials can', () => {
    expect(geminiCanRun({ GEMINI_API_KEY: 'k' }, home())).toBe(true);
    expect(geminiCanRun({ GOOGLE_API_KEY: 'k' }, home())).toBe(true);
    expect(geminiCanRun({ GOOGLE_GENAI_USE_VERTEXAI: 'true' }, home())).toBe(true);
    expect(geminiCanRun({ GOOGLE_GENAI_USE_VERTEXAI: 'false' }, home())).toBe(false);
    expect(geminiCanRun({}, home({ '.env': 'GEMINI_API_KEY=abc\n' }))).toBe(true);
    expect(geminiCanRun({}, home({ '.env': 'GEMINI_API_KEY=\n' }))).toBe(false);
    for (const t of ['gemini-api-key', 'vertex-ai', 'compute-default-credentials']) {
      expect(geminiCanRun({}, home({ 'settings.json': JSON.stringify({ security: { auth: { selectedType: t } } }) }))).toBe(true);
    }
    expect(geminiCanRun({}, home({ 'settings.json': JSON.stringify({ selectedAuthType: 'gemini-api-key' }) }))).toBe(true);
  });
});
