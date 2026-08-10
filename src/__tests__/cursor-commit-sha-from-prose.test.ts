// Regression: a Cursor turn that commits could not say WHICH commit it made, so
// the commit went unattached and unrecorded.
//
// Cursor's transcript is written at TURN END. A turn that creates a file and
// commits it is therefore already finished by the time the watcher first sees
// the session — on session 1a80ae77 commit 74d04c6 was 20 seconds OLDER than
// first sight, which made it the session's own headShaAtStart. No
// headShaAtStart..HEAD walk can ever contain that commit, so order-based
// pairing had nothing to pair: the turn showed "uncommitted" beside the commit
// it had just made, per-commit memory recorded nothing, and the session
// reported zero commits.
//
// Cursor records tool CALLS but never tool OUTPUT, so the `[main 74d04c6]`
// banner git prints is nowhere in the file. The only surviving mention is the
// agent's own summary — "committed it (`74d04c6`)".
//
// Prose is a weak source and these tests pin the guards that make it usable. An
// 8-hex token is indistinguishable from a session ID, and agents quote those
// constantly: over this repo's own Claude transcript an unrestricted reader
// claimed 35 shas of which 31 were session IDs and quoted history. Hence the
// three gates asserted below — opt-in per adapter, the turn must really have
// run `git commit`, and the sha must sit in a sentence about committing.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPromptFileMappings, reportedCommitShas } from '../transcript.js';

function write(lines: string[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cursor-sha-'));
  const f = path.join(tmp, 't.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

const user = (t: string) =>
  JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${t}\n</user_query>` }] } });
const assistant = (blocks: any[]) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
const turnEnded = () => JSON.stringify({ type: 'turn_ended', status: 'success' });
const shell = (command: string) => ({ type: 'tool_use', name: 'Shell', input: { command, description: 'x' } });
const text = (t: string) => ({ type: 'text', text: t });

const READ = { readReportedShas: true };

describe('reportedCommitShas', () => {
  it("reads the sha out of Cursor's summary sentence", () => {
    expect(reportedCommitShas('Shipped `stellar_warp.py` and committed it (`74d04c6`).')).toEqual(['74d04c6']);
  });

  it('accepts git’s banner form regardless of wording — it is output, not prose', () => {
    expect(reportedCommitShas('[main 73df467] add thing')).toEqual(['73df467']);
  });

  it('ignores hex tokens in sentences that are not about committing', () => {
    // Session IDs are 8 hex chars, exactly like a short sha, and agents quote
    // them constantly. This sentence is what a chatty turn looks like.
    expect(reportedCommitShas('Session `7ff68eb7` showed the bug; see run aaf24b52 for the trace.')).toEqual([]);
  });

  it('ignores prose numbers and hex-only English near a commit word', () => {
    // "1000000" is all digits, "defaced" is all hex letters — both would match a
    // naive [0-9a-f]{7,} and neither is a sha.
    expect(reportedCommitShas('The commit ran 1000000 iterations over the defaced rows.')).toEqual([]);
  });

  it('takes only the sha in the commit sentence, not one from a neighbouring sentence', () => {
    const out = reportedCommitShas('I read `abc1234` from the log. Then I committed `74d04c6`.');
    expect(out).toEqual(['74d04c6']);
  });
});

describe('extractPromptFileMappings — reported commit shas', () => {
  it('attaches the sha to the turn that ran git commit', () => {
    const f = write([
      user('add stellar_warp.py and commit it'),
      assistant([text('On it.'), shell('git add stellar_warp.py; git commit -m "add stellar_warp.py"')]),
      // Cursor puts the summary in a LATER assistant entry than the commit call,
      // so collection cannot be gated at the moment the block is read.
      assistant([text('Shipped `stellar_warp.py` and committed it (`74d04c6`).')]),
      turnEnded(),
    ]);
    const m = extractPromptFileMappings(f, READ);
    expect(m).toHaveLength(1);
    expect(m[0].ranCommit).toBe(true);
    expect(m[0].commitShas).toEqual(['74d04c6']);
  });

  it('claims nothing when the turn never ran git commit', () => {
    // The strongest guard: quoting a sha is not making one. Without this a turn
    // that merely explained a commit would be paired to it.
    const f = write([
      user('what did the last commit change?'),
      assistant([shell('git log -1'), text('The last commit was `74d04c6`, which added the visualizer.')]),
      turnEnded(),
    ]);
    const m = extractPromptFileMappings(f, READ);
    expect(m[0].ranCommit).toBeFalsy();
    expect(m[0].commitShas).toBeUndefined();
  });

  it('is opt-in — transcripts that carry real tool output never consult prose', () => {
    const f = write([
      user('ship it'),
      assistant([shell('git commit -m "ship"'), text('Committed as `74d04c6`.')]),
      turnEnded(),
    ]);
    expect(extractPromptFileMappings(f)[0].commitShas).toBeUndefined();
    expect(extractPromptFileMappings(f, READ)[0].commitShas).toEqual(['74d04c6']);
  });

  it('gives each queued prompt its own sha', () => {
    // Cursor writes a queued prompt BEFORE the running turn's tool calls, which
    // is what made bucketing off-by-one in the first place. Two committing turns
    // must not collapse onto one.
    const f = write([
      user('add a file and commit'),
      user('add another and commit'),
      assistant([shell('git commit -m one'), text('Committed `1111aaa`.')]),
      turnEnded(),
      assistant([shell('git commit -m two'), text('Committed `2222bbb`.')]),
      turnEnded(),
    ]);
    const m = extractPromptFileMappings(f, READ);
    expect(m.map((x) => x.commitShas)).toEqual([['1111aaa'], ['2222bbb']]);
  });

  it('keeps a turn that committed but reported no sha usable via ranCommit', () => {
    // No downgrade: the existing order-based pairing still has its signal.
    const f = write([
      user('commit it'),
      assistant([shell('git commit -m x'), text('Done.')]),
      turnEnded(),
    ]);
    const m = extractPromptFileMappings(f, READ);
    expect(m[0].ranCommit).toBe(true);
    expect(m[0].commitShas).toBeUndefined();
  });
});
