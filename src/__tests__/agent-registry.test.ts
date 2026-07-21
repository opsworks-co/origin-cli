// The agent registry is a faithful move of hooks.ts's scattered per-agent
// tables — these tests pin the behaviors that used to live inline (display
// precedence, slug-first session matching, brand-vs-model classification) so
// future agent additions can't silently regress them.
import { describe, it, expect } from 'vitest';
import {
  AGENTS,
  isSpecificModel,
  sessionMatchesAgent,
  isCodexLikeModel,
  resolveAgentDisplayName,
  attributionPgrepChecks,
  standalonePgrepChecks,
} from '../agents/registry.js';

describe('resolveAgentDisplayName (precedence)', () => {
  it('slug antigravity is authoritative over the gemini model', () => {
    expect(resolveAgentDisplayName('gemini-3-pro', 'antigravity')).toBe('Antigravity');
  });
  it('composite model names resolve to the specific agent, not the generic rule', () => {
    expect(resolveAgentDisplayName('copilot-gpt4')).toBe('Copilot');   // not Cursor
    expect(resolveAgentDisplayName('amp-claude-opus')).toBe('Amp');    // not Claude Code
  });
  it('generic families resolve as before', () => {
    expect(resolveAgentDisplayName('gpt-5.5')).toBe('Cursor');
    expect(resolveAgentDisplayName('gpt-5-codex')).toBe('Codex');
    expect(resolveAgentDisplayName('claude-opus-4-8')).toBe('Claude Code');
    expect(resolveAgentDisplayName('gemini-2.5-pro')).toBe('Gemini CLI');
    expect(resolveAgentDisplayName(undefined)).toBe('AI');
  });
  it('the slug is authoritative over the model — agents that run foreign models', () => {
    // Copilot/Windsurf run Claude/GPT models; resolving by model alone mislabels
    // them ("Claude Code"/"Cursor"). The slug wins when present.
    expect(resolveAgentDisplayName('claude-haiku-4.5', 'copilot')).toBe('Copilot');
    expect(resolveAgentDisplayName('gpt-5-mini', 'copilot')).toBe('Copilot');
    expect(resolveAgentDisplayName('claude-sonnet-4-6', 'windsurf')).toBe('Windsurf');
    expect(resolveAgentDisplayName('gpt-5.5', 'codex')).toBe('Codex');
    // 'claude-code' pipeline slug maps to the registry's 'claude' entry.
    expect(resolveAgentDisplayName('claude-opus-4-8', 'claude-code')).toBe('Claude Code');
    // Unknown slug falls back to model-based resolution.
    expect(resolveAgentDisplayName('claude-opus-4-8', 'mystery-agent')).toBe('Claude Code');
  });
});

describe('sessionMatchesAgent', () => {
  it('stored agentSlug wins over model patterns', () => {
    expect(sessionMatchesAgent({ agentSlug: 'cursor', model: 'claude-opus' }, 'cursor')).toBe(true);
    expect(sessionMatchesAgent({ agentSlug: 'cursor', model: 'claude-opus' }, 'claude')).toBe(false);
  });
  it('model patterns cover legacy sessions without a slug', () => {
    expect(sessionMatchesAgent({ model: 'composer-2.5-fast' }, 'cursor')).toBe(true);
    expect(sessionMatchesAgent({ model: 'gemini-2.5-pro' }, 'gemini')).toBe(true);
    expect(sessionMatchesAgent({ model: 'claude-opus-4-8' }, 'codex')).toBe(false);
  });
  it('unknown agents fall back to substring matching', () => {
    expect(sessionMatchesAgent({ model: 'somenewagent-v1' }, 'somenewagent')).toBe(true);
  });
});

describe('isSpecificModel', () => {
  it('rejects bare brands, accepts real identifiers', () => {
    for (const bare of ['claude', 'codex', 'cursor', 'ai', 'unknown', '', 'GEMINI']) {
      expect(isSpecificModel(bare)).toBe(false);
    }
    expect(isSpecificModel('claude-opus-4-8')).toBe(true);
    expect(isSpecificModel('gpt-5-codex')).toBe(true);
    expect(isSpecificModel(null)).toBe(false);
  });
});

describe('isCodexLikeModel', () => {
  it('matches the gpt/codex/o-reasoning family only', () => {
    expect(isCodexLikeModel('gpt-5.5')).toBe(true);
    expect(isCodexLikeModel('codex')).toBe(true);
    expect(isCodexLikeModel('o3-mini')).toBe(true);
    expect(isCodexLikeModel('claude-opus-4-8')).toBe(false);
    expect(isCodexLikeModel(undefined)).toBe(false);
  });
});

describe('pgrep tables', () => {
  it('every attribution check maps to a registered slug', () => {
    const slugs = new Set(AGENTS.map((a) => a.slug));
    for (const c of attributionPgrepChecks()) {
      expect(slugs.has(c.slug)).toBe(true);
      expect(c.cmd.startsWith('pgrep -f ')).toBe(true);
    }
    expect(attributionPgrepChecks().length).toBe(12); // faithful to the old table
  });
  it('standalone detection stays the narrow CLI-binary list', () => {
    expect(standalonePgrepChecks().map((c) => c.model).sort()).toEqual(
      ['aider', 'amp', 'claude', 'codex', 'copilot', 'gemini', 'opencode'],
    );
  });
});
