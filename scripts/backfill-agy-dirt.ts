/**
 * Backfill: retroactively strip concurrent-agent dirt from PAST Antigravity
 * sessions.
 *
 * Before PR #1001, a read-only agy turn (seen only by the watcher, which can't
 * refresh the per-prompt baseline) diffed a STALE shadow against the live tree —
 * so an untracked file a DIFFERENT agent created in the shared working tree got
 * attributed to this session's turn. #1001 fixes capture going forward; this
 * cleans the back-catalog.
 *
 * The "what did THIS conversation actually edit" signal lives only in the local
 * Antigravity transcript (its tool_calls), so this MUST run on a machine that has
 * those transcripts. It:
 *   1. enumerates local agy transcripts (~/.gemini/antigravity/brain/<cid>/…),
 *   2. lists the org's agy sessions from the server and matches by agentSessionId,
 *   3. re-scopes every prompt to the session's transcript-edited files
 *      (computeAgySessionCorrections), and
 *   4. sends authoritative per-prompt corrections for the prompts that shed a file.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write. Never zeroes a prompt when the
 * transcript recorded no edits (a parser miss is treated as "unknown", left as-is).
 *
 *   npx tsx packages/cli/scripts/backfill-agy-dirt.ts            # dry-run
 *   npx tsx packages/cli/scripts/backfill-agy-dirt.ts --apply    # write
 *   npx tsx packages/cli/scripts/backfill-agy-dirt.ts --limit 50 # cap sessions scanned
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { api } from '../src/api.js';
import { parseAntigravityTranscript } from '../src/antigravity-transcript.js';
import { deriveAgyRepoPath, computeAgySessionCorrections } from '../src/commands/hooks.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) || Infinity : Infinity;

// Map every local agy conversation id → its transcript path.
function localAgyTranscripts(): Map<string, string> {
  const brain = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const out = new Map<string, string>();
  let cids: string[] = [];
  try { cids = fs.readdirSync(brain); } catch { return out; }
  for (const cid of cids) {
    const p = path.join(brain, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (fs.existsSync(p)) out.set(cid, p);
  }
  return out;
}

// Page through the org's sessions (both live and archived), keeping only
// Antigravity ones. The list endpoint defaults to archived:false, so an archived
// session with a historical leak would be missed unless we scan both.
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
  console.log(`\nAntigravity dirt backfill — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);
  const transcripts = localAgyTranscripts();
  console.log(`Local agy transcripts found: ${transcripts.size}`);

  const sessions = await listAgySessions();
  console.log(`Antigravity sessions in org (live + archived): ${sessions.length}`);
  const matchedCids = new Set(sessions.map((s) => s.agentSessionId).filter(Boolean) as string[]);
  const unmatched = [...transcripts.keys()].filter((c) => !matchedCids.has(c));
  console.log(`Local transcripts with NO session in this org (other org / unsynced): ${unmatched.length}\n`);

  let scanned = 0, noTranscript = 0, cleaned = 0, promptsFixed = 0, filesDropped = 0, errors = 0;

  for (const sess of sessions) {
    if (scanned >= LIMIT) break;
    const cid = sess.agentSessionId;
    const tPath = cid ? transcripts.get(cid) : undefined;
    if (!cid || !tPath) { noTranscript++; continue; }
    scanned++;
    try {
      const parsed = parseAntigravityTranscript(fs.readFileSync(tPath, 'utf-8'));
      if (parsed.filesEdited.length === 0) continue; // no edit signal → leave as-is
      const repoPath = deriveAgyRepoPath(parsed.filePaths, undefined, process.cwd());
      const detail = (await api.getSession(sess.id)) as any;
      const corrections = computeAgySessionCorrections(detail.promptChanges || [], parsed.filesEdited, repoPath);
      if (corrections.length === 0) continue;

      cleaned++;
      const droppedAll = [...new Set(corrections.flatMap((c) => c.dropped))];
      promptsFixed += corrections.length;
      filesDropped += droppedAll.length;
      console.log(`session ${sess.id.slice(0, 8)} (cid ${cid.slice(0, 8)}): ${corrections.length} prompt(s), drop [${droppedAll.join(', ')}]`);
      for (const c of corrections) console.log(`    prompt ${c.promptIndex}: → files=[${c.filesChanged.join(', ')}] +${c.linesAdded} (dropped ${c.dropped.join(', ')})`);

      if (APPLY) {
        // Strip the report-only `dropped` field before sending.
        const promptChanges = corrections.map(({ dropped, ...pc }) => pc);
        await api.updateSession(sess.id, { promptChanges });
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
  console.log(`sessions needing correction: ${cleaned}`);
  console.log(`prompts corrected: ${promptsFixed}`);
  console.log(`distinct foreign files dropped: ${filesDropped}`);
  console.log(`errors: ${errors}`);
  console.log(APPLY ? `\nDONE — changes written.` : `\nDRY-RUN — re-run with --apply to write.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
