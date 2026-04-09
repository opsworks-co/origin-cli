import chalk from 'chalk';
import { execSync } from 'child_process';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot, listActiveSessions, listAllActiveSessions, clearSessionState, stopHeartbeat, isHeartbeatAlive } from '../session-state.js';

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
}

function listLocalSessions(repoPath: string): LocalSession[] {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const sessions: LocalSession[] = [];

  try {
    // Check if origin-sessions branch exists
    execSync('git rev-parse refs/heads/origin-sessions', execOpts);
  } catch {
    return sessions;
  }

  try {
    // List session directories on the origin-sessions branch
    const raw = execSync('git ls-tree --name-only origin-sessions sessions/', execOpts).trim();
    if (!raw) return sessions;

    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));

    for (const dir of dirs) {
      try {
        const metadataJson = execSync(`git show origin-sessions:sessions/${dir}/metadata.json`, execOpts).trim();
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
          const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) repoName = match[1];
    } catch {}
    const modeLabel = opts.local ? ' (local only)' : '';
    console.log(chalk.bold(`\nSessions${repoName ? ` — ${repoName}` : ''}${modeLabel} (${display.length} total)\n`));
  } else {
    console.log(chalk.bold(`\nSessions — all repos (${display.length} total)\n`));
  }

  for (const entry of display) {
    // Resolve display values from whichever data source is available
    const isLocal = entry.source === 'local' || entry.source === 'both';
    const isPlatform = entry.source === 'origin' || entry.source === 'both';
    const local = entry.local;
    const platform = entry.platform;

    // Session ID
    const id = local?.sessionId?.slice(0, 8) || platform?.id?.slice(0, 8) || '????????';

    // Model / agent name
    let displayModel = local?.model || platform?.model || 'unknown';
    if (/^(default|unknown|cursor)$/i.test(displayModel) && platform?.agentName) {
      displayModel = platform.agentName;
    }

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
      try { const f = JSON.parse(platform.filesChanged); files = Array.isArray(f) ? f.length : 0; } catch { files = 0; }
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
      `  ${chalk.dim(id)}`,
      `${chalk.cyan(displayModel.padEnd(25))}`,
      `${statusColor(status.padEnd(12))}`,
      `${String(files).padStart(3)} files`,
      `${chalk.dim('$' + cost.toFixed(2).padStart(6))}`,
      `${chalk.dim(age.padEnd(10))}`,
    ];
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
      const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      const prompts = execSync(`git show origin-sessions:sessions/${session.sessionId}/prompts.md`, execOpts).trim();
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
      const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      const BRANCH = 'origin-sessions';
      // Check if branch exists
      execSync(`git rev-parse refs/heads/${BRANCH}`, execOpts);
      const tree = execSync(`git ls-tree --name-only refs/heads/${BRANCH} sessions/`, execOpts).trim();
      const sessionDirs = tree ? tree.split('\n').filter(Boolean) : [];

      for (const dir of sessionDirs) {
        const safeId = dir.replace('sessions/', '');
        if (safeId === id || safeId.startsWith(id) || id.startsWith(safeId.slice(0, 8))) {
          try {
            const metaRaw = execSync(`git show refs/heads/${BRANCH}:${dir}/metadata.json`, execOpts).trim();
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
        const repoUrl = (() => {
          try {
            return execSync('git remote get-url origin', {
              encoding: 'utf-8',
              cwd: repoPath,
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch { return ''; }
        })();
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
      const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      const BRANCH = 'origin-sessions';

      // Check if branch exists
      execSync(`git rev-parse refs/heads/${BRANCH}`, execOpts);
      const tree = execSync(`git ls-tree --name-only refs/heads/${BRANCH} sessions/`, execOpts).trim();
      if (!tree) return;

      const sessionDirs = tree.split('\n').filter(Boolean);
      const { writeSessionFiles } = await import('../local-entrypoint.js');
      let branchCleaned = 0;

      for (const dir of sessionDirs) {
        try {
          const metaRaw = execSync(`git show refs/heads/${BRANCH}:${dir}/metadata.json`, execOpts).trim();
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
