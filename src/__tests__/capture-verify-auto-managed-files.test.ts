// Origin's own context files are not agent work, and the verifier must agree.
//
// `stripIgnoredSectionsFromDiff` drops AGENTS.md / CLAUDE.md / GEMINI.md … from
// every captured diff by basename, so a turn whose `filesChanged` still names
// one can never have it matched by the stored diff. On 2026-09-13
// `release:cli:check` blocked on session 081e0a26 turn 1:
// `claimed_file_absent_from_diff` naming only AGENTS.md. The exemption uses
// `isOriginAutoManagedPath`, the same rule the capture paths drop by — not a
// second list.
import { describe, it, expect } from 'vitest';
import { verifyTurn, verifyHeader, type VerifiableTurn } from '../capture-verify.js';

const patch = (file: string, adds: string[]) => [
  `diff --git a/${file} b/${file}`,
  'index 1111111..2222222 100644',
  `--- a/${file}`,
  `+++ b/${file}`,
  `@@ -1,1 +1,${1 + adds.length} @@`,
  ' context',
  ...adds.map((l) => `+${l}`),
].join('\n');

const codes = (turn: VerifiableTurn) => verifyTurn(turn).map((v) => v.code);

describe('capture-verify exempts Origin auto-managed files', () => {
  it('a turn claiming AGENTS.md whose diff omits it is not a contradiction', () => {
    expect(verifyTurn({
      promptIndex: 1,
      filesChanged: ['src/a.ts', 'AGENTS.md'],
      diff: patch('src/a.ts', ['one']),
      linesAdded: 1,
      linesRemoved: 0,
    })).toEqual([]);
  });

  it('a turn claiming ONLY a managed file, with no diff, is not files_without_content', () => {
    expect(verifyTurn({ promptIndex: 1, filesChanged: ['AGENTS.md'], diff: '' })).toEqual([]);
  });

  it('a nested or other managed file is exempt too', () => {
    expect(codes({
      promptIndex: 1,
      filesChanged: ['src/a.ts', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'],
      diff: patch('src/a.ts', ['one']),
    })).not.toContain('claimed_file_absent_from_diff');
  });

  it('an older row whose diff still carries AGENTS.md is not diff_file_unclaimed', () => {
    expect(codes({
      promptIndex: 1,
      filesChanged: ['src/a.ts'],
      diff: `${patch('src/a.ts', ['one'])}\n${patch('AGENTS.md', ['managed'])}`,
    })).not.toContain('diff_file_unclaimed');
  });

  it('a REAL claimed file missing from the diff still contradicts', () => {
    const v = verifyTurn({
      promptIndex: 1,
      filesChanged: ['src/a.ts', 'AGENTS.md', 'src/missing.ts'],
      diff: patch('src/a.ts', ['one']),
    });
    const absent = v.find((x) => x.code === 'claimed_file_absent_from_diff');
    expect(absent?.files).toEqual(['src/missing.ts']);
  });

  it('a user file that merely resembles a managed path is still graded', () => {
    // `origin.md` is only managed at `.devin/rules/origin.md`.
    expect(codes({
      promptIndex: 1,
      filesChanged: ['src/a.ts', 'docs/origin.md'],
      diff: patch('src/a.ts', ['one']),
    })).toContain('claimed_file_absent_from_diff');
  });

  it('a header naming AGENTS.md that no turn claims is not header_file_unclaimed_by_turns', () => {
    const turns: VerifiableTurn[] = [{ promptIndex: 0, filesChanged: ['src/a.ts'], diff: patch('src/a.ts', ['one']) }];
    expect(verifyHeader({ filesChanged: ['src/a.ts', 'AGENTS.md'], linesAdded: 1, linesRemoved: 0 }, turns)).toEqual([]);
    const v = verifyHeader({ filesChanged: ['src/a.ts', 'AGENTS.md', 'their.ts'], linesAdded: 1, linesRemoved: 0 }, turns);
    expect(v.map((x) => x.code)).toEqual(['header_file_unclaimed_by_turns']);
    expect(v[0].files).toEqual(['their.ts']);
  });
});
