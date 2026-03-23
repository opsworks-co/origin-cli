import chalk from 'chalk';
import { loadConfig, isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { loadSessionState, getGitRoot, getHeadSha } from '../session-state.js';
import { getPromptsBySession } from '../local-db.js';
import { execSync } from 'child_process';

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Load session from local origin-sessions git branch ──────────────────────

interface LocalSessionData {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  costUsd: number;
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  toolCalls?: number;
  branch?: string;
  prompts?: Array<{ index: number; text: string }>;
}

function loadLocalSession(sessionId: string, repoPath: string): LocalSessionData | null {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  try {
    const dir = resolveSessionDir(sessionId, repoPath);
    if (!dir) return null;
    const metadataJson = execSync(
      `git show origin-sessions:sessions/${dir}/metadata.json`,
      execOpts
    ).trim();
    return JSON.parse(metadataJson);
  } catch {
    return null;
  }
}

function resolveSessionDir(sessionId: string, repoPath: string): string | null {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  // Try exact match
  try {
    execSync(`git show origin-sessions:sessions/${sessionId}/metadata.json`, execOpts);
    return sessionId;
  } catch {}
  // Short ID prefix match
  try {
    const raw = execSync('git ls-tree --name-only origin-sessions sessions/', execOpts).trim();
    if (!raw) return null;
    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));
    return dirs.find(d => d.startsWith(sessionId)) || null;
  } catch {
    return null;
  }
}

function loadLocalPromptsMarkdown(sessionId: string, repoPath: string): string | null {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  try {
    const dir = resolveSessionDir(sessionId, repoPath);
    if (!dir) return null;
    return execSync(
      `git show origin-sessions:sessions/${dir}/prompts.md`,
      execOpts
    ).trim();
  } catch {
    return null;
  }
}

// ── AI Summary Generator ────────────────────────────────────────────────────

function generateSummary(session: any, promptsText: string): string {
  // Build a structured summary from available data
  const lines: string[] = [];

  lines.push(chalk.bold('\n  AI Summary\n'));

  // Intent — derive from first prompt or commit message
  const prompts = session.promptChanges || session.prompts || [];
  const firstPrompt = prompts[0]?.promptText || prompts[0]?.text || '';
  if (firstPrompt) {
    const intent = firstPrompt.slice(0, 200).replace(/\n/g, ' ');
    lines.push(chalk.gray(`  Intent:      ${chalk.white(intent)}${firstPrompt.length > 200 ? '...' : ''}`));
  }

  // Outcome — derive from files changed and lines
  const filesCount = Array.isArray(session.filesChanged) ? session.filesChanged.length : (() => { try { return JSON.parse(session.filesChanged).length; } catch { return 0; } })();
  lines.push(chalk.gray(`  Outcome:     ${chalk.white(`${filesCount} files changed`)} (${chalk.green(`+${session.linesAdded}`)} ${chalk.red(`-${session.linesRemoved}`)})`));

  // Scope analysis
  const totalLines = (session.linesAdded || 0) + (session.linesRemoved || 0);
  const scope = totalLines > 500 ? 'Major change' : totalLines > 100 ? 'Moderate change' : totalLines > 20 ? 'Small change' : 'Micro change';
  lines.push(chalk.gray(`  Scope:       ${chalk.white(scope)} — ${totalLines} total lines affected`));

  // Efficiency
  const tokensPerLine = totalLines > 0 ? Math.round((session.tokensUsed || 0) / totalLines) : 0;
  const costPerLine = totalLines > 0 ? ((session.costUsd || 0) / totalLines) : 0;
  lines.push(chalk.gray(`  Efficiency:  ${chalk.white(`${tokensPerLine} tokens/line`)} — ${chalk.white(`$${costPerLine.toFixed(4)}/line`)}`));

  // Duration analysis
  if (session.durationMs) {
    const linesPerMinute = session.durationMs > 0 ? Math.round(totalLines / (session.durationMs / 60000)) : 0;
    lines.push(chalk.gray(`  Velocity:    ${chalk.white(`${linesPerMinute} lines/min`)}`));
  }

  // Prompt analysis
  const promptCount = prompts.length;
  if (promptCount > 0) {
    const avgPromptLen = promptsText ? Math.round(promptsText.length / promptCount) : 0;
    lines.push(chalk.gray(`  Prompts:     ${chalk.white(`${promptCount} prompts`)} — avg ${avgPromptLen} chars each`));
  }

  // Tool usage
  if (session.toolCalls) {
    const toolsPerPrompt = promptCount > 0 ? (session.toolCalls / promptCount).toFixed(1) : '—';
    lines.push(chalk.gray(`  Tool calls:  ${chalk.white(String(session.toolCalls))} (${toolsPerPrompt} per prompt)`));
  }

  return lines.join('\n');
}

/**
 * origin explain [sessionId|commitSha]
 *
 * Shows a detailed explanation of a coding session.
 * Works in both standalone and connected mode.
 *
 * Standalone: reads from origin-sessions git branch + local DB
 * Connected: fetches from Origin API
 */
export async function explainCommand(target?: string, opts?: { short?: boolean; commit?: string; summarize?: boolean; json?: boolean }) {
  const connected = isConnectedMode();
  const config = loadConfig();
  let sessionId = target;
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  // If --commit flag, look up session by commit SHA
  if (opts?.commit && repoPath) {
    try {
      const noteContent = execSync(
        `git notes --ref=origin show ${opts.commit} 2>/dev/null`,
        { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const noteData = JSON.parse(noteContent);
      sessionId = noteData?.origin?.sessionId || noteData?.sessionId;
      if (sessionId) {
        console.log(chalk.gray(`Found session ${sessionId} linked to commit ${opts.commit.slice(0, 8)}`));
      }
    } catch {
      console.log(chalk.yellow(`No Origin session linked to commit ${opts.commit.slice(0, 8)}`));
      return;
    }
  }

  // If no target, use active session
  if (!sessionId) {
    const state = loadSessionState();
    if (state) {
      sessionId = state.sessionId;
      console.log(chalk.gray(`Using active session: ${sessionId}`));
    } else {
      console.log(chalk.red('No session ID provided and no active session found.'));
      console.log(chalk.gray('Usage: origin explain <sessionId>'));
      console.log(chalk.gray('       origin explain --commit <sha>'));
      return;
    }
  }

  try {
    let session: any;
    let promptsText = '';

    if (connected && config) {
      // ── Connected mode: fetch from API ──
      session = await api.getSession(sessionId!);
      if (session.promptChanges) {
        promptsText = session.promptChanges.map((pc: any) => pc.promptText).join('\n');
      }
    } else {
      // ── Standalone mode: read from git ──
      if (!repoPath) {
        console.log(chalk.red('Not in a git repository.'));
        return;
      }

      session = loadLocalSession(sessionId!, repoPath);
      if (!session) {
        // Try local DB as fallback
        const prompts = getPromptsBySession(sessionId!);
        if (prompts.length === 0) {
          console.log(chalk.red(`Session ${sessionId} not found locally.`));
          console.log(chalk.gray('Run: origin db import    (to import from origin-sessions branch)'));
          return;
        }
        // Build minimal session from prompts
        session = {
          id: sessionId,
          model: prompts[0].model || 'unknown',
          tokensUsed: 0,
          costUsd: 0,
          toolCalls: 0,
          linesAdded: 0,
          linesRemoved: 0,
          durationMs: 0,
          filesChanged: JSON.stringify([...new Set(prompts.flatMap(p => p.filesChanged))]),
          promptChanges: prompts.map(p => ({
            promptIndex: p.promptIndex,
            promptText: p.promptText,
            filesChanged: p.filesChanged,
          })),
        };
      } else {
        // session is from metadata.json — normalize
        session = {
          id: session.sessionId || sessionId,
          model: session.model || 'unknown',
          tokensUsed: session.tokensUsed || 0,
          inputTokens: session.inputTokens || 0,
          outputTokens: session.outputTokens || 0,
          costUsd: session.costUsd || 0,
          toolCalls: session.toolCalls || 0,
          linesAdded: session.linesAdded || 0,
          linesRemoved: session.linesRemoved || 0,
          durationMs: session.durationMs || 0,
          filesChanged: JSON.stringify(session.filesChanged || []),
          branch: session.branch || session.git?.branch,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          status: session.status || 'COMPLETED',
          prompts: session.prompts,
        };
      }

      // Load prompts markdown from git
      const promptsMd = loadLocalPromptsMarkdown(sessionId!, repoPath);
      if (promptsMd) {
        promptsText = promptsMd;
        // Parse prompts from markdown into promptChanges if not present
        if (!session.promptChanges) {
          const parsed = promptsMd.split(/^## Prompt \d+/m).filter(Boolean);
          session.promptChanges = parsed.map((block: string, i: number) => ({
            promptIndex: i,
            promptText: block.trim().slice(0, 500),
            filesChanged: [],
          }));
        }
      }
    }

    // ── JSON output ──
    if (opts?.json) {
      console.log(JSON.stringify(session, null, 2));
      return;
    }

    // ── Render ──
    console.log(chalk.bold('\n  Session Explanation\n'));

    // Header
    console.log(chalk.gray(`  Session:     ${chalk.white(session.id)}`));
    console.log(chalk.gray(`  Model:       ${chalk.cyan(session.model)}`));
    if (session.agentName) console.log(chalk.gray(`  Agent:       ${chalk.white(session.agentName)}`));
    if (session.userName) console.log(chalk.gray(`  User:        ${chalk.white(session.userName)}`));
    if (session.repoName) console.log(chalk.gray(`  Repo:        ${chalk.white(session.repoName)}`));
    if (session.branch) console.log(chalk.gray(`  Branch:      ${chalk.yellow(session.branch)}`));
    if (session.durationMs) console.log(chalk.gray(`  Duration:    ${chalk.white(formatDuration(session.durationMs))}`));

    console.log(chalk.gray(`  Tokens:      ${chalk.white((session.tokensUsed || 0).toLocaleString())} (${(session.inputTokens || 0).toLocaleString()} in / ${(session.outputTokens || 0).toLocaleString()} out)`));

    const cost = session.costUsd || 0;
    const costStr = cost < 0.01 && cost > 0 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
    console.log(chalk.gray(`  Cost:        ${chalk.white(costStr)}`));
    if (session.toolCalls) console.log(chalk.gray(`  Tool calls:  ${chalk.white(String(session.toolCalls))}`));
    console.log(chalk.gray(`  Lines:       ${chalk.green(`+${session.linesAdded || 0}`)} ${chalk.red(`-${session.linesRemoved || 0}`)}`));

    // Files changed
    try {
      const files = typeof session.filesChanged === 'string' ? JSON.parse(session.filesChanged) : session.filesChanged;
      if (files && files.length > 0) {
        console.log(chalk.bold('\n  Files Changed'));
        for (const f of files.slice(0, 30)) {
          console.log(chalk.gray(`    ${chalk.white(f)}`));
        }
        if (files.length > 30) {
          console.log(chalk.gray(`    ... and ${files.length - 30} more`));
        }
      }
    } catch { /* ignore */ }

    // Prompt changes (what was asked → what files changed)
    if (session.promptChanges && session.promptChanges.length > 0 && !opts?.short) {
      console.log(chalk.bold('\n  Prompt → Change Mapping'));
      for (const pc of session.promptChanges) {
        const promptPreview = (pc.promptText || '').slice(0, 100).replace(/\n/g, ' ');
        console.log(chalk.gray(`\n    Prompt #${(pc.promptIndex || 0) + 1}: ${chalk.white(promptPreview)}${(pc.promptText || '').length > 100 ? '...' : ''}`));
        if (pc.filesChanged && pc.filesChanged.length > 0) {
          for (const f of pc.filesChanged) {
            console.log(chalk.gray(`      → ${chalk.green(f)}`));
          }
        }
      }
    }

    // Review status
    if (session.review) {
      const statusColors: Record<string, (s: string) => string> = {
        approved: chalk.green,
        rejected: chalk.red,
        flagged: chalk.yellow,
      };
      const colorFn = statusColors[session.review.status?.toLowerCase()] || chalk.gray;
      console.log(chalk.bold('\n  Review'));
      console.log(chalk.gray(`    Status: ${colorFn(session.review.status)}`));
      if (session.review.note) {
        console.log(chalk.gray(`    Note:   ${session.review.note.slice(0, 200)}`));
      }
    }

    // Status
    console.log(chalk.bold('\n  Status'));
    const statusStr = session.status === 'RUNNING'
      ? chalk.magenta('● Running')
      : session.status === 'COMPLETED'
        ? chalk.blue('● Completed')
        : chalk.gray(`● ${session.status}`);
    console.log(chalk.gray(`    ${statusStr}`));
    if (session.startedAt) console.log(chalk.gray(`    Started: ${new Date(session.startedAt).toLocaleString()}`));
    if (session.endedAt) console.log(chalk.gray(`    Ended:   ${new Date(session.endedAt).toLocaleString()}`));

    // ── AI Summary (--summarize) ──
    if (opts?.summarize) {
      console.log(generateSummary(session, promptsText));
    }

    // Dashboard link (connected only)
    if (connected && config) {
      const apiUrl = config.apiUrl || 'https://getorigin.io';
      console.log(chalk.gray(`\n    ${chalk.blue(`${apiUrl}/sessions/${session.id}`)}`));
    }

    console.log('');
  } catch (err: any) {
    console.log(chalk.red(`Failed to load session: ${err.message}`));
  }
}
