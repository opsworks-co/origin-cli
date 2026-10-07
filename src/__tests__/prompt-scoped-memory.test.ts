// Everything Origin injects at session start is a fixed slice chosen BEFORE the
// task was known: the last N sessions, the hottest files, the newest brief. It
// answers "what happened here recently", which is only accidentally the same
// question as "what does THIS task need to know".
//
// The prompt-scoped search closes that by retrieving with the prompt itself. Its
// entire value is the ranking, and a retrieval layer fails silently in both
// directions: too loose and every prompt drags in three irrelevant records until
// the agent learns to skim the block; too tight and it never fires and the
// feature is dead weight nobody notices. Both directions are pinned here.
import { describe, it, expect } from 'vitest';
import { extractMemoryTerms, effectiveMemoryTerms } from '../memory.js';

const weightOf = (prompt: string, term: string): number =>
  extractMemoryTerms(prompt).find((t) => t.term === term)?.weight ?? 0;

describe('extractMemoryTerms', () => {
  it('weights a path far above an ordinary word', () => {
    // "the session that touched this exact file" and "the session that used
    // this word" are different classes of evidence and must not tie. A path
    // also clears the score threshold ON ITS OWN, which no number of ordinary
    // words below four can do.
    const prompt = 'please update packages/cli/src/memory.ts to handle retries';
    const path = weightOf(prompt, 'packages/cli/src/memory.ts');
    expect(path).toBeGreaterThanOrEqual(weightOf(prompt, 'retries') * 5);
    expect(path).toBeGreaterThanOrEqual(8);
  });

  it('makes four ordinary words enough to be retrievable', () => {
    // The recall fix. At weight 1 a prose prompt needed EIGHT matching words to
    // reach the threshold, so in practice retrieval only ever fired when the
    // user named a file — measured 0/6 on prompts whose subject was provably in
    // this repo's own notes.
    const terms = extractMemoryTerms('the notes sweep archived a captured session');
    const ceiling = terms.reduce((n, t) => n + t.weight, 0);
    expect(ceiling).toBeGreaterThanOrEqual(8);
  });

  it('indexes a path\'s basename too, so partial paths still match', () => {
    // A prompt says `src/memory.ts`; the note recorded
    // `packages/cli/src/memory.ts`. Neither string contains the other.
    const terms = extractMemoryTerms('look at src/memory.ts');
    expect(terms.map((t) => t.term)).toContain('memory.ts');
  });

  it('picks up identifiers as shared jargon', () => {
    const prompt = 'why does isSubstantiveMemory drop those entries';
    expect(weightOf(prompt, 'issubstantivememory')).toBeGreaterThan(weightOf(prompt, 'entries'));
  });

  it('drops stopwords and conversational filler', () => {
    const terms = extractMemoryTerms('can you please just go and fix the code for me thanks');
    expect(terms).toEqual([]);
  });

  it('returns nothing for an empty or contentless prompt', () => {
    expect(extractMemoryTerms('')).toEqual([]);
    expect(extractMemoryTerms('   ')).toEqual([]);
    expect(extractMemoryTerms('ok thanks')).toEqual([]);
    // "continue" survives as a word but carries no retrieval signal on its own;
    // the score threshold, not the tokenizer, is what stops it matching — one
    // plain word tops out at 2 against a threshold of 8.
    const solo = extractMemoryTerms('continue');
    expect(solo.reduce((n, t) => n + t.weight, 0)).toBeLessThan(8);
  });

  it('keeps the strongest weight when a term arrives twice', () => {
    // `hooks.ts` reaches the tokenizer as a path AND as a bare word; the second
    // sighting must not demote it to weight 1.
    expect(weightOf('hooks.ts — check hooks.ts again', 'hooks.ts')).toBeGreaterThan(1);
  });

  it('does not treat a bare version or number as a path', () => {
    const terms = extractMemoryTerms('bump to 1.2 today').map((t) => t.term);
    expect(terms).not.toContain('1.2');
  });

  it('does not give a word in slashed prose the weight of a file', () => {
    // "prompts/diffs/token" is a sentence, not a path. Its last word used to be
    // indexed at basename weight and then doubled on any record that changed
    // a file named tokens.ts.
    expect(weightOf('the metadata from prompts/diffs/token counts', 'token')).toBeLessThan(4);
    expect(weightOf('look at src/git-notes.ts', 'git-notes.ts')).toBe(8);
  });
});

describe('effectiveMemoryTerms', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  const corpus = (n: number, shared: string) => Array.from({ length: n }, (_, i) => `record ${i} ${shared}`);

  it('leaves a short prompt exactly as it was', () => {
    const terms = extractMemoryTerms('a heartbeat tick replacing a hook capture row');
    expect(effectiveMemoryTerms(terms, corpus(40, 'hook row capture'))).toEqual(terms);
  });

  it('makes each plain word of a long prompt worth less', () => {
    const terms = words(48).map((term) => ({ term, weight: 2 }));
    const out = effectiveMemoryTerms(terms, []);
    expect(out.every((t) => t.weight === 0.5)).toBe(true);
  });

  it('drops a plain word most records share, once the prompt is long', () => {
    const terms = [...words(20), 'session'].map((term) => ({ term, weight: 2 }));
    const out = effectiveMemoryTerms(terms, corpus(20, 'session'));
    expect(out.map((t) => t.term)).not.toContain('session');
  });

  it('keeps a path and an identifier at full weight in a long prompt', () => {
    const terms = [
      ...words(60).map((term) => ({ term, weight: 2 })),
      { term: 'src/memory.ts', weight: 10 },
      { term: 'searchMemoryForPrompt', weight: 4 },
    ];
    const out = effectiveMemoryTerms(terms, corpus(20, 'nothing'));
    expect(out.find((t) => t.term === 'src/memory.ts')?.weight).toBe(10);
    expect(out.find((t) => t.term === 'searchMemoryForPrompt')?.weight).toBe(4);
  });
});
