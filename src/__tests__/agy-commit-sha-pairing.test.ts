// A turn that committed must show ITS commit, not one matched by counting.
//
// Session dedec2fa: turns 2 and 4 both ran `git commit`. The watcher joined the
// session late, so its headShaAtStart came AFTER the first commit and the walk
// only ever saw the second one. Order-based pairing then had 2 committing turns
// against 1 known commit, fell back to "anchor the newest commit to the last
// committing turn", and turn 2 rendered `uncommitted` beside the commit it had
// just made.
//
// agy prints the SHA in the commit output, so read it instead of inferring —
// but it routes that output through whichever step type it likes: the second
// commit's SHA arrived on a MODEL/RUN_COMMAND step, the first one's on a
// SYSTEM/SYSTEM_MESSAGE step (that commit failed once on PowerShell's `&&`, was
// retried with `;`, and the success line came back by another channel).

import { describe, it, expect } from 'vitest';



import { parseAntigravityTranscript } from '../antigravity-transcript.js';

// parseAntigravityTranscript takes the JSONL CONTENT, not a path.
function write(steps: object[]): string {
  return steps.map((s) => JSON.stringify(s)).join('\n') + '\n';
}

const userStep = (text: string, at: string) => ({
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  created_at: at,
});
const commitStep = (cmd: string) => ({
  source: 'MODEL', type: 'RUN_COMMAND', content: '',
  tool_calls: [{ name: 'run_command', args: { CommandLine: cmd } }],
});

describe('Antigravity commit-SHA pairing', () => {
  it('reads each turn\'s SHA from the commit output, whatever step carries it', () => {
    const f = write([
      userStep('create a file called petrushka and add 8 rows into it', '2026-08-06T19:04:00Z'),
      { source: 'MODEL', type: 'RUN_COMMAND', content: 'wrote petrushka' },

      userStep('add 7 more and commit', '2026-08-06T19:05:00Z'),
      commitStep('git add petrushka && git commit -m "Add 7 rows"'),
      // First attempt died on PowerShell's `&&`; the retry's success line comes
      // back as a SYSTEM message, not on the MODEL step.
      { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '[add-popoka-rows b995dfa] Add 7 rows to petrushka (15 total)\n 1 file changed, 7 insertions(+)' },

      userStep('add 6 more not commit', '2026-08-06T19:05:10Z'),
      { source: 'MODEL', type: 'RUN_COMMAND', content: 'appended 6 rows' },

      userStep('add 5 more and commit', '2026-08-06T19:05:20Z'),
      commitStep('git add petrushka; git commit -m "Add 11 rows"'),
      { source: 'MODEL', type: 'RUN_COMMAND', content: '[add-popoka-rows f9a95f9] Add 11 rows to petrushka (26 total)' },
    ]);

    const t = parseAntigravityTranscript(f);
    expect(t.prompts.length).toBe(4);
    // Both committing turns are detected…
    expect(t.promptRanCommit).toEqual([false, true, false, true]);
    // …and each carries the SHA its own commit printed.
    expect(t.promptCommitShas[1]).toEqual(['b995dfa']);
    expect(t.promptCommitShas[3]).toEqual(['f9a95f9']);
    // Turns that did not commit claim nothing.
    expect(t.promptCommitShas[0]).toEqual([]);
    expect(t.promptCommitShas[2]).toEqual([]);
  });

  it('claims no SHA when the commit output never appears', () => {
    const f = write([
      userStep('add rows and commit', '2026-08-06T19:04:00Z'),
      commitStep('git commit -am wip'),
    ]);
    const t = parseAntigravityTranscript(f);
    expect(t.promptRanCommit).toEqual([true]);   // it did commit…
    expect(t.promptCommitShas[0]).toEqual([]);   // …but we won't invent which one
  });
});
