/**
 * A commit note names the model that ran, not the agent's brand.
 *
 * A Claude Code session whose SessionStart carried no model stores "claude"
 * (the pgrep guess), and the commit note copied it — while the transcript the
 * same hook parses names the real model. The note is the only record of the
 * model another org, or an offline reader, ever sees: the dashboard showed
 * "Claude" with no model for that commit.
 */
import { describe, it, expect } from 'vitest';
import { firstSpecificModel } from '../agents/registry.js';
import { hooksSource } from './helpers/hooks-source.js';

describe('firstSpecificModel', () => {
  it('prefers a real model over the bare brand, whatever the order', () => {
    expect(firstSpecificModel('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(firstSpecificModel('gpt-5.6-sol', 'codex')).toBe('gpt-5.6-sol');
  });

  it('falls back to the brand when nothing names a model, and never to a placeholder', () => {
    expect(firstSpecificModel('claude', undefined, '')).toBe('claude');
    expect(firstSpecificModel('<synthetic>', 'claude')).toBe('claude');
    expect(firstSpecificModel(undefined, null)).toBeUndefined();
  });
});

describe('post-commit note model', () => {
  const src = hooksSource();
  it('takes the parsed transcript\'s model before the note is written', () => {
    const fix = src.indexOf('noteModel = firstSpecificModel(noteModel, parsedForSessionWrite.model)');
    const write = src.indexOf('writeGitNotes(repoPath, [commitSha], {');
    expect(fix, 'the transcript model no longer reaches the note').toBeGreaterThan(-1);
    expect(fix).toBeLessThan(write);
  });
});
