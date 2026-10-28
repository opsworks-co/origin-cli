// End to end, through the built binary: session 588bb84a, 2026-10-20.
//
// One turn edited one file twice through the shell, and the macOS watcher
// dropped the second write, so the journal's last copy of the file was the
// first one. The turn committed, stopped and the session ended. Every upload
// carried the commit patch (+53/-8), but the LOCAL saved row — the one the
// release gate grades — kept the ledger's stale rendering (+51/-8) beside
// `commitPatch: true`, and the gate blocked a release on a finding the server
// never had.
//
// Two things were wrong, and this test needs both fixed:
//  - session-end's ledger pass rewrote the SAVED row object in place (the
//    merge hands it the saved object for a shell-only turn) and the passes
//    after it worked on a copy, so the saved row kept the ledger's text;
//  - the ledger trusted a journal copy that was not the file's content at the
//    end of the turn.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitFiles, createHarness, haveDist, numbered, sleep, waitFor } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const FILE = 'src/codex.py';
const SESSION = 'e2e-missed-w-0001';

// Longer than the 1000 characters a saved row keeps of its prompt: that is
// what made session-end copy the row it sent and leave the saved one behind.
const PROMPT = 'Give Codex model calls a start and a duration. ' + 'Context: '.repeat(130);

function journalPath(): string | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION.slice(0, 12)));
  return j ? path.join(dir, j) : null;
}

const recordsFor = (text: string, file: string) => text.split('\n').filter((l) => l.includes(`"f":${JSON.stringify(file)}`));

/** Take the file's newest write out of the journal: the event FSEvents dropped. */
function dropLastWrite(file: string): void {
  const p = journalPath()!;
  const lines = fs.readFileSync(p, 'utf-8').split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (l.includes(`"f":${JSON.stringify(file)}`)) last = i; });
  lines.splice(last, 1);
  fs.writeFileSync(p, lines.join('\n'));
}

function archivedState(): any {
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  const f = fs.readdirSync(dir).find((n) => n.startsWith(SESSION.slice(0, 12)) && n.endsWith('.json'));
  expect(f, 'session end archived no state').toBeTruthy();
  return JSON.parse(fs.readFileSync(path.join(dir, f!), 'utf-8'));
}

describe.skipIf(!haveDist)('a write the journal missed, then commit, Stop and session end', () => {
  it('saves the local row it uploaded, and the turn measures the file as it ended', async () => {
    const h = await createHarness(SESSION, 'e2e-missed-w-srv-1');
    try {
      const base = numbered('base', 30);
      commitFiles(h, { [FILE]: base }, 'base');
      await h.startSession(PROMPT);

      // Two shell writes to the same file, the second one missed by the watcher.
      const first = base + numbered('first', 3);
      const second = first.replace('base_5 = 5\n', 'base_5 = 50\n') + numbered('second', 2);
      await h.agentRuns('s-1', `python3 - <<'EOF'\n# first edit of ${FILE}\nEOF`, () => {
        fs.writeFileSync(path.join(h.repo, FILE), first);
      });
      await waitFor(() => recordsFor(h.journalText(), FILE).length >= 1, 10_000, 'the first write to be journaled');
      await sleep(600);
      await h.agentRuns('s-2', `python3 - <<'EOF'\n# second edit of ${FILE}\nEOF`, () => {
        fs.writeFileSync(path.join(h.repo, FILE), second);
      });
      await waitFor(() => recordsFor(h.journalText(), FILE).length >= 2, 10_000, 'the second write to be journaled');
      await sleep(800);
      dropLastWrite(FILE);
      expect(recordsFor(h.journalText(), FILE)).toHaveLength(1);

      let postCommit: Promise<{ code: number | null; stderr: string }> | null = null;
      await h.agentRuns('s-3', `git add ${FILE} && git commit -qm 'codex calls get a duration'`, () => {
        h.git(['add', FILE]);
        h.git(['commit', '-q', '--no-verify', '-m', 'codex calls get a duration']);
        postCommit = h.gitHook('git-post-commit');
      });
      const pc = await postCommit!;
      expect(pc.code, pc.stderr).toBe(0);
      const numstat = h.git(['diff', '--numstat', 'HEAD~1', 'HEAD', '--', FILE]).split(/\s+/);
      const commitLines = [Number(numstat[0]), Number(numstat[1])];
      expect(commitLines).toEqual([6, 1]);

      h.reply('Done: calls carry a start and a duration.');
      await h.stop();
      // 588bb84a was a background run (`origin issue start --background`),
      // whose SessionEnd is the real end rather than one more Stop.
      process.env.ORIGIN_HEADLESS_RUN = '1';
      let end: { code: number | null; stderr: string };
      try {
        end = await h.run('session-end', { reason: 'prompt_input_exit' });
      } finally {
        delete process.env.ORIGIN_HEADLESS_RUN;
      }
      expect(end.code, end.stderr).toBe(0);
      expect(h.hooksLog()).toContain('calling api.endSession');

      // What went up: the turn's last row on the wire.
      const sent = h.rows().find((r: any) => r.promptIndex === 0);
      expect(sent, 'no row for the turn reached the API').toBeTruthy();
      expect([sent.linesAdded, sent.linesRemoved]).toEqual(commitLines);

      // What was kept: the row the release gate reads.
      const saved = (archivedState().completedPromptMappings || []).find((m: any) => m.promptIndex === 0);
      expect(saved, 'no saved row for the turn').toBeTruthy();
      expect([saved.linesAdded, saved.linesRemoved], 'saved row counts').toEqual(commitLines);
      expect(saved.diff, 'saved row diff is not the one uploaded').toBe(sent.diff);
      expect(saved.diff).toContain('+second_1 = 1');
      // …and the ledger itself noticed, so an uncommitted turn is right too.
      expect(h.hooksLog()).toContain('journal missed a write: after-state taken from the turn end');
    } finally {
      await h.close();
    }
  }, T);
});
