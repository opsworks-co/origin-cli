/**
 * A Codex turn's per-file section must carry the `index <old>..<new>` line that
 * proves it is a WINDOW starting where the previous turn's ended.
 *
 * Bug (Codex thread 01a059cc, repo `kotleta`): the rollout-derived per-turn
 * diffs were captured EXACTLY right — 61 / 35 / 32 added over three turns,
 * every line accounted for against the shadow baselines — and the session page
 * showed 61 / 34 / 31. Turn 2 was missing `border: 1px solid var(--line);` from
 * the `kbd` rule it had just written, and turn 3 was missing the `try {` of its
 * `loadView()`, leaving a rendered patch whose `} catch {` opens nothing.
 *
 * Neither line was lost in capture. The server's cross-prompt first-author-wins
 * filter took them: turn 1 had written a byte-identical `border:` declaration in
 * a different rule and a byte-identical `try {` in a different function, and a
 * row an earlier prompt already wrote is a row this one may not claim. That
 * filter exempts sections it can PROVE are disjoint windows, and the proof is a
 * `index <old>..` blob an earlier prompt's capture produced — which these
 * sections did not carry, because `renderFileDiff` emitted only the
 * `diff --git` / `---` / `+++` header.
 *
 * The content to hash is already in hand on both sides (that is what the diff
 * is rendered FROM), so the id is git's own, and consecutive turns chain
 * because turn N's end content is literally turn N+1's start content.
 */
import { describe, it, expect } from 'vitest';
import { codexApplyPatchesToDiff, renderFileDiff } from '../agents/codex.js';

const indexLine = (diff: string, file: string): string | null => {
  const section = diff.split(/^(?=diff --git )/m).find((s) => s.includes(` b/${file}\n`));
  const m = section?.match(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/m);
  return m ? m[0] : null;
};

const blobs = (diff: string, file: string): { old: string; new: string } => {
  const m = indexLine(diff, file)?.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/);
  if (!m) throw new Error(`no index line for ${file}`);
  return { old: m[1], new: m[2] };
};

describe('renderFileDiff — index line', () => {
  it('states git’s own blob id for the content it rendered', () => {
    const r = renderFileDiff('greeting.txt', 'hi\n', 'hello\n');
    // `git hash-object` of "hi\n" and "hello\n" — sha1 over `blob <n>\0<body>`.
    expect(indexLine(r!.diff, 'greeting.txt')).toBe(
      'index 45b983be36b73c0788dc9cbcb76cbb80fc7bb057..ce013625030ba8dba906f756967f9e9ca394464a 100644',
    );
  });

  it('leaves a created file alone — a new file has no old blob to chain to', () => {
    const r = renderFileDiff('new.txt', null, 'one\ntwo\n');
    expect(r!.diff).toContain('new file mode 100644');
    expect(indexLine(r!.diff, 'new.txt')).toBeNull();
  });
});

describe('codexApplyPatchesToDiff — consecutive turns chain end-to-start', () => {
  // A stylesheet where the same declaration legitimately appears in two rules,
  // the shape that cost kotleta turn 2 its line.
  const BASE = [
    '.card {',
    '    border: 1px solid var(--line);',
    '    padding: 8px;',
    '}',
    '',
    'button {',
    '    color: var(--ink);',
    '}',
    '',
  ].join('\n');

  // Turn 1 adds a rule; turn 2 adds another one that repeats turn 1's border row.
  const turn1Patch = [
    '*** Begin Patch',
    '*** Update File: styles.css',
    '@@',
    ' button {',
    '     color: var(--ink);',
    ' }',
    '+',
    '+.badge {',
    '+    border: 1px solid var(--line);',
    '+    font-size: 0.75rem;',
    '+}',
    '*** End Patch',
  ].join('\n');

  const turn2Patch = [
    '*** Begin Patch',
    '*** Update File: styles.css',
    '@@',
    '     font-size: 0.75rem;',
    ' }',
    '+',
    '+kbd {',
    '+    border: 1px solid var(--line);',
    '+    padding: 1px 5px;',
    '+}',
    '*** End Patch',
  ].join('\n');

  const turn1 = codexApplyPatchesToDiff([turn1Patch], undefined, () => BASE);
  const afterTurn1 = [
    BASE.trimEnd(),
    '',
    '.badge {',
    '    border: 1px solid var(--line);',
    '    font-size: 0.75rem;',
    '}',
    '',
  ].join('\n');
  const turn2 = codexApplyPatchesToDiff([turn2Patch], undefined, () => afterTurn1);

  it('renders each turn’s own work', () => {
    expect([turn1.linesAdded, turn1.linesRemoved]).toEqual([5, 0]);
    expect([turn2.linesAdded, turn2.linesRemoved]).toEqual([5, 0]);
  });

  it('hands the server the chain: turn 1’s end blob IS turn 2’s start blob', () => {
    expect(blobs(turn2.diff, 'styles.css').old).toBe(blobs(turn1.diff, 'styles.css').new);
  });

  it('keeps the repeated declaration in the later turn', () => {
    const added = turn2.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added).toContain('+    border: 1px solid var(--line);');
  });
});
