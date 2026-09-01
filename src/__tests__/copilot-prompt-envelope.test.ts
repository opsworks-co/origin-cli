// Copilot Desktop wraps the FIRST prompt of every chat in a workspace preamble,
// and storing that preamble verbatim duplicated the session's whole prompt
// history on every subsequent turn.
//
// Real failure (prod copilot sessions 8b25cb05 / 2f31a7fe, 2026-08-25). Two
// prompts were typed. Both sessions rendered FIVE, in the same give-away order:
// [A, <preamble>, B, A, B].
//
// The mechanism is a single poisoned entry, not a double-firing hook:
//
//   1. Copilot's `userPromptSubmitted` payload for prompt #1 is not "how is it
//      going?" — it is <copilot_tauri_workspace> + <copilot_working_context> +
//      <copilot_artifacts> + <branch_rename_request>, the user's sentence buried
//      in the middle, and a <system_notification> trailer. Only the trailer was
//      stripped, so prompt #0 was stored as the whole blob.
//   2. Copilot's own transcript records the CLEAN text ("how is it going?").
//   3. From then on the two lists share no common entry at index 0, so
//      reconcilePromptHistory() finds no overlap and falls back to
//      `[...stored, ...parsed]` — re-appending the entire real history at every
//      Stop.
//
// Strip the envelopes at the hook boundary and the stored list matches the
// transcript again, so reconciliation stays on its ordinary-growth path.

import { describe, expect, it } from 'vitest';
import { stripCopilotEnvelopes } from '../transcript.js';
import { reconcilePromptHistory } from '../session-state.js';

// Verbatim shape of the real payload (trimmed), from
// ~/.copilot/session-state/<id>/events.jsonl `hook.start` userPromptSubmitted.
const FIRST_PROMPT_PAYLOAD = [
  '<copilot_tauri_workspace>',
  'project_name: sardina',
  'workspace_type: worktree',
  'workspace_path: /Users/x/copilot-worktrees/sardina/dolobanko-urban-journey',
  '</copilot_tauri_workspace>',
  '',
  '<copilot_working_context>',
  'container_kind: repository',
  'current_working_directory_is_git_repo: true',
  '</copilot_working_context>',
  '',
  '<copilot_artifacts>',
  'artifacts_dir: /Users/x/.copilot/session-state/3d1b0cba/files',
  '</copilot_artifacts>',
  '',
  '<branch_rename_request>',
  'Before creating or editing any files, call the rename_branch tool.',
  '</branch_rename_request>',
  '',
  'how is it going?',
  '',
  '<system_notification>',
  'Reminder: call the `rename_session` tool.',
  '</system_notification>',
].join('\n');

const SECOND_PROMPT_PAYLOAD = [
  'create some nice code and commit',
  '',
  '<system_notification>',
  'Reminder: call the `rename_session` tool.',
  '</system_notification>',
].join('\n');

describe('stripCopilotEnvelopes', () => {
  it('recovers the user text from the Desktop first-prompt preamble', () => {
    expect(stripCopilotEnvelopes(FIRST_PROMPT_PAYLOAD)).toBe('how is it going?');
  });

  it('still strips the <system_notification> trailer on later prompts', () => {
    expect(stripCopilotEnvelopes(SECOND_PROMPT_PAYLOAD)).toBe('create some nice code and commit');
  });

  it('strips a <copilot_*> block it has never seen by name', () => {
    const s = '<copilot_future_block>\nwhatever\n</copilot_future_block>\n\nfix the build';
    expect(stripCopilotEnvelopes(s)).toBe('fix the build');
  });

  it('leaves markup the user actually typed alone', () => {
    const s = 'why does <system_prompt>foo</system_prompt> break my parser?';
    expect(stripCopilotEnvelopes(s)).toBe(s);
  });

  it('is a no-op on an already-clean prompt', () => {
    expect(stripCopilotEnvelopes('how is it going?')).toBe('how is it going?');
  });
});

describe('Copilot prompt history — two prompts stay two prompts', () => {
  // What the CLI stores when it strips only <system_notification> (the old
  // behaviour), replayed through the exact turn sequence the session ran.
  const replay = (store: (payload: string) => string): string[] => {
    // Turn 1: user-prompt-submit records the payload…
    let stored = [store(FIRST_PROMPT_PAYLOAD)];
    // …then Stop reconciles against the transcript, which has the clean text.
    stored = reconcilePromptHistory(stored, ['how is it going?']);
    // Turn 2: same again.
    stored = [...stored, store(SECOND_PROMPT_PAYLOAD)];
    stored = reconcilePromptHistory(stored, [
      'how is it going?',
      'create some nice code and commit',
    ]);
    return stored;
  };

  it('still corrupts the history when the preamble is kept', () => {
    const oldBehaviour = (p: string) =>
      p.replace(/<system_notification>[\s\S]*?<\/system_notification>/gi, '').trim();

    const prompts = replay(oldBehaviour);

    // Was [A, blob, B, A, B] — five rows for two prompts, because
    // reconcilePromptHistory's last-resort branch concatenated the whole
    // stored history onto the parsed one. That branch now appends only what it
    // does not already hold, so A and B are no longer re-added: [A, blob, B].
    //
    // Three rows for two prompts is still wrong, and the remaining row is the
    // point of this file. Only the FIRST payload carries the workspace
    // preamble; stripping just <system_notification> leaves it in, so that
    // text never equals the transcript's clean 'how is it going?' and can
    // never be recognised as the prompt it actually is. The second payload
    // cleans up fine either way, which is why only one blob survives.
    // The next test is the fixed path.
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe('how is it going?');
    expect(prompts[1]).toContain('<copilot_tauri_workspace>');
    expect(prompts[2]).toBe('create some nice code and commit');
    // The duplicated USER prompts are gone — each appears exactly once.
    expect(prompts.filter((p) => p === 'how is it going?')).toHaveLength(1);
    expect(prompts.filter((p) => p === 'create some nice code and commit')).toHaveLength(1);
    // The duplicate USER prompt is gone: 'how is it going?' appears once.
    expect(prompts.filter((p) => p === 'how is it going?')).toHaveLength(1);
  });

  it('records exactly the two prompts the user typed', () => {
    expect(replay(stripCopilotEnvelopes)).toEqual([
      'how is it going?',
      'create some nice code and commit',
    ]);
  });
});
