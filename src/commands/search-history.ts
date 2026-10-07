import chalk from 'chalk';
import { getGitRoot } from '../session-state.js';
import { HISTORY_KINDS, searchHistory, type HistoryKind } from '../history-search.js';

/**
 * origin search-history <query>
 *
 * Ranked search over this repo's recorded history — sessions, commits,
 * decisions, open TODOs and the prompts behind commits. `--json` is the shape
 * an agent reads (the same result the `search_history` MCP tool returns).
 */
export async function searchHistoryCommand(
  query: string,
  opts: { limit?: string; kind?: string; json?: boolean; repo?: string } = {},
): Promise<void> {
  const repoPath = getGitRoot(opts.repo || process.cwd());
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exitCode = 1;
    return;
  }
  const kinds = (opts.kind || '').split(',').map((k) => k.trim()).filter(Boolean) as HistoryKind[];
  const unknown = kinds.filter((k) => !HISTORY_KINDS.includes(k));
  if (unknown.length) {
    console.error(chalk.red(`Unknown kind: ${unknown.join(', ')}. Use any of: ${HISTORY_KINDS.join(', ')}.`));
    process.exitCode = 1;
    return;
  }
  const limit = Math.min(Math.max(parseInt(opts.limit || '10', 10) || 10, 1), 50);
  const result = searchHistory(repoPath, query, { limit, kinds });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.blocked) {
    console.log(chalk.gray(result.blocked));
    return;
  }
  const total = Object.values(result.indexed).reduce((a, b) => a + b, 0);
  if (!result.hits.length) {
    console.log(chalk.gray(total
      ? `Nothing in this repo's history matches "${query}" (${total} records searched).`
      : 'This repo has no Origin history to search yet.'));
    return;
  }
  console.log('');
  for (const h of result.hits) {
    console.log(`  ${chalk.cyan(h.kind.padEnd(8))} ${chalk.bold(h.title)}`);
    if (h.snippet && h.snippet !== h.title) console.log(`           ${h.snippet}`);
    const meta = [
      h.agent,
      h.at ? h.at.slice(0, 10) : null,
      h.todoId ? `TODO ${h.todoId}` : null,
      h.sessionId ? `session ${h.sessionId.slice(0, 8)}` : null,
      h.commits?.length ? `commit ${h.commits.map((c) => c.slice(0, 9)).join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    if (meta) console.log(chalk.dim(`           ${meta}`));
    console.log('');
  }
  console.log(chalk.gray(`  ${result.hits.length} of ${total} records · ranked by BM25`));
}
