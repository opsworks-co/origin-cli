import chalk from 'chalk';
import path from 'path';
import { getGitRoot } from '../session-state.js';
import { getLineBlame, LineAttribution } from '../attribution.js';
import { isConnectedMode, loadConfig } from '../config.js';
import { git, gitOrNull, runDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── origin why <file>:<line> ────────────────────────────────────────────
// Tells you WHY a specific line exists — which AI session and prompt wrote it.

function parseFileAndLine(input: string): { file: string; line?: number } {
  // Support: file.ts:42, file.ts 42, file.ts
  const colonMatch = input.match(/^(.+):(\d+)$/);
  if (colonMatch) return { file: colonMatch[1], line: parseInt(colonMatch[2], 10) };
  return { file: input };
}

function readOriginNote(repoPath: string, sha: string): any | null {
  if (!HEX.test(sha)) return null;
  const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], { cwd: repoPath });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return parsed.origin || parsed;
  } catch {
    return null;
  }
}

function getCommitForLine(repoPath: string, filePath: string, lineNum: number): string | null {
  if (!Number.isInteger(lineNum) || lineNum < 1) return null;
  try {
    const output = git(
      ['blame', '-L', `${lineNum},${lineNum}`, '--porcelain', '--', filePath],
      { cwd: repoPath }
    ).trim();
    const match = output.match(/^([0-9a-f]{40})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// The commits that changed this specific line over time, newest→oldest, via
// `git log -L`. Used by drift recovery to find the INTRODUCING commit when the
// current-blame commit only reformatted/moved the line. Capped so a line with
// deep history doesn't fan out into dozens of server calls.
function getLineHistoryCommits(repoPath: string, filePath: string, lineNum: number): string[] {
  if (!Number.isInteger(lineNum) || lineNum < 1) return [];
  try {
    const out = git(
      ['log', '-L', `${lineNum},${lineNum}:${filePath}`, '--format=%H', '-s', '--max-count=6'],
      { cwd: repoPath },
    );
    const shas: string[] = [];
    const seen = new Set<string>();
    for (const l of out.split('\n')) {
      const s = l.trim();
      if (/^[0-9a-f]{40}$/.test(s) && !seen.has(s)) { seen.add(s); shas.push(s); }
    }
    return shas;
  } catch {
    return [];
  }
}

function getCommitInfo(repoPath: string, sha: string): { date: string; author: string; message: string } | null {
  if (!HEX.test(sha)) return null;
  try {
    const info = git(
      ['log', '-1', '--format=%aI|%an|%s', sha],
      { cwd: repoPath }
    ).trim();
    const [date, author, ...msgParts] = info.split('|');
    return { date, author, message: msgParts.join('|') };
  } catch {
    return null;
  }
}

async function showLineWhy(repoPath: string, filePath: string, lineNum: number): Promise<void> {
  const relPath = path.relative(repoPath, path.resolve(process.cwd(), filePath));

  // Get file content for display
  const fullPath = path.resolve(repoPath, relPath);
  let lineContent = '';
  try {
    const { readFileSync } = await import('fs');
    const lines = readFileSync(fullPath, 'utf-8').split('\n');
    lineContent = lines[lineNum - 1] || '';
  } catch { /* ignore */ }

  console.log(chalk.bold(`\n  Line ${lineNum} in ${relPath}`));
  if (lineContent) {
    console.log(chalk.gray(`  ${lineContent.trimStart()}`));
  }
  console.log('');

  // Step 1: git blame to find commit SHA
  const commitSha = getCommitForLine(repoPath, relPath, lineNum);
  if (!commitSha || commitSha.startsWith('0000000')) {
    console.log(chalk.yellow('  Uncommitted change — not yet attributed.\n'));
    return;
  }

  // Server-first: Origin's attribution engine resolves session + prompt from
  // the commit SHA directly (DB-side), so it works even when git notes aren't
  // present locally — a fresh clone, squashed/rebased history, or notes the
  // client never fetched. This is the robust path; the git-notes logic below
  // stays as the offline/standalone fallback.
  if (isConnectedMode()) {
    let card = await tryServerWhy(repoPath, relPath, commitSha, lineContent);
    // Drift recovery: `git blame` credits whoever LAST touched the line, which
    // may be a later reformat/rename, not the turn that INTRODUCED it. When the
    // blame commit gives a weak match, walk the line's own history (git log -L)
    // to older commits and prefer the one whose session authored this exact line
    // (confidence: high). Marks the card `drifted` so the reader knows the line
    // moved since it was written.
    if (!card || card.session == null || card.confidence !== 'high') {
      for (const sha of getLineHistoryCommits(repoPath, relPath, lineNum)) {
        if (sha === commitSha) continue;
        const alt = await tryServerWhy(repoPath, relPath, sha, lineContent);
        if (alt && alt.session) {
          alt.drifted = true;
          if (alt.confidence === 'high') { card = alt; break; }
          if (!card || card.session == null) card = alt; // first attributable fallback
        }
      }
    }
    if (card && card.session) { renderServerCard(card, relPath, lineNum, lineContent); return; }
  }

  // Step 2: get commit info
  const commitInfo = getCommitInfo(repoPath, commitSha);
  const dateStr = commitInfo?.date
    ? new Date(commitInfo.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  // Step 3: check git notes for Origin session
  const note = readOriginNote(repoPath, commitSha);

  if (!note?.sessionId) {
    // Human-written or Origin wasn't tracking
    console.log(chalk.white(`  Written by ${chalk.cyan(commitInfo?.author || 'unknown')} · ${dateStr}`));
    console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
    console.log(chalk.gray('\n  No Origin session found for this commit.'));
    console.log(chalk.gray('  This line was committed without an active Origin session.\n'));
    return;
  }

  // AI-written line with session
  const agent = note.agent || note.model || 'AI';
  const sessionId = note.sessionId;

  console.log(chalk.white(`  Written by ${chalk.cyan(agent)} · ${dateStr} · Session ${chalk.cyan(sessionId.slice(0, 8))}`));

  // Step 4: try to find which prompt in the session wrote this line
  // First try platform API
  if (isConnectedMode()) {
    try {
      const { api } = await import('../api.js');
      const session = await api.getSession(sessionId) as any;

      if (session?.promptChanges?.length) {
        // Find which prompt's diff contains this line
        const matchingPrompt = findPromptForLine(session.promptChanges, relPath, lineNum, lineContent);

        if (matchingPrompt) {
          console.log(chalk.green(`  Prompt: "${matchingPrompt.promptText}"`));
          if (matchingPrompt.filesChanged?.length) {
            console.log(chalk.gray(`  Files: ${matchingPrompt.filesChanged.join(', ')}`));
          }
        } else {
          // Show the session's prompt if only one
          if (session.promptChanges.length === 1) {
            console.log(chalk.green(`  Prompt: "${session.promptChanges[0].promptText}"`));
          } else {
            console.log(chalk.gray(`  Session had ${session.promptChanges.length} prompts (couldn't determine which wrote this line)`));
          }
        }

        // Session summary
        const turns = session.promptChanges.length;
        const cost = session.costUsd ? `$${session.costUsd.toFixed(2)}` : '$0.00';
        const filesCount = (() => {
          try { return JSON.parse(session.filesChanged || '[]').length; } catch { return 0; }
        })();
        const duration = session.durationMs ? formatDuration(session.durationMs) : '—';

        console.log(chalk.gray(`\n  Session: ${turns} turn${turns === 1 ? '' : 's'} · ${cost} · ${filesCount} files · ${duration}`));
      } else if (session?.prompt) {
        console.log(chalk.green(`  Prompt: "${session.prompt}"`));
      }

      console.log(chalk.gray(`  Run ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)} for full details\n`));
      return;
    } catch {
      // Fall through to local-only display
    }
  }

  // Local-only: show what we know from git notes
  if (note.promptSummary) {
    console.log(chalk.green(`  Prompt: "${note.promptSummary}"`));
  }
  const cost = note.costUsd ? `$${note.costUsd.toFixed(2)}` : '';
  const tokens = note.tokensUsed ? `${(note.tokensUsed / 1000).toFixed(1)}k tokens` : '';
  const meta = [cost, tokens, note.promptCount ? `${note.promptCount} turns` : ''].filter(Boolean).join(' · ');
  if (meta) console.log(chalk.gray(`  ${meta}`));

  console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
  console.log(chalk.gray(`  Run ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)} for full details\n`));
}

function findPromptForLine(
  promptChanges: any[],
  filePath: string,
  lineNum: number,
  lineContent: string,
): any | null {
  // Walk prompts in reverse (later prompts override earlier ones)
  for (let i = promptChanges.length - 1; i >= 0; i--) {
    const pc = promptChanges[i];
    const files: string[] = Array.isArray(pc.filesChanged) ? pc.filesChanged : [];

    // Check if this prompt touched the file
    const touchesFile = files.some((f: string) => {
      const nf = f.replace(/^\//, '');
      const nt = filePath.replace(/^\//, '');
      return nf === nt || nf.endsWith(nt) || nt.endsWith(nf);
    });

    if (!touchesFile) continue;

    // If we have a diff, check if it includes the line
    if (pc.diff) {
      // Look for the line content in added lines of the diff
      const trimmedContent = lineContent.trim();
      if (trimmedContent && pc.diff.includes(trimmedContent)) {
        return pc;
      }

      // Check line number in diff hunk headers
      const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
      let match;
      while ((match = hunkRegex.exec(pc.diff)) !== null) {
        const start = parseInt(match[1], 10);
        const count = match[2] ? parseInt(match[2], 10) : 1;
        if (lineNum >= start && lineNum < start + count) {
          return pc;
        }
      }
    }

    // If no diff but file matches, this is our best guess
    if (touchesFile) return pc;
  }
  return null;
}

async function showFileWhy(repoPath: string, filePath: string): Promise<void> {
  const relPath = path.relative(repoPath, path.resolve(process.cwd(), filePath));

  // Get line-level attribution
  const lines = getLineBlame(repoPath, relPath);
  if (lines.length === 0) {
    console.log(chalk.yellow(`\n  No attribution data for ${relPath}\n`));
    return;
  }

  const total = lines.length;
  const aiLines = lines.filter(l => l.authorship === 'ai').length;
  const humanLines = lines.filter(l => l.authorship === 'human').length;
  const aiPct = Math.round((aiLines / total) * 100);
  const humanPct = Math.round((humanLines / total) * 100);

  console.log(chalk.bold(`\n  ${relPath}`));
  console.log(chalk.gray(`  ${total} lines — `) +
    chalk.green(`${aiPct}% AI (${aiLines})`) +
    chalk.gray(' · ') +
    chalk.white(`${humanPct}% human (${humanLines})`));
  console.log('');

  // Group by session/agent
  const sessionMap = new Map<string, { model: string; lines: number; sessionId: string }>();
  let humanCount = 0;
  for (const line of lines) {
    if (line.authorship === 'human') {
      humanCount++;
      continue;
    }
    const key = line.sessionId || 'unknown';
    const existing = sessionMap.get(key);
    if (existing) {
      existing.lines++;
    } else {
      sessionMap.set(key, { model: line.model || line.tool || 'AI', lines: 1, sessionId: key });
    }
  }

  // Sort by line count
  const agents = [...sessionMap.values()].sort((a, b) => b.lines - a.lines);

  for (const a of agents.slice(0, 5)) {
    const pct = Math.round((a.lines / total) * 100);
    console.log(
      chalk.cyan(`  ${a.model.padEnd(20)}`) +
      chalk.green(`${String(a.lines).padStart(4)} lines  ${String(pct).padStart(3)}%`) +
      chalk.gray(`  session ${a.sessionId.slice(0, 8)}`)
    );
  }
  if (humanCount > 0) {
    const pct = Math.round((humanCount / total) * 100);
    console.log(
      chalk.white(`  ${'Human'.padEnd(20)}${String(humanCount).padStart(4)} lines  ${String(pct).padStart(3)}%`)
    );
  }

  console.log(chalk.gray(`\n  Tip: ${chalk.cyan(`origin why ${relPath}:42`)} to see which prompt wrote a specific line\n`));
}

// Map the local checkout to its Origin repo id (git remote → fullName, else
// repo basename) so we can call the server /why endpoint.
async function resolveOriginRepoId(repoPath: string): Promise<{ id: string } | null> {
  try {
    const { api } = await import('../api.js');
    const repos = (await api.getRepos()) as any[];
    const remote = gitOrNull(['remote', 'get-url', 'origin'], { cwd: repoPath }) || '';
    const fullName = (remote.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/) || [])[1] || '';
    const base = path.basename(repoPath);
    return (
      (fullName && repos.find((r: any) => r.fullName === fullName || r.name === fullName.split('/')[1])) ||
      repos.find((r: any) => r.name === base) ||
      null
    );
  } catch {
    return null;
  }
}

// Ask the server which session + prompt authored this line. Returns null on any
// failure so the caller falls back to the local git-notes path.
async function tryServerWhy(repoPath: string, relPath: string, sha: string, lineContent: string): Promise<any | null> {
  const repo = await resolveOriginRepoId(repoPath);
  if (!repo) return null;
  try {
    const { api } = await import('../api.js');
    return await api.getWhy(repo.id, { sha, file: relPath, content: lineContent });
  } catch {
    return null;
  }
}

function renderServerCard(card: any, relPath: string, lineNum: number, lineContent: string): void {
  const s = card.session || {};
  const p = card.prompt;
  const apiUrl = loadConfig()?.apiUrl || 'https://getorigin.io';
  const dateStr = s.startedAt
    ? new Date(s.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  // The caller (showLineWhy) already printed the "Line N in file" + content
  // header before choosing this path — don't repeat it.
  console.log(
    chalk.white(`  Written by ${chalk.cyan(s.agent || s.model || 'AI')}`) +
      (s.model ? chalk.gray(` · ${s.model}`) : '') +
      (dateStr ? chalk.gray(` · ${dateStr}`) : ''),
  );
  if (p) {
    console.log(chalk.green(`  Prompt #${p.index}: "${(p.text || '').replace(/\s+/g, ' ').trim()}"`));
  }
  const meta = [
    typeof s.costUsd === 'number' ? `$${s.costUsd.toFixed(2)}` : '',
    s.tokensUsed ? `${(s.tokensUsed / 1000).toFixed(1)}k tokens` : '',
    card.confidence ? `confidence: ${card.confidence}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) console.log(chalk.gray(`  ${meta}`));
  console.log(chalk.gray(`  Commit: ${String(card.sha || '').slice(0, 8)} — ${(card.message || '').split('\n')[0]}`));
  if (card.drifted) console.log(chalk.gray('  (line moved since it was written — traced to the introducing commit)'));

  // ── Accountability: markers, review, rework ──────────────────────────
  const mk = card.markers;
  if (mk) {
    for (const d of (mk.decisions || []).slice(0, 2)) console.log(chalk.cyan('  Decision: ') + chalk.gray(d));
    for (const v of (mk.verifies || []).slice(0, 2)) console.log(chalk.yellow('  Verify: ') + chalk.gray(v) + chalk.gray(' — was this checked?'));
    for (const o of (mk.opens || []).slice(0, 1)) console.log(chalk.gray('  Open: ' + o));
  }
  const rv = card.review;
  if (rv) {
    const badge =
      rv.status === 'APPROVED' ? chalk.green('reviewed ✓') :
      rv.status === 'REJECTED' ? chalk.red('rejected ✗') :
      chalk.yellow('review pending');
    const who = rv.isAutoReview ? 'AI review' : 'human';
    const risk = rv.riskLevel ? `, risk: ${rv.riskLevel}` : '';
    console.log('  ' + badge + chalk.gray(` (${who}${risk})`));
  } else {
    console.log('  ' + chalk.yellow('not reviewed'));
  }
  if (typeof card.reworkTouches === 'number' && card.reworkTouches > 1) {
    console.log(chalk.gray(`  re-touched ${card.reworkTouches}× in this session (churn)`));
  }

  console.log('');
  console.log(chalk.blue(`  ${apiUrl}${s.url || '/sessions/' + s.id}`));
  console.log(chalk.gray(`\n  Run ${chalk.cyan(`origin explain ${String(s.id || '').slice(0, 8)}`)} for full details\n`));
}

// ─── Stack-trace ingestion: `origin why --trace [file]` ──────────────────
// Parse a stack trace (stdin or a file) into file:line frames and run the same
// per-line provenance for each frame inside this repo — so a crash points at
// the prompts that authored the failing code path.

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000); // don't hang forever if no EOF
  });
}

function parseStackFrames(text: string): Array<{ file: string; line: number }> {
  const frames: Array<{ file: string; line: number }> = [];
  const seen = new Set<string>();
  const add = (file: string, lineStr: string) => {
    const line = parseInt(lineStr, 10);
    if (!file || !Number.isInteger(line) || line < 1) return;
    if (/node_modules|site-packages|\/dist\/|\.min\.js/.test(file)) return; // deps/build noise
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    frames.push({ file, line });
  };
  const patterns: RegExp[] = [
    /File\s+"([^"]+)",\s+line\s+(\d+)/g,          // Python:  File "x.py", line 47
    /\(([^\s()]+\.[A-Za-z]+):(\d+)\)/g,           // Java/JS: (Foo.java:47) / (file.ts:47)
    /at\s+[^\s(]+\s+\(?([^\s():]+):(\d+)(?::\d+)?\)?/g, // JS: at fn (file.ts:47:9)
    /([^\s():"']+\.[A-Za-z]+):(\d+)/g,            // generic: path/file.ext:47
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) add(m[1], m[2]);
  }
  return frames;
}

// Map a trace frame's path (absolute / relative / module-ish) to a repo file.
function resolveFrameFile(framePath: string, repoPath: string, repoFiles: string[]): string | null {
  const norm = framePath.replace(/^\.\//, '');
  // Exact repo-relative or suffix match against tracked files.
  const hit = repoFiles.find((f) => f === norm || norm.endsWith('/' + f) || f.endsWith('/' + norm));
  if (hit) return hit;
  // Fall back to basename (last resort; ambiguous if the name repeats).
  const base = path.basename(norm);
  const byBase = repoFiles.filter((f) => path.basename(f) === base);
  return byBase.length === 1 ? byBase[0] : null;
}

// Resolve the PR/MR number to comment on. Explicit --pr-comment <n> wins; then
// common CI env vars; then GitHub Actions' refs/pull/<n>/merge. Returns null if
// none are present — the CLI still prints the trace, just can't post it.
function resolvePrNumber(prCommentArg: string | boolean | undefined): number | null {
  if (typeof prCommentArg === 'string' && /^\d+$/.test(prCommentArg.trim())) return parseInt(prCommentArg, 10);
  const env = process.env;
  for (const v of [env.ORIGIN_PR_NUMBER, env.PR_NUMBER, env.CHANGE_ID /* Jenkins */, env.CI_MERGE_REQUEST_IID /* GitLab */]) {
    if (v && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  }
  const ref = env.GITHUB_REF || '';                 // refs/pull/123/merge
  const m = ref.match(/refs\/pull\/(\d+)\//);
  if (m) return parseInt(m[1], 10);
  return null;
}

async function whyTraceCommand(
  traceArg: string | boolean,
  repoPath: string,
  opts?: { prComment?: string | boolean; json?: boolean },
): Promise<void> {
  const { readFileSync, existsSync } = await import('fs');
  let text = '';
  if (typeof traceArg === 'string' && traceArg && existsSync(traceArg)) text = readFileSync(traceArg, 'utf-8');
  else text = await readStdin();
  if (!text.trim()) {
    console.error(chalk.red('No stack trace provided. Pipe one in:  ') + chalk.gray('cat error.log | origin why --trace'));
    process.exitCode = 1;
    return;
  }
  if (!isConnectedMode()) {
    console.error(chalk.red('Trace resolution needs a connected Origin account.'));
    process.exitCode = 1;
    return;
  }
  const frames = parseStackFrames(text);
  let repoFiles: string[] = [];
  try { repoFiles = git(['ls-files'], { cwd: repoPath }).split('\n').filter(Boolean); } catch { /* ignore */ }

  // Resolve the repo once so both the per-frame cards and the PR-comment POST
  // share it. (tryServerWhy resolves it too, but we need the id here anyway.)
  const repo = await resolveOriginRepoId(repoPath);

  const results: Array<{ file: string; line: number; content: string; sha: string; card: any }> = [];
  for (const fr of frames) {
    const rel = resolveFrameFile(fr.file, repoPath, repoFiles);
    if (!rel) continue;
    const sha = getCommitForLine(repoPath, rel, fr.line);
    if (!sha || sha.startsWith('0000000')) continue;
    let content = '';
    try { content = (readFileSync(path.join(repoPath, rel), 'utf-8').split('\n')[fr.line - 1] || '').trim(); } catch { /* ignore */ }
    const card = await tryServerWhy(repoPath, rel, sha, content);
    if (card && card.session) results.push({ file: rel, line: fr.line, content, sha, card });
  }

  const apiUrl = loadConfig()?.apiUrl || 'https://getorigin.io';

  // Machine-readable output for a CI/agent fix-forward step: pipe this into an
  // agent alongside the failing trace so it fixes with the authoring prompt +
  // the [Origin: Verify] checklist in hand.
  if (opts?.json) {
    console.log(JSON.stringify({
      frames: frames.length,
      attributed: results.length,
      results: results.map((r) => ({
        file: r.file, line: r.line, sha: r.sha, content: r.content,
        session: { id: r.card.session?.id, agent: r.card.session?.agent, model: r.card.session?.model, url: `${apiUrl}${r.card.session?.url || '/sessions/' + r.card.session?.id}` },
        prompt: r.card.prompt || null,
        confidence: r.card.confidence,
        verify: r.card.markers?.verifies || [],
      })),
    }, null, 2));
    // Still honor --pr-comment below when both are set.
  }

  if (!opts?.json) {
    console.log(chalk.bold(`\n  Origin Why · stack trace`) + chalk.gray(`  (${frames.length} frames, ${results.length} attributed in this repo)`));
  }
  if (results.length === 0) {
    if (!opts?.json) console.log(chalk.gray('\n  No frames mapped to AI-authored code in this repo.\n'));
    return;
  }
  if (!opts?.json) {
    for (const r of results) {
      const s = r.card.session || {};
      const p = r.card.prompt;
      console.log('');
      console.log('  ' + chalk.white(`${r.file}:${r.line}`) + (r.content ? chalk.gray(`  ${r.content.slice(0, 60)}`) : ''));
      console.log('    ' + chalk.cyan(s.agent || s.model || 'AI') + (p ? chalk.gray(` · prompt #${p.index} `) + chalk.green(`"${(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`) : ''));
      const vs = r.card.markers?.verifies || [];
      if (vs.length) console.log('    ' + chalk.yellow('Verify: ') + chalk.gray(vs[0]) + chalk.gray(' — checked?'));
      console.log('    ' + chalk.blue(`${apiUrl}${s.url || '/sessions/' + s.id}`));
    }
    console.log('');
  }

  // ── CI auto-link: post the provenance back to the PR/MR ────────────────
  if (opts?.prComment) {
    const prNumber = resolvePrNumber(opts.prComment);
    if (!repo) {
      console.error(chalk.yellow('  --pr-comment: this checkout isn\'t linked to an Origin repo; skipping.'));
      return;
    }
    if (!prNumber) {
      console.error(chalk.yellow('  --pr-comment: no PR number found. Pass ') + chalk.cyan('--pr-comment <number>') + chalk.yellow(' or set ORIGIN_PR_NUMBER.'));
      process.exitCode = 1;
      return;
    }
    try {
      const { api } = await import('../api.js');
      const resp: any = await api.postWhyPrComment(repo.id, {
        prNumber,
        frames: results.map((r) => ({ file: r.file, line: r.line, sha: r.sha, content: r.content })),
      });
      if (resp?.posted) {
        console.log('  ' + chalk.green(`✓ Posted provenance for ${resp.resolved} line(s) to PR #${prNumber}.`));
      } else {
        console.error('  ' + chalk.yellow(`Could not post to PR #${prNumber}: ${resp?.error || resp?.reason || 'unknown'}`));
      }
    } catch (e: any) {
      console.error('  ' + chalk.red(`--pr-comment failed: ${e?.message || e}`));
    }
  }
}

export async function whyCommand(input: string, opts?: { trace?: string | boolean; prComment?: string | boolean; json?: boolean }) {
  const repoPathForTrace = getGitRoot(process.cwd());
  if (opts?.trace || opts?.prComment) {
    if (!repoPathForTrace) { console.log(chalk.red('Not inside a git repository.')); process.exit(1); }
    await whyTraceCommand(opts.trace ?? true, repoPathForTrace, { prComment: opts.prComment, json: opts.json });
    return;
  }
  if (!input) {
    console.error(chalk.red('Usage: ') + 'origin why <file>:<line>   ' + chalk.gray('or  origin why --trace < error.log'));
    process.exitCode = 1;
    return;
  }
  const { file, line } = parseFileAndLine(input);

  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  if (line) {
    await showLineWhy(repoPath, file, line);
  } else {
    await showFileWhy(repoPath, file);
  }
}
