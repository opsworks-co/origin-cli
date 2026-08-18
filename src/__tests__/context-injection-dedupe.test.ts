/**
 * The repo-context block must reach a conversation ONCE.
 *
 * Measured on a single Claude Code turn (2026-08-18): the same ~450-word memory
 * digest arrived three times — in the SessionStart hook payload, in the
 * UserPromptSubmit payload, and again as the CLAUDE.md the harness loads into
 * every request. Roughly 3× the token cost for 1× the information, on every
 * turn, which made Origin's memory the most expensive thing in the context
 * window rather than the most useful.
 *
 * Two independent duplications, so two fixes:
 *
 *  1. The agent's OWN rules file no longer carries the volatile block when that
 *     agent already receives it over the hook channel. Sibling files still get
 *     the full text — for a file-driven agent (Codex reads AGENTS.md and gets no
 *     hook payload at all) the file is the ONLY channel, so trimming it would
 *     be a real loss.
 *  2. UserPromptSubmit skips the full block when SessionStart already delivered
 *     it to THIS conversation. Keyed on the conversation anchor, not elapsed
 *     time: a time window would have to choose between re-injecting into the
 *     same conversation and going silent on a second chat opened moments later
 *     — which is the exact blindness the auto-create path exists to fix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  agentReadsContextFromHook,
  durableRulesFileMessage,
  writeAgentRulesFile,
  recordFullContextInjection,
  fullContextAlreadyInjected,
  sessionDurationMs,
  ORIGIN_MANAGED_MARKER,
} from '../commands/hooks.js';
import { buildNotePayload } from '../git-notes.js';

let tmp: string;
let repo: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-inject-dedupe-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('agentReadsContextFromHook — who already got the block another way', () => {
  it('covers the agents that receive it over the hook channel every session', () => {
    expect(agentReadsContextFromHook('claude-code')).toBe(true);
    expect(agentReadsContextFromHook('cursor')).toBe(true);
    expect(agentReadsContextFromHook('gemini')).toBe(true);
  });

  it('excludes file-driven agents — their rules file is the only channel', () => {
    // Codex gets a null hook payload; Devin Desktop has no third-party hooks at
    // all. A false positive here would silently starve them of context, which is
    // far worse than paying for a duplicate.
    expect(agentReadsContextFromHook('codex')).toBe(false);
    expect(agentReadsContextFromHook('devin')).toBe(false);
    expect(agentReadsContextFromHook('copilot')).toBe(false);
    expect(agentReadsContextFromHook('antigravity')).toBe(false);
    expect(agentReadsContextFromHook(undefined)).toBe(false);
    expect(agentReadsContextFromHook('')).toBe(false);
  });
});

describe('durableRulesFileMessage — the subtraction that IS the dedupe', () => {
  const TRACKING = 'Origin: Session tracking active — prompts, files, and tokens will be captured.';
  const REPO_CONTEXT = [
    'Repository AI context: 53% of recent commits (16/30) are AI-generated.',
    '',
    'Prior work in this repo (recent sessions):',
    'Recent focus: UI polish on the Policies page.',
  ].join('\n');
  const FRAMEWORK = 'Origin authoring framework — emit [Origin: …] markers inline.';
  const systemMsg = `${TRACKING}\n\n${REPO_CONTEXT}\n\n${FRAMEWORK}`;

  it('removes the injected block and keeps everything durable around it', () => {
    const out = durableRulesFileMessage(systemMsg, REPO_CONTEXT, 'claude-code')!;
    expect(out).toContain(TRACKING);
    expect(out).toContain(FRAMEWORK);
    expect(out).not.toContain('Prior work in this repo');
    expect(out).not.toContain('53% of recent commits');
  });

  it('leaves no blank-line crater where the block was', () => {
    const out = durableRulesFileMessage(systemMsg, REPO_CONTEXT, 'claude-code')!;
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toBe(`${TRACKING}\n\n${FRAMEWORK}`);
  });

  it('returns undefined for a file-driven agent — that file is its only channel', () => {
    expect(durableRulesFileMessage(systemMsg, REPO_CONTEXT, 'codex')).toBeUndefined();
  });

  it('returns undefined when no block was injected this session', () => {
    expect(durableRulesFileMessage(systemMsg, null, 'claude-code')).toBeUndefined();
  });

  it('returns undefined rather than a near-miss when the block is not present verbatim', () => {
    // Guards the failure mode that would silently ship a rules file subtly
    // different from what the hook delivered.
    expect(durableRulesFileMessage(systemMsg, 'a block that was never added', 'claude-code')).toBeUndefined();
  });
});

describe('writeAgentRulesFile — own file may differ from the siblings', () => {
  const DURABLE = 'Origin: Session tracking active — durable half only.';
  const FULL = `${DURABLE}\n\nPrior work in this repo: the volatile memory digest.`;

  /** A file carrying a well-formed (paired) origin-managed block plus user content. */
  function seedManaged(rel: string) {
    const target = path.join(repo, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `# Notes\n\n${ORIGIN_MANAGED_MARKER}\nstale\n${ORIGIN_MANAGED_MARKER}\n`,
    );
    return target;
  }

  it('writes the durable half to the running agent\'s own file', () => {
    seedManaged('CLAUDE.md');
    writeAgentRulesFile('claude-code', FULL, repo, DURABLE);
    const claudeMd = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('durable half only');
    expect(claudeMd).not.toContain('volatile memory digest');
  });

  it('still writes the FULL text to sibling files — Codex reads AGENTS.md and gets no hook payload', () => {
    seedManaged('AGENTS.md');
    writeAgentRulesFile('claude-code', FULL, repo, DURABLE);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toContain('volatile memory digest');
  });

  it('writes the full text everywhere when no override is passed (unchanged default)', () => {
    seedManaged('CLAUDE.md');
    writeAgentRulesFile('claude-code', FULL, repo);
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toContain('volatile memory digest');
  });

  it('leaves user content outside the managed block intact', () => {
    seedManaged('CLAUDE.md');
    writeAgentRulesFile('claude-code', FULL, repo, DURABLE);
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toContain('# Notes');
  });
});

describe('sessionDurationMs — never fabricate a measurement', () => {
  // Review regression: Math.max(0, NaN) is NaN, NaN passes a
  // `typeof === 'number'` guard, and JSON.stringify writes it as null — which a
  // reader coerces straight back to the fabricated 0 this change removed.
  it('omits the field entirely when the session start is unusable', () => {
    const note = (durationMs: number | undefined) => JSON.parse(buildNotePayload({
      sessionId: 's', model: 'm', promptCount: 1, promptSummary: 'p',
      originUrl: 'u', linesAdded: 1, linesRemoved: 0, durationMs,
    }, true)).origin;

    for (const bad of [undefined, '', 'not-a-date']) {
      expect(sessionDurationMs(bad as string | undefined)).toBeUndefined();
      expect('durationMs' in note(sessionDurationMs(bad as string | undefined))).toBe(false);
    }
  });

  it('measures a real elapsed duration', () => {
    const out = sessionDurationMs(new Date(Date.now() - 5_000).toISOString())!;
    expect(out).toBeGreaterThanOrEqual(4_000);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('never reports a negative duration for a clock-skewed future start', () => {
    expect(sessionDurationMs(new Date(Date.now() + 60_000).toISOString())).toBe(0);
  });
});

describe('full-context injection stamp — dedupe per conversation, not per clock', () => {
  it('reports a conversation that already received the block', () => {
    recordFullContextInjection(repo, 'conv-abc');
    expect(fullContextAlreadyInjected(repo, 'conv-abc')).toBe(true);
  });

  it('does NOT suppress a different conversation in the same repo', () => {
    // A second Cursor chat opened moments later is a fresh context window that
    // needs its own copy — this is the case a time-based window would break.
    recordFullContextInjection(repo, 'conv-abc');
    expect(fullContextAlreadyInjected(repo, 'conv-def')).toBe(false);
  });

  it('is scoped per repo', () => {
    const other = path.join(tmp, 'other-repo');
    fs.mkdirSync(other, { recursive: true });
    recordFullContextInjection(repo, 'conv-abc');
    expect(fullContextAlreadyInjected(other, 'conv-abc')).toBe(false);
  });

  it('reports not-injected when nothing was ever stamped', () => {
    expect(fullContextAlreadyInjected(repo, 'conv-abc')).toBe(false);
  });

  it('fails OPEN on a missing or unknown conversation key — a duplicate beats a miss', () => {
    recordFullContextInjection(repo, undefined);
    expect(fullContextAlreadyInjected(repo, undefined)).toBe(false);
  });

  it('survives a corrupt stamp rather than throwing into the hook', () => {
    recordFullContextInjection(repo, 'conv-abc');
    const stampDir = path.join(os.homedir(), '.origin', 'context-injection');
    for (const f of fs.readdirSync(stampDir)) fs.writeFileSync(path.join(stampDir, f), 'not json');
    expect(fullContextAlreadyInjected(repo, 'conv-abc')).toBe(false);
  });
});
