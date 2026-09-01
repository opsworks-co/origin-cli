/**
 * Backfill: repair Antigravity turns captured as EMPTY because agy ran in its
 * OWN git worktree.
 *
 * Before PR #1226, the agy handler collapsed the worktree
 * (~/.gemini/antigravity/worktrees/<project>/<branch>) to the canonical repo and
 * used that one path as the cwd for git capture too. So the baseline shadow and
 * the working-tree snapshot both came from the MAIN checkout — a tree that never
 * saw the edit — and the delta was empty. A turn that created a file stored
 * 0 files / +0 −0.
 *
 * Nothing on the read side can heal that: the diff was never taken. But agy's
 * transcript records edits WITH their content (write_to_file → CodeContent,
 * replace_file_content → TargetContent/ReplacementContent), so each empty turn
 * can be reconstructed from those records — the same ones the live path feeds to
 * buildDiffFromEdits. That signal lives only in the LOCAL transcript, so this
 * MUST run on a machine that has them.
 *
 * FILL-ONLY. A prompt is rewritten only when its stored capture is empty AND the
 * transcript recorded edits for it, so a good row is never degraded and a prompt
 * with no records is left alone rather than zeroed. Idempotent: a second run
 * finds the repaired prompts non-empty and skips them.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 *
 *   npx tsx packages/cli/scripts/backfill-agy-empty-turns.ts            # dry-run
 *   npx tsx packages/cli/scripts/backfill-agy-empty-turns.ts --apply    # write
 *   npx tsx packages/cli/scripts/backfill-agy-empty-turns.ts --limit 50
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { api } from '../src/api.js';
import { parseAntigravityTranscript } from '../src/antigravity-transcript.js';
import { deriveAgyRoots, computeAgyEmptyTurnRepairs } from '../src/commands/hooks.js';

/**
 * Best-effort recovery of the branch a worktree session actually ran on.
 *
 * The stored branch is the MAIN checkout's — capture read it from the wrong
 * directory, which is the same root cause and the visible tell. Two sources,
 * in order of strength:
 *   1. the worktree's CURRENT branch, when the worktree still exists (git truth,
 *      though it can have moved since the session ran), and
 *   2. the worktree DIRECTORY NAME — agy lays worktrees out as
 *      <project>/<branch>, so the basename is the branch at creation time.
 * When both are available and agree, that is a strong signal. Returns null
 * rather than guessing when neither is available.
 */
function recoverWorktreeBranch(workRoot: string): { branch: string; source: string } | null {
  let live: string | null = null;
  try {
    live = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000,
    }).trim() || null;
  } catch { live = null; }
  const basename = path.basename(workRoot) || null;
  if (live && basename && live === basename) return { branch: live, source: 'worktree HEAD == dir name' };
  if (live) return { branch: live, source: 'worktree HEAD' };
  if (basename) return { branch: basename, source: 'worktree dir name (worktree gone)' };
  return null;
}

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) || Infinity : Infinity;

// Map every local agy conversation id → its transcript path.
function localAgyTranscripts(): Map<string, string> {
  const out = new Map<string, string>();
  // Current builds write to ~/.gemini/antigravity/brain; older ones to
  // ~/.gemini/antigravity-cli/brain. Scan both, first match wins.
  for (const brain of [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  ]) {
    let cids: string[] = [];
    try { cids = fs.readdirSync(brain); } catch { continue; }
    for (const cid of cids) {
      if (out.has(cid)) continue;
      const p = path.join(brain, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (fs.existsSync(p)) out.set(cid, p);
    }
  }
  return out;
}

// Page through the org's agy sessions, live AND archived — an empty-looking
// session is exactly the kind the empty-session sweep archives, so scanning only
// live rows would miss the worst-hit ones.
async function listAgySessions(): Promise<Array<{ id: string; agentSessionId: string | null }>> {
  const agy: Array<{ id: string; agentSessionId: string | null }> = [];
  const pageSize = 200;
  for (const archived of ['false', 'true']) {
    let offset = 0;
    for (;;) {
      const page = (await api.getSessions({ limit: String(pageSize), offset: String(offset), archived })) as any;
      const rows: any[] = Array.isArray(page) ? page : (page?.sessions || page?.data || []);
      if (!rows.length) break;
      for (const s of rows) if ((s.agentSlug || s.agent?.slug) === 'antigravity') agy.push({ id: s.id, agentSessionId: s.agentSessionId || null });
      if (rows.length < pageSize) break;
      offset += pageSize;
      if (offset > 10000) break; // safety backstop
    }
  }
  return agy;
}

async function main() {
  console.log(`\nAntigravity empty-turn backfill — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);
  const transcripts = localAgyTranscripts();
  console.log(`Local agy transcripts found: ${transcripts.size}`);

  const sessions = await listAgySessions();
  console.log(`Antigravity sessions in org (live + archived): ${sessions.length}\n`);

  let scanned = 0, noTranscript = 0, repairedSessions = 0, repairedPrompts = 0;
  let worktreeSessions = 0, linesRecovered = 0, errors = 0, toolsFixed = 0, branchesFixed = 0;

  for (const sess of sessions) {
    if (scanned >= LIMIT) break;
    const cid = sess.agentSessionId;
    const tPath = cid ? transcripts.get(cid) : undefined;
    if (!cid || !tPath) { noTranscript++; continue; }
    scanned++;
    try {
      const parsed = parseAntigravityTranscript(fs.readFileSync(tPath, 'utf-8'));
      if (parsed.filesEdited.length === 0) continue; // no edit signal → leave as-is
      const { repoPath, workRoot } = deriveAgyRoots(parsed.filePaths, undefined, process.cwd());
      if (!workRoot) continue;
      const isWorktree = !!repoPath && workRoot !== repoPath;
      if (isWorktree) worktreeSessions++;

      const detail = (await api.getSession(sess.id)) as any;
      const repairs = computeAgyEmptyTurnRepairs(detail.promptChanges || [], parsed.promptEditRecords, workRoot);

      // Tool counts were never sent by the pre-#1226 agy path at all, so a
      // session detail read "0 tools" for turns that plainly ran several. The
      // transcript has them. Only ever raise the count — never write a 0 over a
      // real one.
      const toolFix = (parsed.toolCalls > (detail.toolCalls || 0))
        ? { toolCalls: parsed.toolCalls, toolBreakdown: parsed.toolBreakdown }
        : null;

      // The branch label, for worktree sessions only — see recoverWorktreeBranch.
      let branchFix: { branch: string; source: string } | null = null;
      if (isWorktree) {
        const rec = recoverWorktreeBranch(workRoot);
        if (rec && rec.branch !== detail.branch) branchFix = rec;
      }

      if (repairs.length === 0 && !toolFix && !branchFix) continue;

      repairedSessions++;
      repairedPrompts += repairs.length;
      linesRecovered += repairs.reduce((n, r) => n + r.linesAdded, 0);
      if (toolFix) toolsFixed++;
      if (branchFix) branchesFixed++;
      console.log(`session ${sess.id.slice(0, 8)} (cid ${cid.slice(0, 8)})${isWorktree ? ' [worktree]' : ''}: ${repairs.length} empty turn(s)`);
      console.log(`    workRoot ${workRoot}`);
      for (const r of repairs) {
        console.log(`    prompt ${r.promptIndex}: → files=[${r.filesChanged.join(', ')}] +${r.linesAdded}/-${r.linesRemoved}`);
      }
      if (toolFix) console.log(`    tools: ${detail.toolCalls || 0} → ${toolFix.toolCalls} [${toolFix.toolBreakdown.map((t: any) => `${t.name}×${t.count}`).join(' ')}]`);
      if (branchFix) console.log(`    branch: ${detail.branch || '(none)'} → ${branchFix.branch}  (${branchFix.source})`);

      if (APPLY) {
        await api.updateSession(sess.id, {
          ...(repairs.length > 0 ? { promptChanges: repairs } : {}),
          ...(toolFix || {}),
          ...(branchFix ? { branch: branchFix.branch } : {}),
        } as any);
        console.log(`    ✓ applied`);
      }
    } catch (e: any) {
      errors++;
      console.log(`session ${sess.id.slice(0, 8)}: ERROR ${e?.message}`);
    }
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`scanned (with transcript): ${scanned}`);
  console.log(`skipped (no local transcript): ${noTranscript}`);
  console.log(`of those, agy-worktree sessions: ${worktreeSessions}`);
  console.log(`sessions needing any repair: ${repairedSessions}`);
  console.log(`prompts repaired: ${repairedPrompts}`);
  console.log(`lines recovered: +${linesRecovered}`);
  console.log(`tool counts backfilled: ${toolsFixed}`);
  console.log(`branch labels corrected: ${branchesFixed}`);
  console.log(`errors: ${errors}`);
  console.log(APPLY ? `\nDONE — changes written.` : `\nDRY-RUN — re-run with --apply to write.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
