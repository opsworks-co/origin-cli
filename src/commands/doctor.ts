import chalk from 'chalk';
import { listSessionIds, readSessionFile } from '../session-store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { git, gitDetailed } from '../utils/exec.js';
import { loadConfig, isConnectedMode } from '../config.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
import { loadSessionState, clearSessionState, getGitRoot, getGitDir, listActiveSessions, getStatePath, type SessionState } from '../session-state.js';
import { parentLooksDead, transcriptIdleWindowMs } from '../heartbeat-liveness.js';
import { captureGitState } from '../git-capture.js';
import { writeSessionFiles } from '../local-entrypoint.js';
import { api } from '../api.js';

/**
 * The liveness signals `doctor` can see for a session, in the shape
 * parentLooksDead expects.
 *
 * Doctor sees FEWER signals than the heartbeat does: there is no recorded pid
 * on a state file, so pass 0 — "unknown", which the predicate treats as absence
 * of a live-process signal rather than as proof of death, falling back to the
 * staleness clauses it keeps for exactly that case.
 *
 * Every unreadable path resolves to "not stale". A path we cannot stat is no
 * signal at all, and the one thing this must never do is let a missing file
 * read as evidence a session is dead — that is how a live conversation gets
 * deleted. Exported for testing.
 */
export function doctorLivenessInputs(st: SessionState, cwd?: string) {
  const windowMs = transcriptIdleWindowMs(st.agentSlug || '');
  const staleBeyond = (p: string | undefined): boolean => {
    if (!p) return false;
    try { return Date.now() - fs.statSync(p).mtimeMs > windowMs; } catch { return false; }
  };
  let statePath: string | undefined;
  try { statePath = getStatePath(st.repoPath || cwd, st.sessionTag); } catch { statePath = undefined; }
  // Freshness and staleness are NOT complements here, because a third state
  // exists: no file. Absence is no signal in either direction, and conflating it
  // with either one breaks a different half of this command.
  //
  //   stale   = the file EXISTS and has not been touched inside the window
  //   fresh   = the file EXISTS and HAS been touched inside the window
  //   missing = neither
  //
  // Treating missing as "not stale" is right — it must never read as proof of
  // death. Treating it as "actively writing" is what this got wrong: a session
  // over a day old has usually had its transcript rotated away, so a missing
  // file claimed positive proof of life and vetoed every death signal. That made
  // the sweep unable to clean the exact sessions it exists for — 129 of 294 on
  // the machine this was measured on. With absence neutral, such a session falls
  // through to the state-file clause, which is the signal that actually applies.
  const freshWithin = (p: string | undefined): boolean => {
    if (!p) return false;
    try { return Date.now() - fs.statSync(p).mtimeMs <= windowMs; } catch { return false; }
  };
  return {
    recordedParentPid: 0,
    recordedParentAlive: false,
    transcriptStale: staleBeyond(st.transcriptPath),
    stateFileStale: staleBeyond(statePath),
    // A warm transcript is positive proof of life and vetoes every death signal.
    agentActivelyWriting: freshWithin(st.transcriptPath),
  };
}

/**
 * Positive evidence that a session is live RIGHT NOW.
 *
 * Deliberately not `!parentLooksDead(...)`. That predicate answers "may I end
 * this session?", and its default on no evidence is NO — correct there, because
 * ending destroys state a live agent is still writing. Reused for "may I delete
 * this file?" it inverts into a bug: a session whose transcript AND state file
 * are both long gone offers no evidence of anything, so it reads as alive and is
 * preserved forever. The sweep then reports files it will never clean — 128 of
 * 294 here — which is a cleanup that cannot clean.
 *
 * So the two questions get their own defaults. Ending needs proof of DEATH;
 * deleting a file needs the absence of proof of LIFE, which is what this is:
 * either warm surface (the file itself, or the agent's transcript) counts.
 * The state file is rewritten on every lifecycle hook, so a live session keeps
 * it warm — this session's own was under a minute old while it ran.
 */
export function looksActiveNow(content: SessionState, filePath: string): boolean {
  const windowMs = transcriptIdleWindowMs(content.agentSlug || '');
  const fresh = (p: string | undefined): boolean => {
    if (!p) return false;
    try { return Date.now() - fs.statSync(p).mtimeMs <= windowMs; } catch { return false; }
  };
  return fresh(filePath) || fresh(content.transcriptPath);
}

/** True when this session file is the ONLY copy of a session the server has never seen. */
export function isNeverUploaded(content: { sessionId?: unknown; syncedSessionId?: unknown }): boolean {
  return String(content?.sessionId || '').startsWith('local-') && !content?.syncedSessionId;
}


/**
 * origin doctor
 *
 * Scans for and fixes stuck/orphaned session states — similar to Entire's `doctor`.
 *
 * Checks:
 *  1. Stale session state in .git/origin-session.json (session > 24h old)
 *  2. Orphaned session files in ~/.origin/sessions/
 *  3. Hook installation health
 */
export async function doctorCommand(opts?: { fix?: boolean; verbose?: boolean }) {
  const config = loadConfig();
  console.log(chalk.bold('\n  Origin Doctor\n'));

  let issues = 0;
  let fixed = 0;

  // 1. Check current repo for stale session state
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (repoPath) {
    const state = loadSessionState(cwd);
    if (state) {
      const ageMs = Date.now() - new Date(state.startedAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);

      if (ageHours > 24) {
        issues++;
        console.log(chalk.yellow(`  ⚠ Stale session in ${repoPath}`));
        console.log(chalk.gray(`    Session ${state.sessionId} started ${ageHours.toFixed(1)}h ago`));

        if (opts?.fix) {
          clearSessionState(cwd);
          fixed++;
          console.log(chalk.green(`    ✓ Cleared stale session state`));
        } else {
          console.log(chalk.gray(`    Run with --fix to clear`));
        }
      } else {
        console.log(chalk.green(`  ✓ Active session looks healthy (${Math.round(ageHours * 60)}m old)`));
      }
    } else {
      console.log(chalk.green(`  ✓ No active session in current repo`));
    }

    // 1b. Stuck session detection: old AND showing no sign of life.
    //
    // Age alone is not evidence of anything. This filtered on `age > 1hr` and
    // nothing else, while --fix writes a zeroed `ended` record over the session
    // and clears its state — so ANY conversation running longer than an hour was
    // a deletion target. Caught in the act: a doctor run listed the very session
    // that was running it (19 prompts in, transcript touched seconds earlier) as
    // "stuck — 5.9h", alongside a second live agent at 16 prompts.
    //
    // The codebase already had the answer and this command was not using it:
    // parentLooksDead is the shared, unit-tested predicate the heartbeat reaps
    // on, and its comments record the bias that matters here — reaping a live
    // session corrupts the record, while a zombie lingering costs a stale row
    // the server's own sweep clears. Fresh transcript activity vetoes every
    // death signal.
    //
    // Doctor sees fewer signals than the heartbeat: there is no recorded pid on
    // the state file, so pass 0 (unknown, not dead) and let the predicate fall
    // back to the staleness clauses it keeps for exactly that case.
    const activeSessions = listActiveSessions(cwd);
    const stuckSessions = activeSessions.filter(s => {
      const ageMs = Date.now() - new Date(s.startedAt).getTime();
      if (ageMs <= 60 * 60 * 1000) return false;   // still young — never stuck
      return parentLooksDead(doctorLivenessInputs(s, cwd));
    });

    if (stuckSessions.length > 0) {
      issues += stuckSessions.length;
      console.log(chalk.yellow(`  ⚠ ${stuckSessions.length} stuck session${stuckSessions.length !== 1 ? 's' : ''} (>1hr old):`));
      for (const s of stuckSessions) {
        const ageHrs = (Date.now() - new Date(s.startedAt).getTime()) / (1000 * 60 * 60);
        console.log(chalk.gray(`    ${s.sessionId.slice(0, 8)} — ${s.model} — ${ageHrs.toFixed(1)}h`));
        if (opts?.verbose) {
          console.log(chalk.gray(`      Branch: ${s.branch || 'unknown'}, Prompts: ${s.prompts.length}`));
        }
      }
      if (opts?.fix) {
        for (const s of stuckSessions) {
          // Finalize session: write ended metadata with git capture data
          try {
            const gitCapture = captureGitState(s.repoPath || repoPath!, s.headShaAtStart);
            const durationMs = Date.now() - new Date(s.startedAt).getTime();
            writeSessionFiles(s.repoPath || repoPath!, {
              sessionId: s.sessionId,
              model: s.model,
              startedAt: s.startedAt,
              endedAt: new Date().toISOString(),
              durationMs,
              status: 'ended',
              costUsd: 0,
              tokensUsed: 0,
              inputTokens: 0,
              outputTokens: 0,
              toolCalls: 0,
              linesAdded: gitCapture.linesAdded || 0,
              linesRemoved: gitCapture.linesRemoved || 0,
              prompts: s.prompts?.map((text, i) => ({ index: i, text, filesChanged: [] })) || [],
              filesChanged: gitCapture.commitDetails?.flatMap(c => c.filesChanged) || [],
              git: {
                branch: s.branch || '',
                headBefore: s.headShaAtStart || '',
                headAfter: gitCapture.headAfter || '',
                commitShas: gitCapture.commitShas || [],
              },
              summary: '',
              originUrl: '',
              changes: [],
            });
          } catch { /* best effort */ }
          clearSessionState(cwd, s.sessionTag);
          fixed++;
        }
        console.log(chalk.green(`    ✓ Cleared ${stuckSessions.length} stuck session${stuckSessions.length !== 1 ? 's' : ''}`));
      } else {
        console.log(chalk.gray(`    Run with --fix to clear`));
      }
    } else if (opts?.verbose) {
      console.log(chalk.green(`  ✓ No stuck sessions`));
    }

    // 1c. Fix stale "running" sessions on origin-sessions branch + orphaned entries
    try {
      const gitOpts = { cwd: repoPath };
      // Empty is fine: the loop no-ops and the reports below are count-guarded.
      const sessionDirs = listSessionIds(repoPath).map((id) => `sessions/${id}`);
      let orphanedEntries = 0;
      let staleRunning = 0;

      // Get active session IDs to avoid marking the current session as ended
      const activeIds = new Set(activeSessions.map(s => s.sessionId));

      for (const dir of sessionDirs) {
        try {
          if (!/^sessions\/[a-zA-Z0-9_.-]+$/.test(dir)) continue;
          const metaRaw = (readSessionFile(repoPath, dir.replace('sessions/', ''), 'metadata.json') ?? '').trim();
          const metadata = JSON.parse(metaRaw);

          // Check for "running" sessions that are no longer active (no state file)
          if (metadata.status === 'running' && !activeIds.has(metadata.sessionId)) {
            const ageMs = Date.now() - new Date(metadata.startedAt).getTime();
            if (ageMs > 60 * 60 * 1000) { // >1hr old
              staleRunning++;
              if (opts?.verbose) {
                const ageHrs = ageMs / (1000 * 60 * 60);
                console.log(chalk.gray(`    Stale running: ${dir} — ${metadata.model} — ${ageHrs.toFixed(1)}h`));
              }
              if (opts?.fix) {
                // End session on platform API first
                if (isConnectedMode()) {
                  try {
                    await api.endSession({
                      sessionId: metadata.sessionId,
                      durationMs: ageMs,
                      branch: metadata.git?.branch || undefined,
                    });
                  } catch {
                    // Session may not exist on platform — that's OK
                  }
                }

                // Rewrite metadata with status: 'ended' — use existing metadata values,
                // only try captureGitState as a fallback for missing data
                let gitCapture: ReturnType<typeof captureGitState> | null = null;
                try {
                  gitCapture = captureGitState(repoPath, metadata.git?.headBefore || null);
                } catch { /* git state capture failed — use metadata as-is */ }
                try {
                  writeSessionFiles(repoPath, {
                    sessionId: metadata.sessionId,
                    model: metadata.model,
                    startedAt: metadata.startedAt,
                    endedAt: new Date().toISOString(),
                    durationMs: ageMs,
                    status: 'ended',
                    costUsd: metadata.cost?.usd || 0,
                    tokensUsed: metadata.tokens?.total || 0,
                    inputTokens: metadata.tokens?.input || 0,
                    outputTokens: metadata.tokens?.output || 0,
                    toolCalls: metadata.toolCalls || 0,
                    linesAdded: metadata.lines?.added || gitCapture?.linesAdded || 0,
                    linesRemoved: metadata.lines?.removed || gitCapture?.linesRemoved || 0,
                    prompts: metadata.prompts || [],
                    filesChanged: metadata.filesChanged?.length > 0
                      ? metadata.filesChanged
                      : (gitCapture?.commitDetails?.flatMap((c: any) => c.filesChanged) || []),
                    git: metadata.git || { branch: '', headBefore: '', headAfter: '', commitShas: [] },
                    summary: metadata.summary || '',
                    originUrl: metadata.originUrl || '',
                    changes: [],
                  });
                  fixed++;
                } catch {
                  if (opts?.verbose) {
                    console.log(chalk.red(`    ✗ Failed to fix ${dir}`));
                  }
                }
              }
            }
          }

          // Check for orphaned entries (referencing non-existent commits)
          const headAfter = metadata.git?.headAfter;
          if (headAfter) {
            if (!HEX.test(headAfter)) {
              orphanedEntries++;
              if (opts?.verbose) {
                console.log(chalk.gray(`    Orphaned: ${dir} (invalid sha)`));
              }
              continue;
            }
            const r = gitDetailed(['cat-file', '-t', headAfter], gitOpts);
            if (r.status !== 0) {
              orphanedEntries++;
              if (opts?.verbose) {
                console.log(chalk.gray(`    Orphaned: ${dir} (commit ${headAfter.slice(0, 8)} not found)`));
              }
            }
          }
        } catch { /* skip unreadable */ }
      }

      if (staleRunning > 0) {
        issues += staleRunning;
        console.log(chalk.yellow(`  ⚠ ${staleRunning} session${staleRunning !== 1 ? 's' : ''} stuck as "running" on origin-sessions branch`));
        if (opts?.fix) {
          console.log(chalk.green(`    ✓ Marked ${staleRunning} as ended`));
        } else {
          console.log(chalk.gray(`    Run with --fix to mark as ended`));
        }
      }

      if (orphanedEntries > 0) {
        issues++;
        console.log(chalk.yellow(`  ⚠ ${orphanedEntries} orphaned origin-sessions entries (referencing non-existent commits)`));
      } else if (opts?.verbose) {
        console.log(chalk.green(`  ✓ All origin-sessions entries reference valid commits`));
      }
    } catch {
      if (opts?.verbose) {
        console.log(chalk.gray(`  No origin-sessions branch to check`));
      }
    }
  } else {
    console.log(chalk.gray('  Not in a git repo, skipping session check'));
  }

  // 2. Check for orphaned session files in ~/.origin/sessions/
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    let orphaned = 0;
    // Files deliberately kept back — reported, because silently retaining them
    // reads as "nothing to clean" when the truth is "this is not garbage".
    let preserved = 0;

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
        const ageMs = Date.now() - new Date(content.startedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        // "Older than a day" was the ENTIRE test, and deletion is permanent.
        //
        // A `local-*` id that never got a syncedSessionId is a session that has
        // never reached the server: this file is the only copy of it, and it is
        // waiting for `origin sessions sync` to replay it. Age is precisely
        // what such a session accumulates while the queue is blocked — an
        // outage, a bad key, a machine that was offline — so the old rule
        // deleted exactly the backlog it was meant to survive. On this machine
        // that was 33 of 294 files.
        //
        // A still-live session is skipped for the same reason as the stuck
        // check above: its transcript is warm, so it is not garbage.
        const neverUploaded = isNeverUploaded(content);
        const stillAlive = looksActiveNow(content as SessionState, path.join(sessionsDir, file));
        if (ageHours > 24 && !neverUploaded && !stillAlive) {
          orphaned++;
          if (opts?.fix) {
            fs.unlinkSync(path.join(sessionsDir, file));
            fixed++;
          }
        } else if (neverUploaded) {
          preserved++;
        }
      } catch {
        orphaned++;
        if (opts?.fix) {
          try { fs.unlinkSync(path.join(sessionsDir, file)); fixed++; } catch { /* ignore */ }
        }
      }
    }

    if (orphaned > 0) {
      issues += orphaned;
      console.log(chalk.yellow(`  ⚠ ${orphaned} orphaned session file${orphaned !== 1 ? 's' : ''} in ~/.origin/sessions/`));
      if (opts?.fix) {
        console.log(chalk.green(`    ✓ Cleaned up`));
      } else {
        console.log(chalk.gray(`    Run with --fix to clean up`));
      }
    } else {
      console.log(chalk.green(`  ✓ No orphaned session files`));
    }
    if (preserved > 0) {
      console.log(chalk.gray(`    ${preserved} kept — never uploaded, pending \`origin sessions sync\``));
    }
  }

  // 3. Check for stale .git/origin-session.json in repos with git dirs
  if (repoPath) {
    const gitDir = getGitDir(cwd);
    if (gitDir) {
      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
      const stateFile = path.join(resolvedGitDir, 'origin-session.json');
      if (fs.existsSync(stateFile)) {
        try {
          const content = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          const ageMs = Date.now() - new Date(content.startedAt).getTime();
          if (ageMs > 48 * 60 * 60 * 1000) {
            issues++;
            console.log(chalk.yellow(`  ⚠ Very stale session file: ${stateFile}`));
            if (opts?.fix) {
              fs.unlinkSync(stateFile);
              fixed++;
              console.log(chalk.green(`    ✓ Removed`));
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  // 4. Check hooks log for recent errors
  const hooksLog = path.join(os.homedir(), '.origin', 'hooks.log');
  if (fs.existsSync(hooksLog)) {
    try {
      const logContent = fs.readFileSync(hooksLog, 'utf-8');
      const lines = logContent.split('\n').filter(l => l.includes('ERROR'));
      const recentErrors = lines.filter(l => {
        const match = l.match(/\[([\d-T:.Z]+)\]/);
        if (!match) return false;
        const logTime = new Date(match[1]).getTime();
        return Date.now() - logTime < 24 * 60 * 60 * 1000;
      });

      if (recentErrors.length > 0) {
        issues++;
        console.log(chalk.yellow(`  ⚠ ${recentErrors.length} hook error${recentErrors.length !== 1 ? 's' : ''} in the last 24h`));
        // Show last 3 errors
        for (const err of recentErrors.slice(-3)) {
          const short = err.slice(0, 120);
          console.log(chalk.gray(`    ${short}`));
        }
      } else {
        console.log(chalk.green(`  ✓ No recent hook errors`));
      }

      // Check log size
      const stats = fs.statSync(hooksLog);
      if (stats.size > 10 * 1024 * 1024) {
        issues++;
        console.log(chalk.yellow(`  ⚠ Hooks log is ${(stats.size / 1024 / 1024).toFixed(1)}MB — consider rotating`));
        if (opts?.fix) {
          // Keep last 1000 lines
          const allLines = logContent.split('\n');
          const trimmed = allLines.slice(-1000).join('\n');
          fs.writeFileSync(hooksLog, trimmed);
          fixed++;
          console.log(chalk.green(`    ✓ Trimmed to last 1000 lines`));
        }
      }
    } catch { /* ignore */ }
  }

  // 5. Check API connection
  if (config) {
    try {
      const res = await fetch(`${config.apiUrl}/api/mcp/policies`, {
        headers: { 'X-API-Key': config.apiKey },
      });
      if (res.ok) {
        console.log(chalk.green(`  ✓ API connection healthy`));
      } else {
        issues++;
        console.log(chalk.red(`  ✗ API returned ${res.status} — check API key`));
      }
    } catch {
      issues++;
      console.log(chalk.red(`  ✗ Cannot reach Origin API at ${config.apiUrl}`));
    }
  } else {
    console.log(chalk.green(`  ✓ Standalone mode — sessions tracked locally in git`));
    console.log(chalk.gray(`    Run ${chalk.white('origin login')} to connect to Origin platform`));
  }

  // Agent hook configs. `enable` writes these once and nothing ever revisits
  // them, so a hook SCHEMA fix (or a moved origin binary) leaves every existing
  // install stranded. When an agent rejects its hook config it captures nothing
  // and reports nothing — Antigravity discards the whole file over a single bad
  // event shape — so this is the check that turns silent zero-capture into a
  // line the user can act on.
  console.log(chalk.bold('\n  Agent hook configs\n'));
  try {
    const { hookConfigBases, checkHookConfigs, repairHookConfig, isRepairable } =
      await import('../hook-config-health.js');

    let installed = 0;
    let drifted = 0;
    for (const base of hookConfigBases(cwd)) {
      const where = base === os.homedir() ? 'global' : base.replace(os.homedir(), '~');
      for (const report of checkHookConfigs(base)) {
        if (report.state === 'absent') continue;
        installed++;
        if (!isRepairable(report.state)) {
          if (opts?.verbose) {
            console.log(chalk.green(`  ✓ ${report.agentName} · ${report.label} (${where})`));
          }
          continue;
        }
        drifted++;
        issues++;
        const why = report.state === 'relocated'
          ? 'points at an origin path that has moved'
          : report.state === 'unreadable'
            ? 'the file is not valid JSON'
            : `does not match this CLI${report.detail ? ` (${report.detail})` : ''}`;
        // Only a schema mismatch risks the agent throwing the file out.
        const paint = report.state === 'relocated' ? chalk.gray : chalk.yellow;
        console.log(paint(`  ⚠ ${report.agentName} · ${report.label} (${where}) — ${why}`));
        if (report.state === 'stale') {
          console.log(chalk.gray(`    The agent may be discarding it, in which case nothing is being captured.`));
        }
        if (opts?.fix) {
          try {
            repairHookConfig(report);
            fixed++;
            console.log(chalk.green(`    ✓ Rewritten`));
          } catch (err: any) {
            console.log(chalk.red(`    ✗ Could not rewrite: ${err?.message || err}`));
          }
        }
      }
    }

    if (installed === 0) {
      console.log(chalk.gray(`  No agent hooks installed — run ${chalk.white('origin enable')}`));
    } else if (drifted === 0) {
      console.log(chalk.green(`  ✓ All ${installed} hook config${installed === 1 ? '' : 's'} match this CLI`));
    } else if (!opts?.fix) {
      console.log(chalk.gray(`    Run ${chalk.white('origin doctor --fix')} (or ${chalk.white('origin hooks repair')}) to rewrite them.`));
    }
  } catch (err) {
    console.log(chalk.gray(`  – Could not check hook configs: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Capture daemons. GUI agents (Cursor, Claude Code on Windows, Gemini,
  // Copilot) fire no hooks, so these watchers ARE the capture path — and when
  // one dies the only symptom is sessions quietly not appearing. Nothing
  // surfaced that until now: `origin upgrade` only ever looked at the version,
  // and a dead daemon looked exactly like a quiet afternoon.
  console.log(chalk.bold('\n  Capture daemons\n'));
  try {
    const { watchHealth, STALLED_AFTER_MS } = await import('../watch-meta.js');
    const tw = await import('../transcript-watch.js');
    const cw = await import('../codex-watch.js');
    const daemons = [
      {
        label: 'Transcript watcher (Cursor / Claude / Gemini / Copilot)',
        pidFile: tw.watchPidFile(),
        enabled: tw.transcriptWatchAutoStartEnabled(),
        revive: tw.ensureTranscriptWatchRunning,
      },
      {
        label: 'Codex watcher',
        pidFile: cw.watchPidFile(),
        enabled: cw.codexWatchAutoStartEnabled(),
        revive: cw.ensureCodexWatchRunning,
      },
    ];

    for (const d of daemons) {
      if (!d.enabled) {
        console.log(chalk.gray(`  – ${d.label}: not auto-started on this platform`));
        continue;
      }
      const h = watchHealth(d.pidFile);
      const age = (ms?: number) => (ms === undefined ? 'unknown' : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);

      if (h.state === 'ok') {
        console.log(chalk.green(`  ✓ ${d.label}`));
        console.log(chalk.gray(`    pid ${h.pid} · v${h.version} · last poll ${age(h.sinceLastCycleMs)}`));
        continue;
      }
      if (h.state === 'stale-build') {
        console.log(chalk.yellow(`  ⚠ ${d.label} — running an older build (v${h.version})`));
        console.log(chalk.gray(`    Capturing fine, but on stale code. ${chalk.white('origin upgrade')} cycles it.`));
        continue;
      }
      if (h.state === 'stopped') {
        issues++;
        console.log(chalk.yellow(`  ⚠ ${d.label} — not running`));
        console.log(chalk.gray(`    No sessions are being captured for those agents. ${chalk.white('origin enable')} starts it.`));
        continue;
      }

      // dead / stalled — capture is silently down.
      issues++;
      const why = h.state === 'dead'
        ? `its process is gone (pid ${h.pid})`
        : `it stopped polling ${age(h.sinceLastCycleMs)} (pid ${h.pid} still up)`;
      console.log(chalk.red(`  ✗ ${d.label} — DEAD: ${why}`));
      console.log(chalk.gray(`    Nothing has been captured for those agents since then.`));
      if (opts?.fix) {
        const res = d.revive();
        if (res.started) {
          fixed++;
          console.log(chalk.green(`    ✓ Restarted it`));
        } else {
          console.log(chalk.yellow(`    Could not restart: ${res.reason}`));
        }
      }
      void STALLED_AFTER_MS;
    }
  } catch (err) {
    console.log(chalk.gray(`  – Could not read watcher health: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Summary
  console.log('');
  if (issues === 0) {
    console.log(chalk.green('  All checks passed!'));
  } else if (opts?.fix) {
    console.log(chalk.green(`  Fixed ${fixed} of ${issues} issue${issues !== 1 ? 's' : ''}`));
  } else {
    console.log(chalk.yellow(`  Found ${issues} issue${issues !== 1 ? 's' : ''}. Run ${chalk.white('origin doctor --fix')} to auto-fix.`));
  }
  console.log('');
}
