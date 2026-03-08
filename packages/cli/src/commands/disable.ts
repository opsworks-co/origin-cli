import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getGitRoot, clearSessionState } from '../session-state.js';

function removeOriginHooksFromFile(
  filePath: string,
  label: string,
  filterFn: (settings: Record<string, any>) => Record<string, any>
): number {
  if (!fs.existsSync(filePath)) return 0;

  try {
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const beforeJson = JSON.stringify(settings);
    const cleaned = filterFn(settings);
    const afterJson = JSON.stringify(cleaned);

    if (beforeJson !== afterJson) {
      fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2) + '\n');
      console.log(chalk.green(`  ✓ Removed Origin hooks from ${label}`));
      return 1;
    }
    return 0;
  } catch {
    return 0;
  }
}

function filterClaudeOrGeminiHooks(settings: Record<string, any>): Record<string, any> {
  if (!settings.hooks) return settings;

  for (const eventType of Object.keys(settings.hooks)) {
    settings.hooks[eventType] = settings.hooks[eventType].filter((entry: any) => {
      if (!entry.hooks) return true;
      // Filter out Origin hooks inside the hooks array
      entry.hooks = entry.hooks.filter(
        (h: any) => !(h.command && typeof h.command === 'string' && h.command.startsWith('origin hooks'))
      );
      return entry.hooks.length > 0;
    });

    if (settings.hooks[eventType].length === 0) {
      delete settings.hooks[eventType];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return settings;
}

function filterCursorHooks(config: Record<string, any>): Record<string, any> {
  if (!config.hooks) return config;

  for (const eventType of Object.keys(config.hooks)) {
    config.hooks[eventType] = config.hooks[eventType].filter(
      (h: any) => !(h.command && typeof h.command === 'string' && h.command.startsWith('origin hooks'))
    );

    if (config.hooks[eventType].length === 0) {
      delete config.hooks[eventType];
    }
  }

  if (Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }

  return config;
}

function removeAiderConfig(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes('# origin-hooks')) return 0;

    // Remove the origin-hooks block (from marker to next non-comment/non-origin line or EOF)
    const cleaned = content
      .replace(/\n# origin-hooks[\s\S]*?(?=\n[^\s#n]|\s*$)/g, '')
      .trimEnd() + '\n';

    fs.writeFileSync(filePath, cleaned);
    console.log(chalk.green('  ✓ Removed Origin config from .aider.conf.yml'));
    return 1;
  } catch {
    return 0;
  }
}

export async function disableCommand(): Promise<void> {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  console.log(chalk.bold('\n🔌 Disabling Origin session tracking\n'));

  let removedCount = 0;

  // Claude Code — .claude/settings.json
  removedCount += removeOriginHooksFromFile(
    path.join(gitRoot, '.claude', 'settings.json'),
    '.claude/settings.json',
    filterClaudeOrGeminiHooks
  );

  // Cursor — .cursor/hooks.json
  removedCount += removeOriginHooksFromFile(
    path.join(gitRoot, '.cursor', 'hooks.json'),
    '.cursor/hooks.json',
    filterCursorHooks
  );

  // Gemini CLI — .gemini/settings.json
  removedCount += removeOriginHooksFromFile(
    path.join(gitRoot, '.gemini', 'settings.json'),
    '.gemini/settings.json',
    filterClaudeOrGeminiHooks
  );

  // Windsurf — .windsurf/hooks.json (same format as Cursor)
  removedCount += removeOriginHooksFromFile(
    path.join(gitRoot, '.windsurf', 'hooks.json'),
    '.windsurf/hooks.json',
    filterCursorHooks
  );

  // Aider — .aider.conf.yml
  removedCount += removeAiderConfig(path.join(gitRoot, '.aider.conf.yml'));

  if (removedCount === 0) {
    console.log(chalk.gray('  No Origin hooks found in any agent config.'));
  }

  // Clean up session state
  clearSessionState();
  console.log(chalk.gray('  ✓ Cleaned up session state'));

  console.log(chalk.green('\n✓ Origin session tracking disabled.\n'));
}
