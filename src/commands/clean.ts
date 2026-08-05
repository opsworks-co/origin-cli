import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getGitRoot, getGitDir, listActiveSessions } from '../session-state.js';

/**
 * origin clean [--dry-run] [--force]
 *
 * Remove orphaned origin-sessions entries, stale .git/origin-session*.json,
 * temp index files, old hooks.log (>7d).
 *
 * Preview mode by default (--dry-run). Use --force to actually delete.
 */
export async function cleanCommand(opts?: { dryRun?: boolean; force?: boolean }): Promise<void> {
  const isDryRun = opts?.force ? false : true; // Preview by default unless --force
  const mode = isDryRun ? chalk.yellow('(dry run)') : chalk.red('(removing)');

  console.log(chalk.bold(`\n  Origin Clean ${mode}\n`));

  let totalFound = 0;
  let totalRemoved = 0;

  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const gitDir = getGitDir(cwd);

  // 1. Stale .git/origin-session*.json files (>24h old)
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          const filePath = path.join(resolvedGitDir, entry);
          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const ageMs = Date.now() - new Date(content.startedAt).getTime();
            const ageHours = ageMs / (1000 * 60 * 60);

            if (ageHours > 24) {
              totalFound++;
              console.log(chalk.yellow(`  Stale session file: ${entry} (${ageHours.toFixed(1)}h old)`));
              if (!isDryRun) {
                fs.unlinkSync(filePath);
                totalRemoved++;
                console.log(chalk.green(`    Removed`));
              }
            }
          } catch {
            // Corrupt file — always clean up
            totalFound++;
            console.log(chalk.yellow(`  Corrupt session file: ${entry}`));
            if (!isDryRun) {
              try { fs.unlinkSync(filePath); totalRemoved++; } catch { /* ignore */ }
              console.log(chalk.green(`    Removed`));
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Temp index files (.git/origin-tmp-index-*)
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-tmp-index-')) {
          totalFound++;
          const filePath = path.join(resolvedGitDir, entry);
          console.log(chalk.yellow(`  Temp index file: ${entry}`));
          if (!isDryRun) {
            try { fs.unlinkSync(filePath); totalRemoved++; } catch { /* ignore */ }
            console.log(chalk.green(`    Removed`));
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Orphaned session files in ~/.origin/sessions/
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(sessionsDir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const ageMs = Date.now() - new Date(content.startedAt).getTime();
          const ageHours = ageMs / (1000 * 60 * 60);

          // ── NEVER delete work that only exists here ──────────────────────
          // This deleted ANY state file older than 24h on `startedAt` alone,
          // which is unsafe twice over:
          //
          //  1. A session queued locally because the server was unreachable
          //     (`local-*` id, no syncedSessionId) exists NOWHERE else. The
          //     status banner tells the user to run `origin sessions sync`;
          //     deleting the file first destroys those prompts permanently.
          //  2. `startedAt` measures age, not liveness. A session running for
          //     more than a day — routine for a long agent run — was treated
          //     as orphaned and removed out from under the live agent.
          //
          // Skip both, and judge staleness by last WRITE (mtime) rather than
          // start time so a still-active long session is never a candidate.
          const sid = String(content.sessionId || '');
          const isUnsynced = sid.startsWith('local-') && !content.syncedSessionId;
          const isEnded = String(content.status || '').toUpperCase() === 'ENDED';
          let idleHours = ageHours;
          try { idleHours = (Date.now() - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60); } catch { /* fall back to age */ }
          if (isUnsynced) {
            console.log(chalk.gray(`  Keeping unsynced session: ${file} (run \`origin sessions sync\`)`));
            continue;
          }
          if (!isEnded && idleHours < 24) continue; // still live — leave alone

          if (ageHours > 24) {
            totalFound++;
            console.log(chalk.yellow(`  Orphaned session: ${file} (${ageHours.toFixed(1)}h old)`));
            if (!isDryRun) {
              fs.unlinkSync(filePath);
              totalRemoved++;
              console.log(chalk.green(`    Removed`));
            }
          }
        } catch {
          totalFound++;
          console.log(chalk.yellow(`  Corrupt session: ${file}`));
          if (!isDryRun) {
            try { fs.unlinkSync(filePath); totalRemoved++; } catch { /* ignore */ }
            console.log(chalk.green(`    Removed`));
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 4. Old hooks.log (>7d)
  const hooksLog = path.join(os.homedir(), '.origin', 'hooks.log');
  if (fs.existsSync(hooksLog)) {
    try {
      const stat = fs.statSync(hooksLog);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      const sizeMB = stat.size / (1024 * 1024);

      if (ageDays > 7 || sizeMB > 10) {
        totalFound++;
        const reason = ageDays > 7
          ? `${ageDays.toFixed(1)} days old`
          : `${sizeMB.toFixed(1)}MB`;
        console.log(chalk.yellow(`  Hooks log: ${reason}`));

        if (!isDryRun) {
          // Truncate to last 500 lines instead of deleting
          const content = fs.readFileSync(hooksLog, 'utf-8');
          const lines = content.split('\n');
          if (lines.length > 500) {
            fs.writeFileSync(hooksLog, lines.slice(-500).join('\n'));
            console.log(chalk.green(`    Truncated to last 500 lines`));
          } else {
            fs.unlinkSync(hooksLog);
            console.log(chalk.green(`    Removed`));
          }
          totalRemoved++;
        }
      }
    } catch { /* ignore */ }
  }

  // 5. Old telemetry queue
  const telemetryQueue = path.join(os.homedir(), '.origin', 'telemetry-queue.json');
  if (fs.existsSync(telemetryQueue)) {
    try {
      const stat = fs.statSync(telemetryQueue);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        totalFound++;
        console.log(chalk.yellow(`  Stale telemetry queue (${ageDays.toFixed(1)} days old)`));
        if (!isDryRun) {
          fs.unlinkSync(telemetryQueue);
          totalRemoved++;
          console.log(chalk.green(`    Removed`));
        }
      }
    } catch { /* ignore */ }
  }

  // Summary
  console.log('');
  if (totalFound === 0) {
    console.log(chalk.green('  Nothing to clean up — everything looks good!'));
  } else if (isDryRun) {
    console.log(chalk.yellow(`  Found ${totalFound} item${totalFound !== 1 ? 's' : ''} to clean.`));
    console.log(chalk.white(`  Run ${chalk.cyan('origin clean --force')} to remove them.`));
  } else {
    console.log(chalk.green(`  Cleaned up ${totalRemoved} of ${totalFound} item${totalFound !== 1 ? 's' : ''}.`));
  }
  console.log('');
}
