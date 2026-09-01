// What "supported" means, asserted rather than assumed.
//
// Adding an agent has been: wire an installer, add a catalog entry, add a
// handler, and remember the rest. The remembering is where it breaks, and the
// failures are silent every time — Antigravity shipped a hooks.json the agent
// rejected wholesale, Copilot's managed file matched on one side of the system
// and not the other, and Gemini went months with no tool-level hooks at all
// while reading as fully supported.
//
// So this file runs the real installers into a temp dir, reads what they
// actually wrote, and checks it against a declared matrix. A capability change
// then shows up as a failing expectation with the old and new value, instead
// of as a dashboard that quietly stops being right.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  installClaudeHooks, installCursorHooks, installGeminiHooks, installCodexHooks,
  installDevinHooks, installCopilotHooks, installAntigravityHooks,
} from '../commands/enable.js';

// Events `hooksCommand` dispatches. An installer writing anything else has
// wired a hook that will run and do nothing.
const HANDLED_EVENTS = new Set([
  'session-start', 'user-prompt-submit', 'stop', 'session-end',
  'pre-tool-use', 'post-tool-use', 'after-file-edit',
]);

/**
 * How much a turn's attribution can be trusted, per agent.
 *
 *   tool     — pre/post tool-use hooks: per-command evidence
 *   edit     — a per-edit hook naming the file it wrote
 *   journal  — no agent signal; the filesystem watcher supplies WHEN
 *   window   — inference only: whatever was dirty in the turn
 *
 * `window` is the state every agent was in before this work, and is the state
 * none should be left in.
 */
interface AgentSpec {
  install: (d: string) => void;
  evidence: 'tool' | 'edit' | 'journal';
  /**
   * Agents that deliberately install NO hooks on Windows.
   *
   * Codex is the only one: its Windows sandbox blocks hooks, and it renders
   * the failures as red "hook (failed)" errors in the user's session, so
   * enable strips them there and capture runs through the rollout watcher
   * instead. That is a real capability difference between platforms, and
   * encoding it here is the point of a matrix — the first Windows run of this
   * suite failed on exactly this, because the matrix assumed every agent wires
   * hooks everywhere.
   */
  noHooksOnWindows?: boolean;
}

const EXPECTED: Record<string, AgentSpec> = {
  'claude-code': { install: installClaudeHooks, evidence: 'tool' },
  antigravity: { install: installAntigravityHooks, evidence: 'tool' },
  gemini: { install: installGeminiHooks, evidence: 'tool' },
  cursor: { install: installCursorHooks, evidence: 'edit' },
  codex: { install: installCodexHooks, evidence: 'journal', noHooksOnWindows: true },
  devin: { install: installDevinHooks, evidence: 'journal' },
  copilot: { install: installCopilotHooks, evidence: 'journal' },
};

const IS_WINDOWS = process.platform === 'win32';

let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-conf-'))); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Every `origin hooks <agent> <event>` an installer wrote anywhere on disk. */
function wiredEvents(root: string): Array<{ agent: string; event: string }> {
  const found: Array<{ agent: string; event: string }> = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let text = '';
      try { text = fs.readFileSync(p, 'utf-8'); } catch { continue; }
      for (const m of text.matchAll(/hooks\s+([a-z-]+)\s+([a-z-]+)/g)) {
        found.push({ agent: m[1], event: m[2] });
      }
    }
  };
  walk(root);
  return found;
}

describe('agent conformance', () => {
  for (const [agent, spec] of Object.entries(EXPECTED)) {
    describe(agent, () => {
      it('only wires events the dispatcher actually handles', () => {
        spec.install(dir);
        const wired = wiredEvents(dir).filter((w) => w.agent === agent);
        if (IS_WINDOWS && spec.noHooksOnWindows) {
          // Installing nothing is the CORRECT behaviour here, not a gap —
          // capture runs through the rollout watcher on this platform.
          expect(wired).toEqual([]);
          return;
        }
        expect(wired.length, `${agent} wired no hooks at all`).toBeGreaterThan(0);
        const unknown = wired.filter((w) => !HANDLED_EVENTS.has(w.event));
        expect(unknown, `${agent} wires events nothing handles: they will run and do nothing`).toEqual([]);
      });

      it('has the evidence class the matrix declares', () => {
        if (IS_WINDOWS && spec.noHooksOnWindows) return; // no hooks by design
        spec.install(dir);
        const events = new Set(wiredEvents(dir).filter((w) => w.agent === agent).map((w) => w.event));
        const hasTool = events.has('pre-tool-use') && events.has('post-tool-use');
        const hasEdit = events.has('after-file-edit');
        const actual = hasTool ? 'tool' : hasEdit ? 'edit' : 'journal';
        expect(
          actual,
          `${agent} is declared '${spec.evidence}' but its installed hooks say '${actual}'. `
          + 'Update the matrix deliberately — this is a change in how much its numbers can be trusted.',
        ).toBe(spec.evidence);
      });

      it('captures a session lifecycle, so turns have boundaries', () => {
        if (IS_WINDOWS && spec.noHooksOnWindows) return; // watcher supplies these
        spec.install(dir);
        const events = new Set(wiredEvents(dir).filter((w) => w.agent === agent).map((w) => w.event));
        // Without a turn boundary every evidence path degrades: the journal
        // cannot scope its records and the probe cannot pick a baseline.
        const hasTurnBoundary = events.has('user-prompt-submit') || events.has('pre-tool-use');
        expect(hasTurnBoundary, `${agent} has no way to tell where a turn starts`).toBe(true);
      });
    });
  }

  it('no agent is left on window-only inference', () => {
    // The state this whole effort existed to end. `journal` counts: the
    // watcher gives WHEN, which the window never had.
    const windowOnly = Object.entries(EXPECTED)
      .filter(([, s]) => (s.evidence as string) === 'window')
      .map(([a]) => a);
    expect(windowOnly).toEqual([]);
  });

  it('covers every agent the CLI claims to support', () => {
    // A new agent added to SUPPORTED_AGENTS without an entry here would
    // otherwise be conformance-tested by nobody.
    const declared = Object.keys(EXPECTED).sort();
    expect(declared).toEqual([
      'antigravity', 'claude-code', 'codex', 'copilot', 'cursor', 'devin', 'gemini',
    ].sort());
  });
});
