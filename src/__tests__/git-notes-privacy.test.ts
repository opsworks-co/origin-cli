/**
 * Pins the git-notes content contract. Prompt text travels with the repo
 * by default (blame-with-prompts is the product promise and must survive
 * clones), and privacy-sensitive setups can opt OUT — the opted-out
 * payload must carry attribution metadata (model, agent, files, counts,
 * code edits) and zero prompt-text bytes. scrubNoteObject covers the
 * retroactive cleanup path for the opt-out posture.
 */

import { describe, it, expect } from 'vitest';
import { buildNotePayload, scrubNoteObject } from '../git-notes.js';
import type { GitNoteData } from '../git-notes.js';

const SECRET_PROMPT = 'rewrite the billing engine before the acquisition call';
const SECRET_SUMMARY = 'billing engine rewrite for acquisition';

function noteData(): GitNoteData {
  return {
    sessionId: 'sess-1',
    model: 'claude-fable-5',
    agentSlug: 'claude',
    promptCount: 2,
    promptSummary: SECRET_SUMMARY,
    fullPrompt: SECRET_PROMPT,
    prompts: [
      {
        index: 0,
        text: SECRET_PROMPT,
        model: 'claude-fable-5',
        files: ['src/billing.ts'],
        editsJson: JSON.stringify({
          promptIndex: 0,
          promptText: SECRET_PROMPT,
          agent: 'claude',
          commits: [],
          edits: [{ file: 'src/billing.ts', oldContent: 'a', newContent: 'b' }],
        }),
        treeSha: 'tree123',
        commitSha: 'head456',
      },
    ],
    originUrl: 'https://getorigin.io/sessions/sess-1',
    tokensUsed: 1000,
    costUsd: 1.23,
    durationMs: 60000,
    linesAdded: 10,
    linesRemoved: 2,
  };
}

describe('buildNotePayload with prompt text opted out', () => {
  it('carries zero prompt-text bytes but keeps attribution metadata', () => {
    const payload = buildNotePayload(noteData(), false);
    expect(payload).not.toContain('billing engine');
    expect(payload).not.toContain('acquisition');
    const parsed = JSON.parse(payload);
    expect(parsed.origin.promptTextWithheld).toBe(true);
    expect(parsed.origin.promptSummary).toBeUndefined();
    expect(parsed.origin.fullPrompt).toBeUndefined();
    expect(parsed.origin.model).toBe('claude-fable-5');
    expect(parsed.origin.promptCount).toBe(2);
    const p0 = parsed.origin.prompts[0];
    expect(p0.text).toBeUndefined();
    expect(p0.files).toEqual(['src/billing.ts']);
    expect(p0.treeSha).toBe('tree123');
    // Code edits still travel; the embedded promptText is blanked.
    const cap = JSON.parse(p0.editsJson);
    expect(cap.promptText).toBe('');
    expect(cap.edits[0].newContent).toBe('b');
  });

  it('includes prompt text in the default (opted-in) posture', () => {
    const payload = buildNotePayload(noteData(), true);
    const parsed = JSON.parse(payload);
    expect(parsed.origin.promptSummary).toContain('billing engine');
    expect(parsed.origin.fullPrompt).toBe(SECRET_PROMPT);
    expect(parsed.origin.promptTextWithheld).toBeUndefined();
    expect(parsed.origin.prompts[0].text).toBe(SECRET_PROMPT);
    expect(JSON.parse(parsed.origin.prompts[0].editsJson).promptText).toBe(SECRET_PROMPT);
  });
});

describe('scrubNoteObject (retroactive cleanup)', () => {
  it('strips all prompt-text carriers from a legacy note and marks it', () => {
    const legacy = JSON.parse(buildNotePayload(noteData(), true));
    const { changed, scrubbed } = scrubNoteObject(legacy);
    expect(changed).toBe(true);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain('billing engine');
    expect(serialized).not.toContain('acquisition');
    expect(scrubbed.origin.promptTextWithheld).toBe(true);
    expect(scrubbed.origin.model).toBe('claude-fable-5');
    expect(scrubbed.origin.prompts[0].files).toEqual(['src/billing.ts']);
    expect(JSON.parse(scrubbed.origin.prompts[0].editsJson).edits).toHaveLength(1);
  });

  it('is a no-op on an already-clean note', () => {
    const clean = JSON.parse(buildNotePayload(noteData(), false));
    const { changed } = scrubNoteObject(clean);
    expect(changed).toBe(false);
  });

  it('drops an unparseable (truncated) editsJson instead of risking leakage', () => {
    const legacy = JSON.parse(buildNotePayload(noteData(), true));
    legacy.origin.prompts[0].editsJson =
      '{"promptText":"secret start' + '\n/* [origin: editsJson truncated for note portability] */';
    const { changed, scrubbed } = scrubNoteObject(legacy);
    expect(changed).toBe(true);
    expect(scrubbed.origin.prompts[0].editsJson).toBeUndefined();
  });

  it('leaves non-Origin notes untouched', () => {
    expect(scrubNoteObject({ something: 'else' }).changed).toBe(false);
    expect(scrubNoteObject(null).changed).toBe(false);
  });
});
