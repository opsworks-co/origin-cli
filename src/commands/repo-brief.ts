import chalk from 'chalk';
import { loadConfig, saveConfig } from '../config.js';
import { getGitRoot } from '../session-state.js';
import {
  isRepoBriefEnabled, generateRepoBrief, writeRepoBrief, readRepoBrief,
  isRepoBriefStale, clearRepoBrief, resolveAnthropicKey, runBackgroundGeneration,
} from '../repo-brief.js';

// `origin context brief [--refresh|--enable|--disable|--clear|--generate]`
export async function briefCommand(opts: { refresh?: boolean; enable?: boolean; disable?: boolean; clear?: boolean; generate?: boolean }): Promise<void> {
  // Hidden: the detached background worker session-start spawns (P1). Silent.
  if (opts.generate) {
    const repoPath = getGitRoot(process.cwd());
    if (repoPath) await runBackgroundGeneration(repoPath);
    return;
  }

  if (opts.enable || opts.disable) {
    const cfg = loadConfig() || ({} as any);
    cfg.repoBrief = !!opts.enable;
    saveConfig(cfg);
    console.log(opts.enable
      ? chalk.green('  ✓ Repo brief enabled.') + chalk.gray('\n    A cached repo summary will be injected at session start (generated on demand — run `origin context brief --refresh`).')
      : chalk.yellow('  Repo brief disabled.') + chalk.gray('\n    Existing cached briefs stay in git notes until `--clear`.'));
    return;
  }

  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) { console.error(chalk.red('  Not in a git repository.')); return; }

  if (opts.clear) {
    console.log(clearRepoBrief(repoPath) ? chalk.green('  ✓ Repo brief cleared.') : chalk.gray('  No repo brief to clear.'));
    return;
  }

  if (opts.refresh) {
    if (!(await resolveAnthropicKey())) {
      console.error(chalk.red('  No Anthropic API key.') + chalk.gray('\n    Set ANTHROPIC_API_KEY, `origin config set anthropicApiKey <key>`, or add the key to your Origin org.'));
      return;
    }
    console.log(chalk.gray('  Generating repo brief…'));
    const brief = await generateRepoBrief(repoPath);
    if (!brief) { console.error(chalk.red('  Could not generate a brief (empty repo or LLM error).')); return; }
    writeRepoBrief(repoPath, brief);
    console.log(chalk.bold('\n  Repo brief\n'));
    console.log(brief.brief.split('\n').map((l) => '  ' + l).join('\n'));
    console.log(chalk.gray(`\n  Cached (git note refs/notes/origin-repo-brief) — model ${brief.model}.`));
    if (!isRepoBriefEnabled()) console.log(chalk.gray('  Injection is OFF — enable with `origin context brief --enable`.'));
    return;
  }

  // Default: show the cached brief.
  const cached = readRepoBrief(repoPath);
  console.log(chalk.bold('\n  Repo brief\n'));
  if (!cached) {
    console.log(chalk.gray('  None yet. Generate one with: origin context brief --refresh'));
    if (!isRepoBriefEnabled()) console.log(chalk.gray('  (Injection is OFF — enable with `origin context brief --enable`.)'));
    return;
  }
  console.log(cached.brief.split('\n').map((l) => '  ' + l).join('\n'));
  const stale = isRepoBriefStale(repoPath, cached);
  console.log(chalk.gray(`\n  Generated ${new Date(cached.generatedAt).toLocaleString()} (${brief_age(cached.generatedAt)}) — model ${cached.model}.`));
  console.log(stale ? chalk.yellow('  Stale — refresh with `origin context brief --refresh`.') : chalk.gray('  Up to date.'));
  console.log(isRepoBriefEnabled() ? chalk.gray('  Injection: ON.') : chalk.gray('  Injection: OFF (enable with `--enable`).'));
}

function brief_age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / 86_400_000);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h > 0) return `${h}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}
