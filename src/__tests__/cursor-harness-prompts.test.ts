/**
 * Cursor Task-tool completions and subagent follow-ups arrive as a user_query.
 * They are not turns. Anchored-match only — a user who mentions the phrase
 * keeps their prompt. Session 562314d8 stored both as ordinary chat rows.
 */
import { describe, it, expect } from 'vitest';
import {
  isKnownCursorInternalPrompt,
  promptTextForEntry,
  transcriptPromptIfNew,
} from '../transcript.js';

const TASK_FOLLOWUP =
  'Briefly inform the user about the task result and perform any follow-up actions (if needed). If there\'s no follow-ups needed, don\'t explicitly say that.';
const SUBAGENT_FOLLOWUP =
  'Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required. If you mention an agent or subagent in your response, link it with the `[Name](id)` Don\'t use generic label such as `[agent]`.';

describe('isKnownCursorInternalPrompt (live-hook guard)', () => {
  it('matches the Task-tool follow-up (anchored at start, including the user_query envelope)', () => {
    expect(isKnownCursorInternalPrompt(TASK_FOLLOWUP)).toBe(true);
    expect(isKnownCursorInternalPrompt(
      `<timestamp>Monday, Sep 7, 2026, 9:13 PM (UTC-4)</timestamp>\n\n<user_query>${TASK_FOLLOWUP}</user_query>`,
    )).toBe(true);
    expect(isKnownCursorInternalPrompt(`  \n${TASK_FOLLOWUP}`)).toBe(true);
  });

  it('matches the subagent-completion follow-up', () => {
    expect(isKnownCursorInternalPrompt(SUBAGENT_FOLLOWUP)).toBe(true);
  });

  it('does NOT match a user prompt that merely mentions the phrase', () => {
    expect(isKnownCursorInternalPrompt(
      'why does Origin show "Briefly inform the user about the task result" as a turn?',
    )).toBe(false);
    expect(isKnownCursorInternalPrompt('fix the failing test in utils')).toBe(false);
    expect(isKnownCursorInternalPrompt('')).toBe(false);
    expect(isKnownCursorInternalPrompt(null)).toBe(false);
    expect(isKnownCursorInternalPrompt(['Briefly inform the user about the task result'] as any)).toBe(false);
  });

  it('drops a Cursor conversation-summary subagent catalog injection', () => {
    const raw = [
      '<available_subagent_types>',
      'Available subagent_types and a quick description of what they do:',
      '- generalPurpose: General-purpose agent',
      '</available_subagent_types>',
    ].join('\n');
    expect(isKnownCursorInternalPrompt(raw)).toBe(true);
    expect(promptTextForEntry({
      role: 'user',
      message: { content: [{ type: 'text', text: raw }] },
    })).toBeNull();
  });

  it('drops a Cursor compact hooks_context injection', () => {
    const raw = [
      '<hooks_context description="Additional context provided by session hooks. This may include project-specific information, configuration, or instructions from the user\'s hooks setup.">',
      'Origin: Session tracking active — prompts, files, and tokens will be captured.',
      '',
      'Repository AI context: 97% of recent commits (29/30) are AI-generated.',
      '</hooks_context>',
    ].join('\n');
    expect(isKnownCursorInternalPrompt(raw)).toBe(true);
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: raw },
    })).toBeNull();
  });

  it('drops an unclosed hooks_context clipped at 1000 chars (live hook store)', () => {
    const raw = '<hooks_context description="Additional context provided by session hooks.">\nOrigin: Session tracking active — prompts, files, and tokens will be captured.\n\nRepository AI context: 97% of recent commits'.padEnd(1000, 'x');
    expect(isKnownCursorInternalPrompt(raw)).toBe(true);
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: raw },
    })).toBeNull();
  });
});

describe('promptTextForEntry — Cursor hook payload', () => {
  it('stores the typed words, not the timestamp / image_files envelope', () => {
    const raw = [
      '[Image]',
      '<image_files>',
      'The following images were provided by the user and saved to disk for future use:',
      '1. /Users/me/.cursor/projects/origin/assets/shot.png',
      '</image_files>',
      '<timestamp>Monday, Sep 7, 2026, 7:57 PM (UTC-4)</timestamp>',
      "<user_query>\nwhy the PR doesn't have this session linked\n</user_query>",
    ].join('\n');
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: raw },
    })).toBe("why the PR doesn't have this session linked\n[image]");
  });

  it('drops a harness follow-up so the hook does not open a turn', () => {
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: `<user_query>${TASK_FOLLOWUP}</user_query>` },
    })).toBeNull();
  });

  it('drops a conversation-summary catalog dump so it is not a turn', () => {
    const catalog = [
      '<available_subagent_types>',
      '- generalPurpose: research',
      '</available_subagent_types>',
      '<dynamic_tools>browser_navigate</dynamic_tools>',
    ].join('\n');
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: catalog },
    })).toBeNull();
  });

  it('keeps a captionless screenshot as a turn', () => {
    const raw = [
      '[Image]',
      '<image_files>',
      '1. /Users/me/.cursor/projects/origin/assets/shot.png',
      '</image_files>',
      '<timestamp>Monday, Sep 7, 2026, 7:57 PM (UTC-4)</timestamp>',
      '<user_query>\n</user_query>',
    ].join('\n');
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: raw },
    })).toBe('[image]');
  });
});

describe('transcriptPromptIfNew — Cursor summary replay', () => {
  const illustrated = {
    role: 'user',
    message: { content: '<timestamp>Tue</timestamp><user_query>after session is over</user_query>' },
  };

  it('keeps the first illustrated prompt and drops the identical replay', () => {
    const first = transcriptPromptIfNew(illustrated, null);
    expect(first).toBe('after session is over');
    expect(transcriptPromptIfNew(illustrated, first)).toBeNull();
  });
});

describe('hooks_context sitting next to a real query', () => {
  it('keeps a user_query sitting next to hooks_context in the same entry', () => {
    const raw = [
      '<hooks_context description="session hooks">Origin: Session tracking active</hooks_context>',
      '<user_query>fix the last prompt capture</user_query>',
    ].join('\n');
    expect(isKnownCursorInternalPrompt(raw)).toBe(false);
    expect(promptTextForEntry({
      type: 'user',
      message: { role: 'user', content: raw },
    })).toBe('fix the last prompt capture');
  });
});
