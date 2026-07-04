import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, loadAgentConfig, loadRepoConfig, listProfiles } from '../config.js';
import { api } from '../api.js';
import { loadSessionState, listActiveSessions, getGitRoot, getBranch, getHeadSha } from '../session-state.js';
import { currentOwner, isForeignSession } from '../session-owner.js';
import { processPendingForeignAction } from './sessions.js';
import { git, gitDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function statusCommand() {
  const config = loadConfig();
  const agentConfig = loadAgentConfig();

  console.log(chalk.bold('\n  Origin Status\n'));

  // Mode status. NOTE: `hasCreds` means only "a key is saved locally" — it
  // does NOT mean the server still accepts that key. After an account/org is
  // deleted the key lingers in config and 401s on every request, so we must
  // ask the server before claiming "Connected". The live probe below settles
  // it: we hit /api/mcp/policies once and reuse the result for the Policies
  // section further down (no double round-trip).
  const hasCreds = Boolean(config?.mode !== 'standalone' && config?.apiKey && config?.apiUrl);
  const isSolo = config?.keyType === 'solo' || config?.accountType === 'developer';

  // health: 'ok' (server accepts the key) | 'unauthorized' (key rejected, 401)
  // | 'unreachable' (network/DNS failure — don't cry "disconnected" over a
  // transient blip) | 'skip' (no creds, nothing to probe).
  let health: 'ok' | 'unauthorized' | 'unreachable' | 'skip' = hasCreds ? 'unreachable' : 'skip';
  let policiesResult: any = null;
  let policiesError: any = null;
  if (hasCreds) {
    try {
      policiesResult = await api.getPolicies();
      health = 'ok';
    } catch (err: any) {
      policiesError = err;
      health = err?.status === 401 ? 'unauthorized' : 'unreachable';
    }
  }
  // "Connected" now means the server actually accepted the key, not just that
  // one is on disk.
  const connected = health === 'ok';

  // Single-key world (Path B). The active key is what authenticates
  // everything; the personal dashboard at /me federates the user's
  // activity across every org they belong to via /api/me/*. Multi-profile
  // storage exists for users who switch between workplaces (--profile
  // flag) but is no longer the default flow.
  const allProfiles = listProfiles();

  if (config?.mode === 'standalone') {
    console.log(chalk.yellow('  ⚡ Standalone mode (forced)'));
    console.log(chalk.gray('    Sessions tracked locally in git notes'));
    console.log(chalk.gray('    Run `origin config set mode auto` to reconnect'));
  } else if (health === 'unauthorized') {
    // Key is saved but the server rejected it (401) — typically the
    // account/org was deleted or the key was revoked. Don't say "Connected".
    console.log(chalk.red('  ✗ Not connected · credentials rejected by server (401)'));
    const reason = policiesError?.serverError || policiesError?.message || 'Invalid API key';
    console.log(chalk.gray(`    ${reason}`));
    console.log(chalk.gray('    Run `origin login` to re-authenticate'));
  } else if (health === 'unreachable') {
    // Creds present but we couldn't reach the server. Could be offline or a
    // transient blip — report it honestly without claiming the key is dead.
    console.log(chalk.yellow('  ⚠ Cannot reach Origin API · using saved credentials'));
    console.log(chalk.gray(`    API: ${config!.apiUrl}`));
    console.log(chalk.gray('    Check your connection, then re-run `origin status`'));
  } else if (connected && isSolo) {
    console.log(chalk.green('  ✅ Connected · Solo Developer'));
    console.log(chalk.gray(`    📦 Personal workspace · All repos · All agents`));
  } else if (connected) {
    const orgName = config!.orgName || config!.orgId || 'unknown';
    console.log(chalk.green(`  ✅ Connected · Team Member @ ${orgName}`));
    try {
      const data = await api.getWhoami() as any;
      const repoLabel = data.repoScopes?.length > 0 ? `${data.repoScopes.length} repos` : `${data.repoCount || 0} repos`;
      const agentLabel = data.agentScopes?.length > 0 ? `${data.agentScopes.length} agents` : `${data.agentCount || 0} agents`;
      console.log(chalk.gray(`    📦 ${repoLabel} · ${agentLabel}`));
    } catch {
      console.log(chalk.gray(`    API: ${config!.apiUrl}`));
    }
  } else {
    console.log(chalk.green('  ✓ Standalone mode'));
    console.log(chalk.gray('    Sessions tracked locally in git notes'));
    console.log(chalk.gray('    Run `origin login` to connect to Origin platform'));
  }
  if (connected && allProfiles.length > 0) {
    console.log(chalk.gray(`    Personal view: ${config!.apiUrl}/me · aggregates activity across all your orgs`));
  }

  // Agent status
  if (!agentConfig) {
    console.log(chalk.yellow('\n  ⚠ Agent not initialized'));
    console.log(chalk.gray('    Run: origin enable'));
  } else {
    console.log(chalk.green('\n  ✓ Agent initialized'));
    console.log(chalk.gray(`    Machine: ${agentConfig.hostname} (${agentConfig.machineId.slice(0, 8)}...)`));
    console.log(chalk.gray(`    Tools: ${agentConfig.detectedTools.length > 0 ? agentConfig.detectedTools.join(', ') : 'none'}`));
  }

  // ── Active Sessions ─────────────────────────────────────────────
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const activeSessions = listActiveSessions(cwd);

  if (activeSessions.length > 0) {
    const label = activeSessions.length === 1 ? 'Active Session' : `Active Sessions (${activeSessions.length})`;
    console.log(chalk.magenta(`\n  ● ${label}`));

    for (const state of activeSessions) {
      const durationMs = Date.now() - new Date(state.startedAt).getTime();
      const branch = state.branch || getBranch(cwd);
      const headSha = getHeadSha(cwd);

      if (activeSessions.length > 1) {
        console.log(chalk.gray('    ─────────────────────────────'));
      }
      console.log(chalk.gray(`    Session ID:  ${chalk.white(state.sessionId)}`));
      console.log(chalk.gray(`    Model:       ${chalk.cyan(state.model)}`));
      console.log(chalk.gray(`    Duration:    ${chalk.white(formatDuration(durationMs))}`));
      if (branch) {
        console.log(chalk.gray(`    Branch:      ${chalk.yellow(branch)}`));
      }
      if (headSha) {
        console.log(chalk.gray(`    HEAD:        ${chalk.white(headSha.slice(0, 8))}`));
      }
      if (state.headShaAtStart) {
        console.log(chalk.gray(`    Start HEAD:  ${chalk.white(state.headShaAtStart.slice(0, 8))}`));
      }
      console.log(chalk.gray(`    Prompts:     ${chalk.white(String(state.prompts.length))}`));
      console.log(chalk.gray(`    Repo:        ${chalk.white(state.repoPath)}`));

      if (state.transcriptPath) {
        console.log(chalk.gray(`    Transcript:  ${chalk.white(state.transcriptPath)}`));
      }

      // Show new commits since session started
      if (state.headShaAtStart && headSha && state.headShaAtStart !== headSha) {
        try {
          if (HEX.test(state.headShaAtStart) && HEX.test(headSha)) {
            const commitCount = git(
              ['rev-list', '--count', `${state.headShaAtStart}..${headSha}`],
              { cwd: repoPath || cwd }
            ).trim();
            console.log(chalk.gray(`    New commits: ${chalk.green(commitCount)}`));
          }
        } catch { /* ignore */ }
      }

      // Origin dashboard link
      const apiUrl = config?.apiUrl || 'https://getorigin.io';
      console.log(chalk.gray(`    Dashboard:   ${chalk.blue(`${apiUrl}/sessions/${state.sessionId}`)}`));
    }
  } else if (repoPath) {
    console.log(chalk.gray('\n  No active session in this repo'));
  }

  // ── Queued (local-only) sessions ────────────────────────────────
  // Two distinct buckets among the `local-*` files in ~/.origin/sessions/:
  //   • queued — captured under THIS account (e.g. agent was disabled); a
  //     plain `origin sessions sync` will upload them.
  //   • foreign — captured under a PREVIOUS account. We deliberately do NOT
  //     upload these (that was the leak bug); the user chooses import/forget.
  if (hasCreds) {
    try {
      // Carry out any choice the user made on the dashboard banner first, so
      // the counts below reflect the post-action state (no stale warning).
      await processPendingForeignAction();
      const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        const owner = currentOwner();
        const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
        let queued = 0;
        let foreign = 0;
        for (const f of files) {
          try {
            const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
            if (typeof state?.sessionId !== 'string' || !state.sessionId.startsWith('local-')) continue;
            if (isForeignSession(state, owner)) foreign++;
            else queued++;
          } catch { /* skip */ }
        }
        if (queued > 0) {
          console.log(chalk.yellow(`\n  ⏸  ${queued} session${queued === 1 ? '' : 's'} kept local (agent was disabled)`));
          console.log(chalk.gray('    Run `origin sessions sync` once an admin enables the agent.'));
        }
        if (foreign > 0) {
          console.log(chalk.yellow(`\n  ⚠ ${foreign} session${foreign === 1 ? '' : 's'} captured under a previous Origin account`));
          console.log(chalk.gray('    Run `origin sessions import` to bring them into this account,'));
          console.log(chalk.gray('    or `origin sessions forget` to discard them.'));
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Repo Context ────────────────────────────────────────────────
  if (repoPath) {
    const repoConfig = loadRepoConfig(repoPath);
    const branch = getBranch(cwd);

    console.log(chalk.bold('\n  Repository'));
    console.log(chalk.gray(`    Path:        ${chalk.white(repoPath)}`));
    if (branch) {
      console.log(chalk.gray(`    Branch:      ${chalk.yellow(branch)}`));
    }
    if (repoConfig?.agent) {
      console.log(chalk.gray(`    Agent link:  ${chalk.cyan(repoConfig.agent)}`));
    }

    // Check for origin-sessions branch (entrypoints)
    try {
      const r = gitDetailed(['log', 'origin-sessions', '--oneline'], { cwd: repoPath });
      if (r.status === 0) {
        const count = r.stdout.split('\n').filter(Boolean).length;
        if (count > 0) {
          console.log(chalk.gray(`    Entrypoints: ${chalk.green(String(count))} sessions on origin-sessions branch`));
        }
      }
    } catch { /* ignore */ }

    // Check for git notes
    try {
      const r = gitDetailed(['notes', '--ref=origin', 'list'], { cwd: repoPath });
      if (r.status === 0) {
        const count = r.stdout.split('\n').filter(Boolean).length;
        if (count > 0) {
          console.log(chalk.gray(`    Git notes:   ${chalk.green(String(count))} commits annotated`));
        }
      }
    } catch { /* ignore */ }
  }

  // ── Policies & API Health ──────────────────────────────────────
  // Reuses the single probe from the top — no second round-trip. The header
  // already reported unauthorized/unreachable, so here we only add detail.
  if (hasCreds) {
    if (health === 'ok') {
      const policies = policiesResult?.policies ?? policiesResult;
      const count = Array.isArray(policies) ? policies.length : 0;
      console.log(chalk.green(`\n  ✓ ${count} active ${count === 1 ? 'policy' : 'policies'}`));
      console.log(chalk.green('  ✓ API connection healthy'));
    } else if (health === 'unauthorized') {
      console.log(chalk.red(`\n  ✗ API returned 401 · key rejected`));
    } else {
      console.log(chalk.red(`\n  ✗ Cannot reach Origin API: ${policiesError?.message || 'network error'}`));
    }
  }

  // Saved profiles other than the active one — useful when switching
  // workplaces with `origin login --profile <name>`. Federation across
  // orgs you belong to happens server-side, so this section is rare.
  if (hasCreds && allProfiles.length > 1) {
    console.log(chalk.bold('\n  Saved profiles'));
    for (const p of allProfiles) {
      const isActive = p.apiKey === config?.apiKey;
      const indicator = isActive ? chalk.white('●') : chalk.gray('○');
      const mode = p.accountType === 'developer' ? chalk.green('solo') : chalk.blue('team');
      const line = `${p.name} (${mode}) → ${p.orgName}${isActive ? ' (active)' : ''}`;
      console.log(`    ${indicator} ${isActive ? chalk.white(line) : chalk.gray(line)}`);
    }
  }

  console.log('');
}
