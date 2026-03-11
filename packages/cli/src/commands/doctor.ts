import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { loadConfig } from '../config.js';
import { loadSessionState, clearSessionState, getGitRoot, getGitDir, listActiveSessions } from '../session-state.js';

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

    // 1b. Stuck session detection (>1hr ACTIVE)
    const activeSessions = listActiveSessions(cwd);
    const stuckSessions = activeSessions.filter(s => {
      const ageMs = Date.now() - new Date(s.startedAt).getTime();
      return ageMs > 60 * 60 * 1000; // >1hr
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

    // 1c. Orphaned origin-sessions entries (referencing non-existent commits)
    try {
      const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      // Check if origin-sessions branch exists
      execSync('git rev-parse refs/heads/origin-sessions', execOpts);

      const tree = execSync(
        'git ls-tree --name-only refs/heads/origin-sessions sessions/',
        execOpts,
      ).trim();
      const sessionDirs = tree ? tree.split('\n').filter(Boolean) : [];
      let orphanedEntries = 0;

      for (const dir of sessionDirs) {
        try {
          const metaRaw = execSync(
            `git show refs/heads/origin-sessions:${dir}/metadata.json`,
            execOpts,
          ).trim();
          const metadata = JSON.parse(metaRaw);
          const headAfter = metadata.git?.headAfter;
          if (headAfter) {
            try {
              execSync(`git cat-file -t ${headAfter}`, execOpts);
            } catch {
              orphanedEntries++;
              if (opts?.verbose) {
                console.log(chalk.gray(`    Orphaned: ${dir} (commit ${headAfter.slice(0, 8)} not found)`));
              }
            }
          }
        } catch { /* skip unreadable */ }
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

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
        const ageMs = Date.now() - new Date(content.startedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        if (ageHours > 24) {
          orphaned++;
          if (opts?.fix) {
            fs.unlinkSync(path.join(sessionsDir, file));
            fixed++;
          }
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
    issues++;
    console.log(chalk.yellow(`  ⚠ Not logged in — run: origin login`));
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
