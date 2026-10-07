/**
 * Claude Code (2.1.277+) loads a folder's AGENTS.md as its instructions when
 * the folder has no CLAUDE.md. Two consequences for the files Origin writes:
 *
 *  1. A CLAUDE.md that an older Origin created for its notice alone hides the
 *     user's AGENTS.md from Claude — originOnlyClaudeMdHidesAgentsMd reports it,
 *     and Origin warns. It never deletes the user's file.
 *  2. An AGENTS.md carrying Origin's full block (for Codex) is read by Claude
 *     too, so the hook leaves out what that file already gave it — but only
 *     when claudeLoadsAgentsMd is sure the file was loaded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ORIGIN_MANAGED_MARKER,
  agentFileCarriesFramework,
  claudeCodeVersion,
  agentsMdLoadedInTranscript,
  claudeLoadsAgentsMd,
  recordAgentsMdObservation,
  originOnlyClaudeMdHidesAgentsMd,
  writeAgentRulesFile,
} from '../commands/hooks.js';
import { ORIGIN_FRAMEWORK_MARKER, ORIGIN_STARTUP_CHECK_MARKER, agentsMdCarries } from '../commands/hooks/session-start.js';

const M = ORIGIN_MANAGED_MARKER;
const block = (body: string) => `${M}\n${body}\n${M}\n`;
const NEW = '/Applications/Claude.app/claude-code/2.1.286/abc/claude';

let repo: string;
let home: string;
const saved: Record<string, string | undefined> = {};

const write = (rel: string, body: string) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agentsmd-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agentsmd-home-'));
  for (const k of ['HOME', 'USERPROFILE', 'CLAUDE_CODE_EXECPATH']) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CODE_EXECPATH = NEW;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('originOnlyClaudeMdHidesAgentsMd', () => {
  it('reports a CLAUDE.md holding only Origin\'s block when AGENTS.md has the user\'s instructions', () => {
    write('CLAUDE.md', block('Origin: Session tracking active.'));
    write('AGENTS.md', '# Use pnpm\n');
    expect(originOnlyClaudeMdHidesAgentsMd(repo)).toBe(true);
    expect(exists('CLAUDE.md')).toBe(true);
  });

  it('does not report a CLAUDE.md with any line of the user\'s', () => {
    write('CLAUDE.md', '# Claude notes\n\n' + block('Origin: Session tracking active.'));
    write('AGENTS.md', '# Use pnpm\n');
    expect(originOnlyClaudeMdHidesAgentsMd(repo)).toBe(false);
  });

  it('does not report a CLAUDE.md that never had Origin\'s block, even an empty one', () => {
    write('CLAUDE.md', '');
    write('AGENTS.md', '# Use pnpm\n');
    expect(originOnlyClaudeMdHidesAgentsMd(repo)).toBe(false);
  });

  it('does not report when AGENTS.md is only Origin\'s block or absent', () => {
    write('CLAUDE.md', block('Origin: Session tracking active.'));
    expect(originOnlyClaudeMdHidesAgentsMd(repo)).toBe(false);
    write('AGENTS.md', block('Origin: Session tracking active.'));
    expect(originOnlyClaudeMdHidesAgentsMd(repo)).toBe(false);
  });

  it('a session start never deletes the user\'s CLAUDE.md', () => {
    write('CLAUDE.md', block('old notice'));
    write('AGENTS.md', '# Use pnpm\n');
    writeAgentRulesFile('claude-code', 'FRESH', repo);
    expect(exists('CLAUDE.md')).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toBe('# Use pnpm\n');
  });
});

describe('claudeLoadsAgentsMd', () => {
  beforeEach(() => write('AGENTS.md', '# Use pnpm\n'));

  it('reads the version from the binary path', () => {
    expect(claudeCodeVersion({ CLAUDE_CODE_EXECPATH: NEW })).toEqual([2, 1, 286]);
    expect(claudeCodeVersion({ CLAUDE_CODE_EXECPATH: '/home/u/.local/share/claude/versions/2.1.277' })).toEqual([2, 1, 277]);
    expect(claudeCodeVersion({})).toBeNull();
  });

  it('is true for 2.1.277+ in a repo with AGENTS.md and no CLAUDE file', () => {
    expect(claudeLoadsAgentsMd(repo)).toBe(true);
  });

  it('is false when the version is unknown or older', () => {
    delete process.env.CLAUDE_CODE_EXECPATH;
    expect(claudeLoadsAgentsMd(repo)).toBe(false);
    process.env.CLAUDE_CODE_EXECPATH = '/x/claude-code/2.1.276/y/claude';
    expect(claudeLoadsAgentsMd(repo)).toBe(false);
  });

  it('is false when any CLAUDE instruction file wins over AGENTS.md', () => {
    for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
      write(rel, '# x\n');
      expect(claudeLoadsAgentsMd(repo)).toBe(false);
      fs.rmSync(path.join(repo, rel));
    }
  });

  it('is false when a settings file turns AGENTS.md off', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'cc-plugin-agents-md': { options: { instructionFiles: 'claude-md' } } } }));
    expect(claudeLoadsAgentsMd(repo)).toBe(false);
    fs.writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'cc-plugin-agents-md': { projectInstructions: 'none' } } }));
    expect(claudeLoadsAgentsMd(repo)).toBe(false);
    fs.writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'cc-plugin-agents-md': { instructionFiles: 'claude-md-and-agents-md' } } }));
    expect(claudeLoadsAgentsMd(repo)).toBe(true);
  });
});

describe('hook leaves out what Claude read from AGENTS.md', () => {
  const full = block(`Origin: Session tracking active.\n\n${ORIGIN_STARTUP_CHECK_MARKER} do this first\n\n${ORIGIN_FRAMEWORK_MARKER} markers`);

  it('drops the framework and repo context when AGENTS.md carries them', () => {
    write('AGENTS.md', '# Use pnpm\n\n' + full);
    expect(agentFileCarriesFramework('claude-code', repo)).toBe(true);
    expect(agentsMdCarries('claude-code', repo, ORIGIN_STARTUP_CHECK_MARKER)).toBe(true);
  });

  it('keeps everything in the hook when Claude may not have loaded AGENTS.md', () => {
    write('AGENTS.md', full);
    delete process.env.CLAUDE_CODE_EXECPATH;
    expect(agentFileCarriesFramework('claude-code', repo)).toBe(false);
    expect(agentsMdCarries('claude-code', repo, ORIGIN_STARTUP_CHECK_MARKER)).toBe(false);
  });

  it('keeps everything in the hook when AGENTS.md has no Origin block', () => {
    write('AGENTS.md', '# Use pnpm\n');
    expect(agentFileCarriesFramework('claude-code', repo)).toBe(false);
    expect(agentsMdCarries('claude-code', repo, ORIGIN_STARTUP_CHECK_MARKER)).toBe(false);
  });

  it('never applies to a file-driven agent', () => {
    write('AGENTS.md', full);
    expect(agentsMdCarries('codex', repo, ORIGIN_STARTUP_CHECK_MARKER)).toBe(false);
  });
});

describe('did Claude really load AGENTS.md', () => {
  const transcript = (entries: object[]) => {
    const t = path.join(repo, 't.jsonl');
    fs.writeFileSync(t, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return t;
  };
  const loadedEntry = (p: string) => ({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: p, type: 'Project' }] } });
  const user = { type: 'user', message: { role: 'user', content: 'hi' } };
  const reply = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };

  beforeEach(() => write('AGENTS.md', '# Use pnpm\n'));

  it('reads yes from an instructions attachment naming the repo AGENTS.md', () => {
    expect(agentsMdLoadedInTranscript(transcript([user, loadedEntry(path.join(repo, 'AGENTS.md')), reply]), repo)).toBe(true);
  });

  it('reads no once a reply came without it — or with only other instruction files', () => {
    expect(agentsMdLoadedInTranscript(transcript([user, reply]), repo)).toBe(false);
    expect(agentsMdLoadedInTranscript(transcript([user, loadedEntry(path.join(home, '.claude', 'CLAUDE.md')), reply]), repo)).toBe(false);
  });

  it('cannot tell before the first reply', () => {
    expect(agentsMdLoadedInTranscript(transcript([user]), repo)).toBeNull();
    expect(agentsMdLoadedInTranscript(path.join(repo, 'missing.jsonl'), repo)).toBeNull();
  });

  it('a recorded "not loaded" stops the prediction; a recorded "loaded" keeps it', () => {
    expect(claudeLoadsAgentsMd(repo)).toBe(true);
    recordAgentsMdObservation(false);
    expect(claudeLoadsAgentsMd(repo)).toBe(false);
    recordAgentsMdObservation(true);
    expect(claudeLoadsAgentsMd(repo)).toBe(true);
  });
});
