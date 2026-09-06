// Stage 4: a brand-new agent captures correctly with NO file-parsing code.
//
// This is the claim the whole rewrite is for, so it is asserted rather than
// stated. `FutureAgent` below is an agent nobody has written a parser for. Its
// adapter supplies only what an adapter alone can know:
//
//   • where its transcripts live   (listActive)
//   • what the user said           (userPrompts / promptTimestamps)
//   • which session this is        (slug, agentSlugForServer)
//
// It supplies NO filesChanged, NO promptDiffs, NO filePaths. Before stage 4
// those three were REQUIRED by `ParsedSession`, so a new agent could not be
// captured at all until someone taught Origin to read its transcript format —
// ~7,900 lines of per-agent parsing on the critical path, each with its own
// blind spots (editsJson never sees a shell write; a whole-file record reports
// a one-line append as +401).
//
// The write-journal ledger observes content at the FILESYSTEM, so it needs
// nothing from the agent and is exact for a format nobody has parsed yet. This
// test drives the REAL watcher against a REAL directory and checks that the
// per-turn diffs are right and survive `origin verify-capture`.
//
// If this file stops compiling because `ParsedSession` demands file truth
// again, that is the regression: the critical path grew an agent-specific
// dependency back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TranscriptAdapter, ParsedSession, ScannedTranscript } from '../transcript-adapters.js';
import {
  startWriteJournal, markTurn, readJournalEntries, journalPathsForTag, DEBOUNCE_MS,
} from '../write-journal-watch.js';
import { applyLedgerToMappings } from '../capture-from-ledger.js';
import { verifyTurn, parseUnifiedDiff } from '../capture-verify.js';

let tmp = '';
beforeAll(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-day1-'))); });
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ─── an agent Origin has never heard of ─────────────────────────────────────

/**
 * The entire adapter for a new agent, after stage 4.
 *
 * Typed as `TranscriptAdapter` on purpose: if the contract ever requires file
 * or line truth again, THIS LINE fails to compile, which is the point.
 */
const futureAgent: TranscriptAdapter = {
  slug: 'future-agent',
  agentSlugForServer: 'future-agent',

  listActive(): ScannedTranscript[] {
    const file = path.join(tmp, 'future-agent', 'session-1.jsonl');
    if (!fs.existsSync(file)) return [];
    return [{
      sessionId: 'fa-session-1',
      transcriptPath: file,
      mtimeMs: fs.statSync(file).mtimeMs,
      cwd: path.join(tmp, 'repo'),
    }];
  },

  parse(transcriptPath: string): ParsedSession | null {
    let raw = '';
    try { raw = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { role: string; text: string; at: number });
    const prompts = rows.filter((r) => r.role === 'user');
    return {
      userPrompts: prompts.map((r) => r.text),
      promptTimestamps: prompts.map((r) => r.at),
      transcript: raw,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      // No filesChanged. No promptDiffs. No filePaths. The ledger has them.
    };
  },
};

// ─── the harness ────────────────────────────────────────────────────────────

const waitFor = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const pastDebounce = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

describe('a new agent with no file-parsing code', () => {
  it('its adapter compiles while supplying only prompts and discovery', () => {
    // The compile-time half of the claim. The runtime half is below.
    const parsed = futureAgent.parse(writeTranscript(['first', 'second']))!;
    expect(parsed.userPrompts).toEqual(['first', 'second']);
    expect(parsed.filesChanged).toBeUndefined();
    expect(parsed.promptDiffs).toBeUndefined();
    expect(parsed.filePaths).toBeUndefined();
  });

  /** Write a transcript in this agent's own invented format. */
  function writeTranscript(prompts: string[]): string {
    const dir = path.join(tmp, 'future-agent');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session-1.jsonl');
    fs.writeFileSync(file, prompts.map((p, i) => JSON.stringify({ role: 'user', text: p, at: 1000 + i })).join('\n') + '\n');
    return file;
  }

  it('discovers its own session', () => {
    writeTranscript(['hello']);
    const found = futureAgent.listActive(Date.now());
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('fa-session-1');
  });

  it('gets exact per-turn diffs from the ledger alone', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const tag = 'future-agent-day1';
    const { journalPath, snapshotDir } = journalPathsForTag(tag);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, '');

    const watcher = startWriteJournal(repo, journalPath, { snapshotDir });
    if (!watcher) return; // no recursive watch on this platform
    try {
      const writesIn = () => readJournalEntries(journalPath).filter((e) => e.kind === 'write').length;
      // FSEvents does not deliver events for writes that land before it finishes
      // arming — those are MISSED, not late — so prove it is live first.
      const probe = path.join(repo, '.probe');
      for (let i = 0; i < 200 && writesIn() === 0; i++) {
        fs.writeFileSync(probe, String(i));
        await new Promise((r) => setTimeout(r, 25));
      }
      fs.unlinkSync(probe);
      await pastDebounce();
      fs.writeFileSync(journalPath, '');

      const app = path.join(repo, 'app.py');

      markTurn(journalPath, 'fa_turn_1');
      fs.writeFileSync(app, 'def main():\n    pass\n');
      await waitFor(() => writesIn() >= 1);
      await pastDebounce();

      markTurn(journalPath, 'fa_turn_2');
      fs.writeFileSync(app, 'def main():\n    print("hi")\n');
      await waitFor(() => writesIn() >= 2);

      // The producer builds mappings from PROMPTS only — everything the
      // adapter knows. It has no file list and no diff to offer.
      const parsed = futureAgent.parse(writeTranscript(['write main', 'make it print']))!;
      const mappings = parsed.userPrompts.map((_p, i) => ({ promptIndex: i }));

      const replaced = applyLedgerToMappings(
        { writeJournalPath: journalPath, writeSnapshotDir: snapshotDir, promptTurnIds: ['fa_turn_1', 'fa_turn_2'] },
        mappings as never,
        { readEntries: readJournalEntries },
      );
      expect(replaced, 'the ledger should have answered for both turns').toBe(2);

      const m = mappings as unknown as Array<Record<string, unknown>>;

      // Turn 1 created the file.
      expect(m[0].filesChanged).toEqual(['app.py']);
      expect(m[0].linesAdded).toBe(2);
      expect(parseUnifiedDiff(m[0].diff as string).files[0].isNew).toBe(true);

      // Turn 2 shows ONLY its own change — turn 1's line is context, not credit.
      expect(m[1].filesChanged).toEqual(['app.py']);
      expect(m[1].diff).toContain('+    print("hi")');
      expect(m[1].diff).not.toContain('+def main():');
      expect(m[1].linesAdded).toBe(1);
      expect(m[1].linesRemoved).toBe(1);

      // And both rows survive the stage 0 gate.
      for (const row of m) {
        expect(verifyTurn({
          promptIndex: row.promptIndex as number,
          filesChanged: row.filesChanged as string[],
          diff: row.diff as string,
          linesAdded: row.linesAdded as number,
          linesRemoved: row.linesRemoved as number,
        }), `turn ${row.promptIndex} contradicts itself`).toEqual([]);
        expect(row.diffSource).toBe('ledger');
      }
    } finally {
      watcher.stop();
    }
  });

  it('captures a SHELL write, which no transcript parser would have seen', async () => {
    // The blind spot every adapter shares: a heredoc or `sed -i` produces no
    // tool call, so editsJson is empty and the turn reads as chat-only. The
    // ledger watches the filesystem, so it does not care how the write happened.
    const repo = path.join(tmp, 'repo-shell');
    fs.mkdirSync(repo, { recursive: true });
    const { journalPath, snapshotDir } = journalPathsForTag('future-agent-shell');
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, '');

    const watcher = startWriteJournal(repo, journalPath, { snapshotDir });
    if (!watcher) return;
    try {
      const writesIn = () => readJournalEntries(journalPath).filter((e) => e.kind === 'write').length;
      const probe = path.join(repo, '.probe');
      for (let i = 0; i < 200 && writesIn() === 0; i++) {
        fs.writeFileSync(probe, String(i));
        await new Promise((r) => setTimeout(r, 25));
      }
      fs.unlinkSync(probe);
      await pastDebounce();
      fs.writeFileSync(journalPath, '');

      markTurn(journalPath, 'fa_shell');
      // Stands in for `cat > notes.md <<'EOF'` — a write with no tool call.
      fs.appendFileSync(path.join(repo, 'notes.md'), '# notes\nwritten by a shell\n');
      await waitFor(() => writesIn() >= 1);

      const mapping: Record<string, unknown> = { promptIndex: 0 };
      applyLedgerToMappings(
        { writeJournalPath: journalPath, writeSnapshotDir: snapshotDir, promptTurnIds: ['fa_shell'] },
        [mapping as never],
        { readEntries: readJournalEntries },
      );
      expect(mapping.filesChanged).toEqual(['notes.md']);
      expect(mapping.linesAdded).toBe(2);
      expect(verifyTurn({
        promptIndex: 0,
        filesChanged: mapping.filesChanged as string[],
        diff: mapping.diff as string,
        linesAdded: mapping.linesAdded as number,
        linesRemoved: mapping.linesRemoved as number,
      })).toEqual([]);
    } finally {
      watcher.stop();
    }
  });
});
