// Regression tests for the prompt-cleaner. Codex reads AGENTS.md natively
// and re-emits its content as the first "user" turn in its rollout — that
// envelope used to leak through and show up as a fake first prompt in the
// dashboard. Verify both detection paths drop it.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript, extractPromptFileMappings } from '../transcript.js';

function writeJsonl(entries: any[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-prompt-test-'));
  const file = path.join(tmp, 'transcript.jsonl');
  // Always end with a trailing newline + sentinel assistant entry — a single
  // newline-free JSON entry would trip parseTranscript's single-object Gemini
  // detection and skip the JSONL parser entirely.
  const sentinel = { type: 'assistant', message: { role: 'assistant', content: '' } };
  const all = [...entries, sentinel];
  fs.writeFileSync(file, all.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('cleanPrompt — system-injected envelope filtering', () => {
  it('drops a user message that is just our origin-managed AGENTS.md echo', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '# AGENTS.md instructions for /Users/me/repo <INSTRUCTIONS> <!-- origin-managed --> Origin: Session tracking active — prompts, files, and tokens will be captured. </INSTRUCTIONS>',
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: 'make some changes and commit' },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['make some changes and commit']);
  });

  it('drops a user message containing only the origin-managed marker (Claude Code path)', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'wrapper\n<!-- origin-managed -->\nOrigin: Session tracking active\n<!-- origin-managed -->\nmore wrapper',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual([]);
  });

  it('strips the <INSTRUCTIONS> envelope but keeps any real text outside it', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'fix the failing test\n<INSTRUCTIONS>system stuff</INSTRUCTIONS>',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['fix the failing test']);
  });

  it('unwraps Codex image-attachment prompts (Files mentioned / My request for Codex)', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '# Files mentioned by the user:\n## codex-clipboard-abc.png:\n/tmp/codex-clipboard-abc.png\n## My request for Codex:\nadd a login button <image name=[Image #1] path="/tmp/codex-clipboard-abc.png"></image>',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    // Only the real request survives; the wrapper + <image> tag are stripped.
    // The image itself leaves a `[image]` placeholder behind — the tag is noise,
    // but the screenshot the user attached is part of what they asked.
    expect(parsed.prompts).toEqual(['add a login button\n[image]']);
  });

  it('unwraps the current Codex desktop attachment envelope (My request)', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '# Files mentioned by the user:\n## codex-clipboard-abc.png:\n/tmp/codex-clipboard-abc.png\n## My request:\nfix duplicated sessions <image name=[Image #1] path="/tmp/codex-clipboard-abc.png">',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['fix duplicated sessions\n[image]']);
  });

  it('keeps a Codex image-only prompt as a placeholder rather than showing the envelope — or nothing', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '# Files mentioned by the user:\n## shot.png:\n/tmp/shot.png\n## My request for Codex:\n<image name=[Image #1] path="/tmp/shot.png"></image>',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    // Dropping it entirely was the old behaviour and it was wrong twice over:
    // the turn vanished from the dashboard and from git notes, and the image
    // extractor — which always counted this as a prompt — then numbered every
    // later screenshot against a row belonging to a different turn.
    expect(parsed.prompts).toEqual(['[image]']);
  });

  it('keeps a normal prompt that has no envelope at all', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'add a dark mode toggle' },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['add a dark mode toggle']);
  });

  it('unwraps a Cursor illustrated prompt to the typed words plus an [image] placeholder', () => {
    // Verbatim shape from session 562314d8's agent-transcripts JSONL. The hook
    // used to store the whole envelope, Stop stored the inner text, and the
    // dashboard showed the turn twice with `[Image]` wrappers.
    const file = writeJsonl([
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: [
                '[Image]',
                '<image_files>',
                'The following images were provided by the user and saved to disk for future use:',
                '1. /Users/me/.cursor/projects/origin/assets/shot.png',
                '</image_files>',
                '<timestamp>Monday, Sep 7, 2026, 9:14 PM (UTC-4)</timestamp>',
                '<user_query>',
                "also, check and fix why PR's from cursor do not contain sessions attached",
                '</user_query>',
              ].join('\n'),
            },
          ],
        },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual([
      "also, check and fix why PR's from cursor do not contain sessions attached\n[image]",
    ]);
  });

  it('drops Cursor Task / subagent follow-up injections', () => {
    const file = writeJsonl([
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: '<user_query>fix the capture</user_query>' }],
        },
      },
      {
        role: 'user',
        message: {
          content: [{
            type: 'text',
            text: '<timestamp>Monday, Sep 7, 2026, 9:13 PM (UTC-4)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed). If there\'s no follow-ups needed, don\'t explicitly say that.</user_query>',
          }],
        },
      },
      {
        role: 'user',
        message: {
          content: [{
            type: 'text',
            text: '<user_query>Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.</user_query>',
          }],
        },
      },
    ]);
    expect(parseTranscript(file).prompts).toEqual(['fix the capture']);
  });

  it('drops a Cursor conversation-summary catalog dump, and does not replay the last prompt', () => {
    // Session 761adbe8: after a summary Cursor wrote the tool catalog as a
    // user-role message, then re-appended the same illustrated prompt so the
    // model could continue. Both became dashboard turns; the catalog stole
    // the rest of the in-flight files.
    const illustrated = [
      '[Image]',
      '<image_files>',
      '1. /Users/me/.cursor/projects/origin/assets/shot.png',
      '</image_files>',
      '<timestamp>Tuesday, Sep 8, 2026, 8:20 AM (UTC-4)</timestamp>',
      '<user_query>',
      'after session is over it shows wrong number again',
      '</user_query>',
    ].join('\n');
    const catalog = [
      '<available_subagent_types>',
      'Available subagent_types and a quick description of what they do:',
      '- generalPurpose: General-purpose agent for researching complex questions.',
      '</available_subagent_types>',
      '<available_subagent_models>',
      '- inherit (default)',
      '</available_subagent_models>',
      '<dynamic_tool_namespaces>',
      'cursor-ide-browser',
      '</dynamic_tool_namespaces>',
      '<dynamic_tools>',
      'browser_navigate, browser_snapshot',
      '</dynamic_tools>',
    ].join('\n');
    const file = writeJsonl([
      { role: 'user', message: { content: [{ type: 'text', text: illustrated }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: catalog }] } },
      { role: 'user', message: { content: [{ type: 'text', text: illustrated }] } },
    ]);
    expect(parseTranscript(file).prompts).toEqual([
      'after session is over it shows wrong number again\n[image]',
    ]);
  });

  it('keeps a user_query that sits next to a catalog dump in the same entry', () => {
    const file = writeJsonl([
      {
        role: 'user',
        message: {
          content: [{
            type: 'text',
            text: [
              '<available_subagent_types>generalPurpose</available_subagent_types>',
              '<user_query>fix the last prompt capture</user_query>',
            ].join('\n'),
          }],
        },
      },
    ]);
    expect(parseTranscript(file).prompts).toEqual(['fix the last prompt capture']);
  });

  it('drops a Cursor compact hooks_context dump, and does not replay the last prompt untagged', () => {
    // Session 593241fe: after compact, Cursor injected Origin's hooks_context
    // as a user-role message and then re-appended the previous sentence
    // WITHOUT <user_query> tags. Both became dashboard turns (7 and 8).
    const asked = 'so we need tO fix something? if so - do so, and open new PR';
    const hooks = [
      '<hooks_context description="Additional context provided by session hooks.">',
      'Origin: Session tracking active — prompts, files, and tokens will be captured.',
      '',
      'Repository AI context: 97% of recent commits (29/30) are AI-generated.',
      '</hooks_context>',
    ].join('\n');
    const file = writeJsonl([
      { role: 'user', message: { content: [{ type: 'text', text: `<user_query>${asked}</user_query>` }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: hooks }] } },
      { role: 'user', message: { content: [{ type: 'text', text: asked }] } },
    ]);
    expect(parseTranscript(file).prompts).toEqual([asked]);
    expect(extractPromptFileMappings(file).map((m) => m.promptText)).toEqual([asked]);
  });

  it('still counts two identical Claude prompts as two turns', () => {
    // The replay skip is Cursor-shaped only. Claude (and anyone else) can
    // genuinely send "try again" twice; those entries have no <user_query>.
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: 'try again' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
      { type: 'user', message: { role: 'user', content: 'try again' } },
    ]);
    expect(parseTranscript(file).prompts).toEqual(['try again', 'try again']);
  });
});
