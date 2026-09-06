// The caption exists so that a screenshot-driven turn means something to the
// NEXT agent, and the next agent reads git notes. The database copy is not the
// point — a caption that only ever lived server-side would leave the repo's
// memory holding a bare `[image]`, which is the hole it was built to fill.

import { describe, it, expect } from 'vitest';
import { applyImageDescriptions } from '../prompt-images.js';
import { buildMemoryEntry, describePromptImages } from '../commands/hooks.js';
import { describeWatchPromptImages } from '../transcript-watch.js';

describe('applyImageDescriptions', () => {
  it('fills the slot the caption belongs to', () => {
    expect(applyImageDescriptions('[image]', { 0: 'a failing test run' }))
      .toBe('[image: "a failing test run"]');
  });

  it('addresses by position across several images', () => {
    expect(applyImageDescriptions('before and after\n[image] [image]', { 1: 'the fixed layout' }))
      .toBe('before and after\n[image] [image: "the fixed layout"]');
  });

  it('fills a slot the server already resolved to an id', () => {
    // The two renderings are independent: the server's copy carries ids so the
    // dashboard can fetch bytes, this copy carries words for a reader.
    expect(applyImageDescriptions('[image:att_1]', { 0: 'a design mock' }))
      .toBe('[image: "a design mock"]');
  });

  it('leaves a slot bare when there is no caption for it', () => {
    expect(applyImageDescriptions('[image] [image]', { 0: 'a log' }))
      .toBe('[image: "a log"] [image]');
  });

  it('strips characters that would break out of the marker', () => {
    expect(applyImageDescriptions('[image]', { 0: 'an alert saying "boom]"' }))
      .toBe('[image: "an alert saying boom"]');
  });

  it('leaves ordinary prompts alone', () => {
    expect(applyImageDescriptions('just words', { 0: 'unused' })).toBe('just words');
  });
});

describe('describePromptImages (hook path)', () => {
  it('captions the prompt the image actually belongs to', () => {
    const prompts = ['first', 'look at this\n[image]'];
    expect(describePromptImages(prompts, { promptImageDescriptions: { '1:0': 'a 500 in the network tab' } }))
      .toEqual(['first', 'look at this\n[image: "a 500 in the network tab"]']);
  });

  it('converts from transcript index space to this launch\'s prompt list', () => {
    // A resumed session: the transcript has 5 earlier turns, `prompts` holds
    // only what this launch saw. Captions arrive numbered from the transcript,
    // so using them raw would caption somebody else's turn.
    const prompts = ['my only turn\n[image]'];
    expect(describePromptImages(prompts, {
      promptIndexBase: 5,
      promptImageDescriptions: { '5:0': 'a stack trace' },
    })).toEqual(['my only turn\n[image: "a stack trace"]']);
  });

  it('drops a caption for a turn that ran before this launch adopted the conversation', () => {
    // Row 2 with base 5 is negative in local space — we hold no prompt for it,
    // and guessing a slot would caption a different turn's screenshot.
    const prompts = ['my only turn\n[image]'];
    expect(describePromptImages(prompts, {
      promptIndexBase: 5,
      promptImageDescriptions: { '2:0': 'someone else\'s screenshot' },
    })).toEqual(['my only turn\n[image]']);
  });

  it('is a no-op with nothing recorded', () => {
    expect(describePromptImages(['a', 'b'], {})).toEqual(['a', 'b']);
  });
});

describe('describeWatchPromptImages (watcher path)', () => {
  it('needs no conversion — the watcher re-derives every prompt each poll', () => {
    const prompts = ['first', 'second\n[image]'];
    expect(describeWatchPromptImages(prompts, { '1:0': 'a red CI run' }))
      .toEqual(['first', 'second\n[image: "a red CI run"]']);
  });

  it('is a no-op with nothing recorded', () => {
    expect(describeWatchPromptImages(['a'], undefined)).toEqual(['a']);
  });
});

describe('the session memory written to git notes', () => {
  it('remembers what the screenshot showed, not that there was one', () => {
    const entry = buildMemoryEntry(
      {
        sessionId: 's1',
        startedAt: new Date(0).toISOString(),
        prompts: ['[image]'],
        promptImageDescriptions: { '0:0': 'a TypeScript error on line 42 of api.ts' },
      },
      { model: 'claude-opus-5', branch: null, filesChanged: [], linesAdded: 0, linesRemoved: 0 },
    );

    // Intent and summary both fall back to the first prompt when there are no
    // explicit markers — which, for a captionless screenshot, used to make both
    // of them the string "[image]".
    expect(entry.summary).toBe('[image: "a TypeScript error on line 42 of api.ts"]');
    expect(entry.intent?.[0]).toBe('[image: "a TypeScript error on line 42 of api.ts"]');
  });
});
