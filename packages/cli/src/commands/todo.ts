import chalk from 'chalk';
import { getGitRoot } from '../session-state.js';
import {
  loadTodos,
  getOpenTodos,
  getAllTodos,
  markTodoDone,
  getTodoById,
  addManualTodo,
  removeTodo,
} from '../todo.js';

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * origin todo list
 */
export async function todoListCommand(opts?: { all?: boolean; done?: boolean; repo?: string }): Promise<void> {
  const repoPath = opts?.repo ? opts.repo : (opts?.all ? undefined : getGitRoot(process.cwd()) || undefined);

  const items = opts?.done
    ? getAllTodos(repoPath).filter(i => i.status === 'done')
    : getOpenTodos(repoPath);

  if (items.length === 0) {
    console.log(opts?.done
      ? 'No completed TODOs.'
      : 'No open TODOs. TODOs are extracted from AI session prompts automatically.');
    return;
  }

  const label = opts?.done ? 'Completed' : 'Open';
  console.log(`\n  ${label} TODOs (${items.length})\n`);

  for (const item of items) {
    const icon = item.status === 'done' ? chalk.green('✓') : chalk.yellow('○');
    const id = chalk.gray(item.id);
    const age = chalk.gray(timeAgo(item.createdAt));
    const session = chalk.gray(`session:${item.sessionId.slice(0, 8)}`);
    const repoName = item.repoPath.split('/').pop() || item.repoPath;

    console.log(`  ${icon} ${id}  ${item.text}`);
    console.log(`    ${session}  ${chalk.gray(repoName)}  ${age}`);
    if (item.branch) {
      console.log(`    ${chalk.gray(`branch: ${item.branch}`)}`);
    }
    console.log('');
  }
}

/**
 * origin todo done <id>
 */
export async function todoDoneCommand(id: string): Promise<void> {
  const item = markTodoDone(id);
  if (!item) {
    console.log(chalk.red(`No open TODO found matching "${id}".`));
    return;
  }
  console.log(chalk.green(`✓ Marked as done: ${item.text}`));
}

/**
 * origin todo show <id>
 */
export async function todoShowCommand(id: string): Promise<void> {
  const item = getTodoById(id);
  if (!item) {
    console.log(chalk.red(`No TODO found matching "${id}".`));
    return;
  }

  console.log(`\n  TODO ${item.id}\n`);
  console.log(`  Text:      ${item.text}`);
  console.log(`  Status:    ${item.status === 'done' ? chalk.green('done') : chalk.yellow('open')}`);
  console.log(`  Session:   ${item.sessionId}`);
  console.log(`  Repo:      ${item.repoPath}`);
  if (item.branch) {
    console.log(`  Branch:    ${item.branch}`);
  }
  console.log(`  Created:   ${item.createdAt} (${timeAgo(item.createdAt)})`);
  if (item.doneAt) {
    console.log(`  Done:      ${item.doneAt} (${timeAgo(item.doneAt)})`);
  }
  console.log(`  Source:    ${item.source}`);
  console.log('');
}

/**
 * origin todo add <text>
 */
export async function todoAddCommand(text: string): Promise<void> {
  const repoPath = getGitRoot(process.cwd()) || process.cwd();
  const item = addManualTodo(text, repoPath);
  console.log(chalk.green(`✓ Added TODO ${item.id}: ${item.text}`));
}

/**
 * origin todo remove <id>
 */
export async function todoRemoveCommand(id: string): Promise<void> {
  const removed = removeTodo(id);
  if (removed) {
    console.log(chalk.green(`✓ Removed TODO ${id}`));
  } else {
    console.log(chalk.red(`No TODO found matching "${id}".`));
  }
}
