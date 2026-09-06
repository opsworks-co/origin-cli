import chalk from 'chalk';
import { listSessionIds, readSessionFile } from '../session-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isConnectedMode, loadAgentConfig } from '../config.js';
import { api } from '../api.js';
import { getGitRoot, listActiveSessions, listAllActiveSessions, clearSessionState, stopHeartbeat, isHeartbeatAlive } from '../session-state.js';
import { git, gitOrNull } from '../utils/exec.js';
import { currentOwner, isForeignSession, listForeignQueuedSessions, reportForeignSessionCount } from '../session-owner.js';
import { resolveAgentDisplayName } from '../agents/registry.js';
import { makeSyncBlock } from '../sync-block.js';
import { durableUpdateSession } from '../update-queue.js';
import { debugLog } from '../debug-log.js';

const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

interface LocalSession {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  git?: { branch?: string; commitShas?: string[] };
  prompts?: Array<{ index: number; text: string }>;
  agentSlug?: string;
  agentName?: string;
}

function listLocalSessions(repoPath: string): LocalSession[] {
  const gitOpts = { cwd: repoPath };
  const sessions: LocalSession[] = [];

  try {
    // List stored sessions (refs or branch backend)
    const dirs = listSessionIds(repoPath);
    if (dirs.length === 0) return sessions;

    for (const dir of dirs) {
      if (!SAFE_ID.test(dir)) continue;
      try {
        const metadataJson = (readSessionFile(repoPath, dir, 'metadata.json') ?? '').trim();
        const metadata = JSON.parse(metadataJson);
        sessions.push({
          sessionId: metadata.sessionId || dir,
          model: metadata.model || 'unknown',
          startedAt: metadata.startedAt || '',
          endedAt: metadata.endedAt || undefined,
          status: metadata.status || 'ended',
          costUsd: metadata.cost?.usd || 0,
          tokensUsed: metadata.tokens?.total || 0,
          durationMs: metadata.durationMs || 0,
          filesChanged: metadata.filesChanged || [],
          linesAdded: metadata.lines?.added || 0,
          linesRemoved: metadata.lines?.removed || 0,
          git: metadata.git,
          prompts: metadata.prompts,
        });
      } catch {
        // Skip sessions with invalid metadata
      }
    }
  } catch {
    // origin-sessions branch might not have sessions/ dir
  }

  // Sort: RUNNING first, then by startedAt descending
  sessions.sort((a, b) => {
    const aRunning = a.status === 'RUNNING' ? 1 : 0;
    const bRunning = b.status === 'RUNNING' ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });
  return sessions;
}

export async function sessionsCommand(opts: { status?: string; model?: string; limit?: string; all?: boolean; global?: boolean; local?: boolean; source?: boolean }) {
  // --global is alias for --all
  if (opts.global) opts.all = true;
  const repoPath = getGitRoot(process.cwd());
  const limit = parseInt(opts.limit || '20', 10);
  // Always show source column in connected mode (unless --local which means local-only)
  const showSource = opts.source || (isConnectedMode() && !opts.local);

  // Read local sessions — skip when connected to platform (platform is source of truth)
  let localSessions: LocalSession[] = [];
  const connected = isConnectedMode() && !opts.local;
  if (repoPath && !connected) {
    localSessions = listLocalSessions(repoPath);

    // Also include active sessions from state files for current repo
    if (!opts.all) {
      try {
        const activeStates = listActiveSessions(repoPath);
        const existingIds = new Set(localSessions.map(s => s.sessionId));
        for (const state of activeStates) {
          if (!existingIds.has(state.sessionId)) {
            existingIds.add(state.sessionId);
            localSessions.push({
              sessionId: state.sessionId,
              model: state.model || 'unknown',
              status: (state as any).status === 'ENDED' ? 'ENDED' : isHeartbeatAlive(state.sessionId) ? 'RUNNING' : 'ENDED',
              filesChanged: (state as any).filesChanged || [],
              costUsd: 0,
              tokensUsed: 0,
              durationMs: Date.now() - new Date(state.startedAt).getTime(),
              linesAdded: 0,
              linesRemoved: 0,
              startedAt: state.startedAt,
              agentSlug: (state as any).agentSlug || undefined,
              agentName: undefined,
            } as LocalSession);
          }
        }
      } catch { /* ignore */ }
    }

    // Apply filters
    if (opts.model) {
      const m = opts.model.toLowerCase();
      localSessions = localSessions.filter(s => s.model.toLowerCase().includes(m));
    }
    if (opts.status) {
      const st = opts.status.toLowerCase();
      localSessions = localSessions.filter(s => s.status.toLowerCase() === st);
    }
  }

  // For --all/--global: scan ALL repos' state files (only in disconnected/local mode)
  if (opts.all && !connected) {
    try {
      const allStates = listAllActiveSessions();
      const existingIds = new Set(localSessions.map(s => s.sessionId));
      for (const state of allStates) {
        if (!existingIds.has(state.sessionId)) {
          existingIds.add(state.sessionId);
          localSessions.push({
            sessionId: state.sessionId,
            model: state.model || 'unknown',
            status: (state as any).status === 'ENDED' ? 'ENDED' : 'RUNNING',
            filesChanged: (state as any).filesChanged || [],
            costUsd: 0,
            tokensUsed: 0,
            durationMs: Date.now() - new Date(state.startedAt).getTime(),
            linesAdded: 0,
            linesRemoved: 0,
              startedAt: state.startedAt,
              agentSlug: (state as any).agentSlug || undefined,
              agentName: undefined,
          } as LocalSession);
        }
      }
    } catch { /* ignore */ }
  }

  // In connected mode (and not --local), also fetch platform sessions and merge
  let platformSessions: any[] = [];
  if (isConnectedMode() && !opts.local) {
    try {
      const params: Record<string, string> = { limit: String(limit) };
      if (opts.status) params.status = opts.status;
      if (opts.model) params.model = opts.model;

      // Scope to current repo unless --all flag is passed
      if (!opts.all && repoPath) {
        try {
          const remoteUrl = git(['remote', 'get-url', 'origin'], { cwd: repoPath }).trim();
          // Extract repo name from URL: git@github.com:org/repo.git → org/repo
          const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
          if (match) params.repoName = match[1];
        } catch {
          // No remote — skip repo filter
        }
      }

      const data = await api.getSessions(params) as any;
      platformSessions = data.sessions || [];
    } catch {
      // Platform unavailable — fall back to local only
    }
  }

  // Build a set of platform session IDs (full and 8-char prefix) for matching
  const platformIdSet = new Set<string>();
  for (const s of platformSessions) {
    platformIdSet.add(s.id);
    platformIdSet.add(s.id.slice(0, 8));
  }

  // Merge: all local sessions + platform-only sessions.
  // Track which local sessions also exist on the platform (synced vs local-only).
  const merged: Array<{
    source: 'local' | 'origin' | 'both';
    local?: LocalSession;
    platform?: any;
  }> = [];

  const localIds = new Set<string>();

  for (const s of localSessions) {
    const shortId = s.sessionId.slice(0, 8);
    localIds.add(shortId);

    // Check if this session also exists on the platform
    const onPlatform = platformIdSet.has(shortId) || platformIdSet.has(s.sessionId);
    const platformMatch = onPlatform
      ? platformSessions.find(p => p.id.startsWith(shortId) || s.sessionId.startsWith(p.id.slice(0, 8)))
      : undefined;

    if (platformMatch) {
      // Session exists both locally and on platform — platform is source of truth for status
      if (platformMatch.status && platformMatch.status !== 'RUNNING' && s.status?.toLowerCase() === 'running') {
        s.status = platformMatch.status;
      }
      merged.push({ source: 'both', local: s, platform: platformMatch });
    } else {
      merged.push({ source: 'local', local: s });
    }
  }

  // Add platform-only sessions (not found locally)
  for (const s of platformSessions) {
    const shortId = s.id.slice(0, 8);
    if (!localIds.has(shortId)) {
      merged.push({ source: 'origin', platform: s });
    }
  }

  // Sort: RUNNING first, then by time descending
  merged.sort((a, b) => {
    const aData = a.platform || a.local;
    const bData = b.platform || b.local;
    const aStatus = (aData?.status || '').toUpperCase();
    const bStatus = (bData?.status || '').toUpperCase();
    const aRunning = aStatus === 'RUNNING' ? 1 : 0;
    const bRunning = bStatus === 'RUNNING' ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    const ta = a.local?.startedAt || a.platform?.createdAt || a.platform?.startedAt || '';
    const tb = b.local?.startedAt || b.platform?.createdAt || b.platform?.startedAt || '';
    return new Date(tb).getTime() - new Date(ta).getTime();
  });

  const display = merged.slice(0, limit);

  if (display.length === 0) {
    console.log(chalk.gray('No sessions found. Start an AI coding session to begin tracking.'));
    return;
  }

  // Show header with repo context
  if (!opts.all && repoPath) {
    let repoName = '';
    try {
      const remoteUrl = git(['remote', 'get-url', 'origin'], { cwd: repoPath }).trim();
      const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) repoName = match[1];
    } catch {}
    const modeLabel = opts.local ? ' (local only)' : '';
    console.log(chalk.bold(`\nSessions${repoName ? ` — ${repoName}` : ''}${modeLabel} (${display.length} total)\n`));
  } else {
    console.log(chalk.bold(`\nSessions — all repos (${display.length} total)\n`));
  }

  // Repo column: redundant in single-repo mode (the header names the repo), so
  // only shown for --all/--global where rows span multiple repos.
  const showRepo = !!opts.all;

  // Column headers, aligned to the exact widths used by the data rows below.
  const header = [
    `  ${'ID'.padEnd(8)}`,
    `${'MODEL'.padEnd(25)}`,
    `${'AGENT'.padEnd(16)}`,
    `${'STATUS'.padEnd(12)}`,
    `${'FILES'.padEnd(9)}`,
    `${'COST'.padEnd(7)}`,
    `${'AGE'.padEnd(10)}`,
  ];
  if (showRepo) header.push(`${'REPO'.padEnd(22)}`);
  if (showSource) header.push('SOURCE');
  console.log(chalk.dim(header.join('  ')));

  for (const entry of display) {
    // Resolve display values from whichever data source is available
    const isLocal = entry.source === 'local' || entry.source === 'both';
    const isPlatform = entry.source === 'origin' || entry.source === 'both';
    const local = entry.local;
    const platform = entry.platform;

    // Session ID
    const id = local?.sessionId?.slice(0, 8) || platform?.id?.slice(0, 8) || '????????';

    // Model / agent name
    const displayModel = local?.model || platform?.model || 'unknown';
    // Agent name for the AGENT column. The server's linked agent name wins; else
    // resolve from the session's slug/model. The slug is authoritative — Copilot
    // and Windsurf run Claude/GPT models, so the model alone can't name the agent.
    const agentSlug = (local as any)?.agentSlug || (platform as any)?.agentSlug;
    let agentLabel = platform?.agentName || local?.agentName || resolveAgentDisplayName(displayModel, agentSlug);
    if (!agentLabel || /^(unknown|ai)$/i.test(agentLabel)) agentLabel = '—';
    if (agentLabel.length > 16) agentLabel = agentLabel.slice(0, 15) + '…';

    // Status — simple: RUNNING / IDLE / ENDED
    let status: string;
    let statusColor: (s: string) => string;
    const rawStatus = (platform?.status || local?.status || '').toUpperCase();

    if (rawStatus === 'RUNNING') {
      status = 'RUNNING';
      statusColor = chalk.green;
    } else if (rawStatus === 'IDLE') {
      status = 'IDLE';
      statusColor = chalk.yellow;
    } else {
      status = 'ENDED';
      statusColor = chalk.gray;
    }

    // Files
    let files = 0;
    if (local) {
      files = local.filesChanged?.length || 0;
    } else if (platform) {
      // The API serves `filesChanged` as a real array (sessions.ts documents
      // the switch from the JSON-string column shape). `JSON.parse` on an
      // array coerces it to "a,b,c" and throws, so every server row read
      // "0 files" — including sessions the detail page showed with eleven.
      const raw = (platform as { filesChanged?: unknown }).filesChanged;
      if (Array.isArray(raw)) files = raw.length;
      else if (typeof raw === 'string') {
        try { const f = JSON.parse(raw); files = Array.isArray(f) ? f.length : 0; } catch { files = 0; }
      }
    }

    // Cost
    const cost = platform?.costUsd ?? local?.costUsd ?? 0;

    // Time
    const time = local?.startedAt || platform?.createdAt || platform?.startedAt || '';
    const age = time ? timeAgo(time) : '—';

    // Source indicator
    let sourceTag = '';
    if (showSource) {
      if (entry.source === 'both') {
        sourceTag = chalk.green('origin');
      } else if (entry.source === 'origin') {
        sourceTag = chalk.green('origin');
      } else {
        sourceTag = chalk.dim('local ');
      }
    }

    const line = [
      `  ${chalk.dim(id.padEnd(8))}`,
      `${chalk.cyan(displayModel.padEnd(25))}`,
      `${chalk.magenta(agentLabel.padEnd(16))}`,
      `${statusColor(status.padEnd(12))}`,
      `${String(files).padStart(3)} files`,
      `${chalk.dim('$' + cost.toFixed(2).padStart(6))}`,
      `${chalk.dim(age.padEnd(10))}`,
    ];
    if (showRepo) {
      // Repo identity for this session (owner/repo when known), truncated to
      // the column width so multi-repo output stays aligned.
      let repoLabel = String((platform as any)?.repoName || (local as any)?.repoName || '—');
      if (repoLabel.length > 22) repoLabel = repoLabel.slice(0, 21) + '…';
      line.push(chalk.white(repoLabel.padEnd(22)));
    }
    if (showSource) {
      line.push(sourceTag);
    }
    console.log(line.join('  '));
  }

  // Legend for source column
  if (showSource) {
    const localCount = display.filter(d => d.source === 'local').length;
    const originCount = display.filter(d => d.source === 'origin' || d.source === 'both').length;
    if (localCount > 0 && originCount > 0) {
      console.log(chalk.dim(`\n  ${chalk.green('origin')} = synced to Origin platform  ${chalk.dim('local')} = local only (agent not registered)`));
    } else if (localCount > 0) {
      console.log(chalk.dim(`\n  All sessions are local only. Run ${chalk.white('origin enable')} to sync with Origin.`));
    }
  }
  console.log('');
}

export async function sessionDetailCommand(id: string) {
  // ── Local-only sessions: skip API call ──
  const isLocalSession = id.startsWith('local-');

  // ── Try API first (if connected and not a local session) ──
  if (!isLocalSession && isConnectedMode()) {
    try {
      const s = await api.getSession(id) as any;

      console.log(chalk.bold('\nSession Detail\n'));
      console.log(`  ${chalk.gray('ID:')}          ${s.id}`);
      console.log(`  ${chalk.gray('Model:')}       ${chalk.cyan(s.model)}`);
      console.log(`  ${chalk.gray('Repo:')}        ${s.repoName || '—'}`);
      console.log(`  ${chalk.gray('Commit:')}      ${s.commitMessage || '—'}`);
      console.log(`  ${chalk.gray('SHA:')}         ${s.commitSha?.slice(0, 8) || '—'}`);
      console.log(`  ${chalk.gray('Author:')}      ${s.commitAuthor || '—'}`);
      console.log(`  ${chalk.gray('Agent:')}       ${s.agentName || '—'}`);
      console.log(`  ${chalk.gray('Tokens:')}      ${s.tokensUsed.toLocaleString()}`);
      console.log(`  ${chalk.gray('Cost:')}        $${s.costUsd.toFixed(2)}`);
      console.log(`  ${chalk.gray('Duration:')}    ${formatDuration(s.durationMs)}`);
      console.log(`  ${chalk.gray('Tool calls:')}  ${s.toolCalls}`);
      console.log(`  ${chalk.gray('Lines:')}       ${chalk.green('+' + s.linesAdded)} ${chalk.red('-' + s.linesRemoved)}`);

      const files = (() => { try { return JSON.parse(s.filesChanged); } catch { return []; } })();
      if (files.length > 0) {
        console.log(`  ${chalk.gray('Files:')}`);
        files.forEach((f: string) => console.log(`    ${chalk.dim('•')} ${f}`));
      }

      if (s.review) {
        const c = s.review.status === 'APPROVED' ? chalk.green : s.review.status === 'REJECTED' ? chalk.red : chalk.yellow;
        console.log(`\n  ${chalk.gray('Review:')}      ${c(s.review.status)} by ${s.review.reviewerName || 'unknown'}`);
        if (s.review.note) console.log(`  ${chalk.gray('Note:')}        ${s.review.note}`);
      } else {
        console.log(`\n  ${chalk.gray('Review:')}      ${chalk.dim('Not reviewed')}`);
      }
      console.log('');
      return; // Found on platform, done
    } catch {
      // Not found on platform — fall through to local
    }
  }

  // ── Local: read from origin-sessions branch + state files ──
  const repoPath = getGitRoot(process.cwd());

  let session: LocalSession | undefined;

  // Check origin-sessions git branch
  if (repoPath) {
    const sessions = listLocalSessions(repoPath);
    session = sessions.find(s => s.sessionId.startsWith(id));
  }

  // Fallback: check ~/.origin/sessions/ state files
  if (!session) {
    const allStates = listAllActiveSessions();
    const stateMatch = allStates.find(s => s.sessionId.startsWith(id));
    if (stateMatch) {
      session = {
        sessionId: stateMatch.sessionId,
        model: stateMatch.model || 'unknown',
        status: (stateMatch as any).status === 'ENDED' ? 'ENDED' : isHeartbeatAlive(stateMatch.sessionId) ? 'RUNNING' : 'ENDED',
        filesChanged: (stateMatch as any).filesChanged || [],
        costUsd: 0,
        tokensUsed: 0,
        durationMs: Date.now() - new Date(stateMatch.startedAt).getTime(),
        linesAdded: 0,
        linesRemoved: 0,
        startedAt: stateMatch.startedAt,
        agentName: undefined,
        prompts: stateMatch.prompts,
      } as any;
    }
  }

  if (!session) {
    console.log(chalk.red(`Session not found: ${id}`));
    return;
  }

  console.log(chalk.bold('\nSession Detail (local)\n'));
  console.log(`  ${chalk.gray('ID:')}          ${session.sessionId}`);
  console.log(`  ${chalk.gray('Model:')}       ${chalk.cyan(session.model)}`);
  console.log(`  ${chalk.gray('Status:')}      ${session.status}`);
  console.log(`  ${chalk.gray('Started:')}     ${session.startedAt}`);
  if (session.endedAt) console.log(`  ${chalk.gray('Ended:')}       ${session.endedAt}`);
  console.log(`  ${chalk.gray('Tokens:')}      ${session.tokensUsed.toLocaleString()}`);
  console.log(`  ${chalk.gray('Cost:')}        $${session.costUsd.toFixed(2)}`);
  console.log(`  ${chalk.gray('Duration:')}    ${formatDuration(session.durationMs)}`);
  console.log(`  ${chalk.gray('Lines:')}       ${chalk.green('+' + session.linesAdded)} ${chalk.red('-' + session.linesRemoved)}`);
  if (session.git?.branch) console.log(`  ${chalk.gray('Branch:')}      ${session.git.branch}`);

  if (session.filesChanged.length > 0) {
    console.log(`  ${chalk.gray('Files:')}`);
    session.filesChanged.forEach(f => console.log(`    ${chalk.dim('•')} ${f}`));
  }

  // Try to read prompts.md
  if (repoPath) {
    try {
      if (!SAFE_ID.test(session.sessionId)) throw new Error('invalid session id');
      const prompts = (readSessionFile(repoPath, session.sessionId, 'prompts.md') ?? '').trim();
      if (prompts) {
        console.log(chalk.bold('\n  Prompts:\n'));
        console.log(prompts.split('\n').map(l => '    ' + l).join('\n'));
      }
    } catch {
      // No prompts file
    }
  }
  console.log('');
}

export async function sessionEndCommand(id: string) {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  // 1. Kill heartbeat FIRST — before ending on platform, so it can't re-ping
  try {
    const hbDir = path.join(os.homedir(), '.origin', 'heartbeats');
    if (fs.existsSync(hbDir)) {
      const pidFiles = fs.readdirSync(hbDir).filter(f => f.endsWith('.pid'));
      for (const pf of pidFiles) {
        const sessionId = pf.replace('.pid', '');
        if (sessionId === id || sessionId.startsWith(id) || id.startsWith(sessionId.slice(0, 8))) {
          const pidPath = path.join(hbDir, pf);
          try {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            if (pid > 0) {
              try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
              console.log(chalk.gray(`  Killed heartbeat (pid ${pid}).`));
            }
          } catch { /* ignore */ }
          try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  // 2. End on platform (if connected)
  if (isConnectedMode()) {
    try {
      await api.endSessionById(id);
      console.log(chalk.green(`Session ${id} ended on platform.`));
    } catch (err: any) {
      console.log(chalk.yellow(`Platform: ${err.message || 'failed to end'}`));
    }
  }

  // 3. Clean local state files and global archive
  let localCleaned = false;
  try {
    // Clean active state files (in .git/ dirs)
    const allSessions = listAllActiveSessions();
    for (const s of allSessions) {
      if (s.sessionId === id || s.sessionId.startsWith(id) || id.startsWith(s.sessionId.slice(0, 8))) {
        stopHeartbeat(s.sessionId); // double-check
        if (s.sessionTag) {
          clearSessionState(s.repoPath || undefined, s.sessionTag);
        }
        localCleaned = true;
        break;
      }
    }
  } catch { /* ignore */ }

  // Clean global archive (~/.origin/sessions/)
  try {
    const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      for (const entry of entries) {
        const filePath = path.join(sessionsDir, entry);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const state = JSON.parse(raw);
          if (state.sessionId === id || state.sessionId?.startsWith(id) || id.startsWith(state.sessionId?.slice(0, 8) || '')) {
            state.status = 'ENDED';
            state.endedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(state), { mode: 0o600 });
            localCleaned = true;
          }
        } catch { /* ignore corrupt file */ }
      }
    }
  } catch { /* ignore */ }

  if (localCleaned) {
    console.log(chalk.green(`  Local state cleaned.`));
  }

  // 4. Update origin-sessions git branch — mark as ended
  try {
    const repoPath = getGitRoot();
    if (repoPath) {
      const gitOpts = { cwd: repoPath };
      const sessionDirs = listSessionIds(repoPath).map((sid) => `sessions/${sid}`);

      for (const dir of sessionDirs) {
        const safeId = dir.replace('sessions/', '');
        if (!SAFE_ID.test(safeId)) continue;
        if (safeId === id || safeId.startsWith(id) || id.startsWith(safeId.slice(0, 8))) {
          try {
            const metaRaw = (readSessionFile(repoPath, safeId, 'metadata.json') ?? '').trim();
            const metadata = JSON.parse(metaRaw);
            if (metadata.status === 'running') {
              // Use writeSessionFiles to update the branch
              const { writeSessionFiles } = await import('../local-entrypoint.js');
              writeSessionFiles(repoPath, {
                sessionId: metadata.sessionId,
                model: metadata.model,
                startedAt: metadata.startedAt,
                endedAt: new Date().toISOString(),
                durationMs: Date.now() - new Date(metadata.startedAt).getTime(),
                status: 'ended',
                costUsd: metadata.cost?.usd || 0,
                tokensUsed: metadata.tokens?.total || 0,
                inputTokens: metadata.tokens?.input || 0,
                outputTokens: metadata.tokens?.output || 0,
                toolCalls: metadata.toolCalls || 0,
                linesAdded: metadata.lines?.added || 0,
                linesRemoved: metadata.lines?.removed || 0,
                prompts: metadata.prompts || [],
                filesChanged: metadata.filesChanged || [],
                git: metadata.git || { branch: '', headBefore: '', headAfter: '', commitShas: [] },
                summary: metadata.summary || '',
                originUrl: metadata.originUrl || '',
                changes: [],
              });
              console.log(chalk.green(`  Updated origin-sessions branch.`));
            }
          } catch { /* skip */ }
          break;
        }
      }
    }
  } catch { /* origin-sessions branch doesn't exist or not in git repo */ }
}

/**
 * `origin sessions clean` — End all stale RUNNING sessions.
 * Optionally filter by --repo or --all.
 */
export async function sessionCleanCommand(opts: { all?: boolean }) {
  const repoPath = getGitRoot();

  // ── Platform sessions ──
  if (isConnectedMode()) {
    try {
      const result = await api.getSessions({ status: 'RUNNING' });
      const sessions = result?.sessions || [];

      let toEnd = sessions;
      if (!opts.all && repoPath) {
        const repoUrl = gitOrNull(['remote', 'get-url', 'origin'], { cwd: repoPath }) || '';
        if (repoUrl) {
          toEnd = sessions.filter((s: any) => s.repoUrl === repoUrl);
        }
      }

      if (toEnd.length > 0) {
        console.log(chalk.bold(`\nEnding ${toEnd.length} running session(s) on platform...\n`));
        let ended = 0;
        for (const s of toEnd) {
          try {
            await api.endSessionById(s.id);
            console.log(chalk.green('  ✓ ') + chalk.gray(s.id.slice(0, 8)) + ' ' + (s.model || 'unknown') + ' ' + chalk.gray(timeAgo(s.startedAt)));
            ended++;
          } catch {
            console.log(chalk.red('  ✗ ') + chalk.gray(s.id.slice(0, 8)) + ' failed to end');
          }
        }
        console.log(chalk.green(`\n  Ended ${ended} session(s) on platform.\n`));
      }
    } catch (err: any) {
      console.error(chalk.yellow('Platform:'), err.message);
    }
  }

  // ── Local state files — clean up and kill orphaned heartbeats ──
  try {
    const localSessions = opts.all ? listAllActiveSessions() : (repoPath ? listActiveSessions(repoPath) : []);
    let localCleaned = 0;
    for (const s of localSessions) {
      stopHeartbeat(s.sessionId);
      if (s.sessionTag) {
        clearSessionState(s.repoPath || repoPath || undefined, s.sessionTag);
      }
      localCleaned++;
    }
    if (localCleaned > 0) {
      console.log(chalk.gray(`  Cleaned ${localCleaned} local state file(s).`));
    }
  } catch { /* ignore */ }

  // ── Git branch — end all RUNNING sessions on origin-sessions branch ──
  if (repoPath) {
    try {
      const gitOpts = { cwd: repoPath };

      const sessionDirs = listSessionIds(repoPath).map((sid) => `sessions/${sid}`);
      if (sessionDirs.length === 0) return;
      const { writeSessionFiles } = await import('../local-entrypoint.js');
      let branchCleaned = 0;

      for (const dir of sessionDirs) {
        try {
          if (!/^sessions\/[a-zA-Z0-9_.-]+$/.test(dir)) continue;
          const metaRaw = (readSessionFile(repoPath, dir.replace('sessions/', ''), 'metadata.json') ?? '').trim();
          const metadata = JSON.parse(metaRaw);
          if (metadata.status === 'running') {
            writeSessionFiles(repoPath, {
              sessionId: metadata.sessionId,
              model: metadata.model,
              startedAt: metadata.startedAt,
              endedAt: metadata.endedAt || new Date().toISOString(),
              durationMs: metadata.durationMs || (Date.now() - new Date(metadata.startedAt).getTime()),
              status: 'ended',
              costUsd: metadata.cost?.usd || 0,
              tokensUsed: metadata.tokens?.total || 0,
              inputTokens: metadata.tokens?.input || 0,
              outputTokens: metadata.tokens?.output || 0,
              toolCalls: metadata.toolCalls || 0,
              linesAdded: metadata.lines?.added || 0,
              linesRemoved: metadata.lines?.removed || 0,
              prompts: [],
              filesChanged: metadata.filesChanged || [],
              git: metadata.git || { branch: '', headBefore: '', headAfter: '', commitShas: [] },
              summary: metadata.summary || '',
              originUrl: metadata.originUrl || '',
              changes: [],
            });
            const safeId = dir.replace('sessions/', '');
            console.log(chalk.green('  ✓ ') + chalk.gray(safeId.slice(0, 8)) + ' ' + (metadata.model || 'unknown') + chalk.gray(' → ended'));
            branchCleaned++;
          }
        } catch { /* skip invalid */ }
      }

      if (branchCleaned > 0) {
        console.log(chalk.green(`\n  Ended ${branchCleaned} session(s) on origin-sessions branch.\n`));
      } else {
        console.log(chalk.gray('  No stale sessions found on origin-sessions branch.'));
      }
    } catch { /* branch doesn't exist */ }
  }
}

/**
 * `origin sessions sync` — Resync local-only sessions to Origin.
 *
 * When the API rejected `session/start` (typically AGENT_DISABLED), the CLI
 * stamped the session with a `local-${uuid}` id and kept all the captured
 * data in `~/.origin/sessions/`. Once an admin enables the agent, run this
 * to retry the upload: each queued session is replayed via `session/start`
 * (to obtain a real id), then a `session/update` carrying the capture the
 * hooks persisted — files, line counts, tokens, and the per-turn rows — and
 * finally `session/end`. The update is not optional: without it the replay
 * lands as a bare row that the empty-session sweep deletes, after this
 * function has already removed the only local copy. The local file is
 * removed on success and left in place if the agent is still disabled (so a
 * future run can try again).
 */
export async function sessionsSyncCommand(opts: { quiet?: boolean; markImported?: boolean }): Promise<{ synced: number; blocked: number; failed: number; foreign: number }> {
  const result = { synced: 0, blocked: 0, failed: 0, foreign: 0 };
  if (!isConnectedMode()) {
    if (!opts.quiet) console.log(chalk.gray('Standalone mode — nothing to sync.'));
    return result;
  }

  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    if (!opts.quiet) console.log(chalk.gray('No queued sessions.'));
    return result;
  }

  const agentConfig = loadAgentConfig();
  if (!agentConfig?.machineId) {
    if (!opts.quiet) console.log(chalk.yellow('Run `origin enable` first — machine not registered.'));
    return result;
  }

  // Ownership gate: never upload a session captured under a DIFFERENT account.
  // Without this, queued local sessions from a previous login get replayed
  // under the current API key and silently re-homed into the new account.
  const owner = currentOwner();

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  const queued: { file: string; state: any }[] = [];
  for (const file of files) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
      if (typeof state?.sessionId !== 'string' || !state.sessionId.startsWith('local-')) continue;
      if (isForeignSession(state, owner)) { result.foreign++; continue; }
      queued.push({ file, state });
    } catch { /* skip corrupt */ }
  }

  if (result.foreign > 0 && !opts.quiet) {
    console.log(chalk.yellow(`  ⚠ Skipped ${result.foreign} session${result.foreign === 1 ? '' : 's'} from a previous account (run \`origin sessions import\` to claim them).`));
  }

  if (queued.length === 0) {
    if (!opts.quiet) console.log(chalk.gray('No queued sessions.'));
    return result;
  }

  if (!opts.quiet) {
    console.log(chalk.bold(`Resyncing ${queued.length} queued session${queued.length === 1 ? '' : 's'}...\n`));
  }

  for (const { file, state } of queued) {
    const filePath = path.join(sessionsDir, file);
    const label = `${state.agentSlug || 'session'} · ${state.sessionTag || state.sessionId.slice(0, 12)}`;

    let realSessionId: string;
    if (typeof state.syncedSessionId === 'string' && state.syncedSessionId) {
      // A previous run already started this session on the server but its
      // session/end didn't land. Resume at end with the SAME id so we never
      // create a second, orphaned server row.
      realSessionId = state.syncedSessionId;
    } else {
      try {
        // Identity is the CANONICAL repo, never the working root. For a
        // worktree session those differ (`state.repoPath` is
        // `<repo>/.claude/worktrees/<name>`), and the server names an
        // auto-registered row after the directory it is handed — so replaying
        // a queued worktree session used to mint a junk repo called
        // "diff-capture-issue-dc976e" alongside the real one, grouped under
        // the same owner because `fullName` still derived from the remote.
        // The local→server migration path already reads it this way
        // (see hooks.ts `migrateLocalSessionToServer`); this loop did not.
        const identityPath = state.canonicalRepoPath || state.repoPath || process.cwd();
        // The remote is read from the WORKING root — that checkout is the one
        // the session actually ran in — falling back to the canonical repo
        // when the worktree has since been pruned. Both answer with the same
        // remote, and repoUrl is what lets the server resolve this to the
        // already-registered row instead of auto-registering at all.
        const repoUrl = gitOrNull(['remote', 'get-url', 'origin'], { cwd: state.repoPath || identityPath })
          || gitOrNull(['remote', 'get-url', 'origin'], { cwd: identityPath })
          || undefined;
        const startRes = await api.startSession({
          machineId: agentConfig.machineId,
          prompt: state.prompts?.[0]?.text || state.prompts?.[0] || '',
          model: state.model || 'unknown',
          repoPath: identityPath,
          repoUrl,
          agentSlug: state.agentSlug || undefined,
          branch: state.branch || undefined,
          hostname: agentConfig.hostname || undefined,
          importedFromPreviousAccount: opts.markImported === true,
        });
        realSessionId = startRes.sessionId as string;
        // Persist the real id BEFORE attempting end, so an end failure (or a
        // crash) resumes at end next time instead of starting a duplicate.
        state.syncedSessionId = realSessionId;
        writeSessionFileAtomic(filePath, state);
      } catch (err: any) {
        // Persist the real reason so `origin status` reports it accurately
        // between sync runs (repo-not-registered vs agent-disabled vs …).
        try {
          state.syncBlock = makeSyncBlock(err, state.repoPath || '', new Date().toISOString());
          writeSessionFileAtomic(filePath, state);
        } catch { /* non-fatal */ }
        if (err?.code === 'AGENT_DISABLED') {
          if (!opts.quiet) console.log(chalk.yellow(`  ⏸  ${label} — agent still disabled, kept local`));
          result.blocked++;
        } else {
          if (!opts.quiet) console.log(chalk.red(`  ✗  ${label} — ${err.message}`));
          result.failed++;
        }
        continue;
      }
    }

    try {
      const start = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
      const end = state.endedAt ? new Date(state.endedAt).getTime() : Date.now();
      const durationMs = Math.max(0, end - start);
      const promptText = (state.prompts || [])
        .map((p: any) => (typeof p === 'string' ? p : p.text || ''))
        .filter(Boolean)
        .join('\n\n---\n\n');

      // Ship the CAPTURE before ending. start/end alone carry no files, no line
      // counts and no per-turn rows, so this loop used to replay a fully
      // captured session as a bare row — which the empty-session sweep then
      // deleted, and `fs.unlinkSync` below had already removed the only local
      // copy. A Cursor session on `baton` (11 files, +247 −2) was resynced,
      // reported `✓`, and left nothing on the server or on disk.
      //
      // Everything here comes from the state file, which is what the hooks
      // persisted; nothing is recomputed from git, so a session whose repo has
      // moved on still replays exactly what was captured at the time.
      const mappings: any[] = Array.isArray(state.completedPromptMappings)
        ? state.completedPromptMappings
        : [];
      // A session that never reached Stop's session-level rollup has the files
      // only on its per-turn rows — the union is the session's own file list,
      // which is what Stop falls back to as well. Without this the recovered
      // row renders "0 files" while its turns show eleven.
      const filesFromMappings = Array.from(new Set(
        mappings.flatMap((m: any) => (Array.isArray(m?.filesChanged) ? m.filesChanged : [])),
      ));
      const sessionFiles: string[] = state.filesChanged?.length
        ? state.filesChanged
        : filesFromMappings;
      // Same story for the line counts: without them the session header reads
      // "0 files, +0 −0" above a turn card showing +247 −2, which is the
      // surfaces-disagree shape that reads as a capture failure. Summing turns
      // counts churn (a line rewritten twice counts twice) where a session-level
      // diff would net it out — but it is the only rollup available here, it is
      // exact for the single-turn case, and it agrees with the turns on screen.
      const sumMappings = (key: 'linesAdded' | 'linesRemoved'): number =>
        mappings.reduce((n: number, m: any) => n + (typeof m?.[key] === 'number' ? m[key] : 0), 0);
      const sessionLinesAdded: number = state.linesAdded > 0
        ? state.linesAdded : sumMappings('linesAdded');
      const sessionLinesRemoved: number = state.linesRemoved > 0
        ? state.linesRemoved : sumMappings('linesRemoved');
      const updatePayload: Record<string, unknown> = {
        prompt: promptText || undefined,
        agentSlug: state.agentSlug || undefined,
        model: state.model || undefined,
        branch: state.branch || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        filesChanged: sessionFiles.length > 0 ? sessionFiles : undefined,
        linesAdded: sessionLinesAdded > 0 ? sessionLinesAdded : undefined,
        linesRemoved: sessionLinesRemoved > 0 ? sessionLinesRemoved : undefined,
        tokensUsed: state.tokensUsed > 0 ? state.tokensUsed : undefined,
        inputTokens: state.inputTokens > 0 ? state.inputTokens : undefined,
        outputTokens: state.outputTokens > 0 ? state.outputTokens : undefined,
        costUsd: state.costUsd > 0 ? state.costUsd : undefined,
        promptChanges: mappings.length > 0 ? mappings : undefined,
      };
      const hasCapture = Object.entries(updatePayload)
        .some(([k, v]) => k !== 'prompt' && k !== 'agentSlug' && k !== 'model'
          && k !== 'branch' && k !== 'durationMs' && v !== undefined);
      if (hasCapture) {
        // durableUpdateSession queues the payload in ~/.origin/queue on a
        // retriable failure and returns null. Either way the capture is no
        // longer only in this file, so unlinking below is safe; a hard failure
        // still throws and keeps the file for the next run.
        const res = await durableUpdateSession(realSessionId, updatePayload, debugLog);
        debugLog('sessions-sync', res === null ? 'capture queued for retry' : 'capture uploaded', {
          sessionId: realSessionId,
          files: state.filesChanged?.length || 0,
          promptChanges: mappings.length,
        });
      }

      await api.endSession({
        sessionId: realSessionId,
        prompt: promptText || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        branch: state.branch || undefined,
      });
      fs.unlinkSync(filePath);
      if (!opts.quiet) console.log(chalk.green(`  ✓  ${label}`));
      result.synced++;
    } catch (err: any) {
      // Started but couldn't finalize — leave the file so a future run retries.
      if (!opts.quiet) console.log(chalk.red(`  ✗  ${label} — end failed: ${err.message}`));
      result.failed++;
    }
  }

  if (!opts.quiet) {
    console.log();
    console.log(chalk.bold(`Resynced: ${chalk.green(result.synced)}  ·  Still blocked: ${chalk.yellow(result.blocked)}  ·  Failed: ${chalk.red(result.failed)}`));
  }
  return result;
}

/** Atomically (tmp-write + rename) persist a queued session's state to disk.
 *  Returns true on success. Used by import's re-tag / revert so a crash mid
 *  write can never truncate the only copy of a session. */
function writeSessionFileAtomic(filePath: string, state: unknown): boolean {
  try {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * `origin sessions import` — claim queued sessions captured under a PREVIOUS
 * account into the current one. Re-stamps each foreign session's owner to the
 * active account so the sync gate lets them through, then uploads them via the
 * normal resync path. This is the "Yes, bring my old work over" choice.
 *
 * The web intent + dashboard banner are only cleared when the import actually
 * DRAINS the foreign set (every session uploaded). If the agent is disabled or
 * the server is unreachable, the un-uploaded sessions are reverted to their
 * original foreign owner so they (a) stay in the import set for the next retry
 * and (b) keep the banner up — instead of silently dropping the "import not
 * finished" signal while the work sits unsent.
 */
export async function sessionsImportCommand(): Promise<{ synced: number; blocked: number; failed: number; cleared: boolean }> {
  const noop = { synced: 0, blocked: 0, failed: 0, cleared: false };
  if (!isConnectedMode()) {
    console.log(chalk.gray('Standalone mode — nothing to import.'));
    return noop;
  }
  const owner = currentOwner();
  if (!owner) {
    console.log(chalk.yellow('Not logged in — run `origin login` first.'));
    return noop;
  }
  const foreign = listForeignQueuedSessions(owner);
  if (foreign.length === 0) {
    console.log(chalk.gray('No sessions from a previous account to import.'));
    // Nothing pending on THIS machine (e.g. the choice was made on another
    // machine) — clear the intent so it doesn't re-fire here every status.
    await reportForeignSessionCount(true);
    return { ...noop, cleared: true };
  }

  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  console.log(chalk.bold(`Importing ${foreign.length} session${foreign.length === 1 ? '' : 's'} into this account...\n`));

  // Remember each file's ORIGINAL owner so we can put it back if its upload
  // doesn't go through. A re-tagged-but-unuploaded session must stay FOREIGN —
  // otherwise it drops out of the import set and the banner clears even though
  // the work never reached the account.
  const original = foreign.map(({ file, state }) => ({
    file,
    ownerOrgId: state.ownerOrgId as string | undefined,
    ownerKeyHash: state.ownerKeyHash as string | undefined,
  }));

  // Re-stamp each foreign session to the current owner so sessionsSyncCommand's
  // ownership gate lets it through and uploads it.
  for (const { file, state } of foreign) {
    state.ownerOrgId = owner.ownerOrgId;
    state.ownerKeyHash = owner.ownerKeyHash;
    if (!writeSessionFileAtomic(path.join(sessionsDir, file), state)) {
      console.log(chalk.red(`  ✗  ${file} — could not re-tag`));
    }
  }

  const result = await sessionsSyncCommand({ quiet: false, markImported: true });
  const drained = result.blocked === 0 && result.failed === 0;

  // Revert any session that did NOT upload (still on disk) back to its original
  // foreign owner. Successful uploads were already removed by the sync, so this
  // only touches the blocked/failed leftovers.
  if (!drained) {
    for (const o of original) {
      const p = path.join(sessionsDir, o.file);
      if (!fs.existsSync(p)) continue; // uploaded + removed
      try {
        const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
        state.ownerOrgId = o.ownerOrgId;
        state.ownerKeyHash = o.ownerKeyHash;
        writeSessionFileAtomic(p, state);
      } catch {
        // Unreadable JSON (shouldn't happen — we just wrote it). Leave the file
        // tagged to the current owner; it falls back to the task's other path —
        // a normal `origin sessions sync` uploads it later — rather than staying
        // foreign. No data loss, just no banner signal for this one file.
      }
    }
    console.log(chalk.yellow(`\n  Some sessions weren't uploaded (agent disabled or offline) — they'll be retried on the next \`origin status\`.`));
  }

  // Report the real remaining count and clear the web intent ONLY when the set
  // fully drained. On a partial import the leftovers are foreign again, so this
  // reports a non-zero count (banner stays up) and leaves the intent set.
  await reportForeignSessionCount(drained);
  return { synced: result.synced, blocked: result.blocked, failed: result.failed, cleared: drained };
}

/**
 * `origin sessions forget` — discard queued sessions captured under a PREVIOUS
 * account. This is the "No, only track new sessions from now on" choice; the
 * local files are deleted and never uploaded.
 */
export async function sessionsForgetCommand(): Promise<void> {
  const owner = currentOwner();
  const foreign = listForeignQueuedSessions(owner);
  if (foreign.length === 0) {
    console.log(chalk.gray('No sessions from a previous account to forget.'));
    return;
  }
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  let removed = 0;
  for (const { file } of foreign) {
    try { fs.unlinkSync(path.join(sessionsDir, file)); removed++; } catch { /* already gone */ }
  }
  console.log(chalk.green(`Discarded ${removed} session${removed === 1 ? '' : 's'} from a previous account.`));
  // Update the dashboard banner (count → 0) and clear any pending web intent.
  await reportForeignSessionCount(true);
}

/**
 * Carry out a web-initiated choice. The dashboard banner can set a pending
 * action ('import' | 'forget') server-side; the CLI learns it when it reports
 * its foreign-session count, then executes it against the local files here.
 * Called from `origin status` and `origin login` — the reliable, awaited entry
 * points. Best-effort and quiet about the no-op case.
 */
export async function processPendingForeignAction(): Promise<void> {
  if (!isConnectedMode()) return;
  const pending = await reportForeignSessionCount();
  if (pending !== 'import' && pending !== 'forget') return;

  console.log(chalk.gray(`\n  Applying your dashboard choice: ${pending} previous-account sessions...`));
  // Each command reports the accurate remaining count and clears the web intent
  // ITSELF — but only when the work is actually done (import: every session
  // uploaded; forget: files deleted; no-op: nothing local to act on). We must
  // NOT add an unconditional clear here: on a partial import (agent disabled /
  // offline) it would wipe the intent and the banner, losing the retry.
  if (pending === 'import') await sessionsImportCommand();
  else await sessionsForgetCommand();
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
