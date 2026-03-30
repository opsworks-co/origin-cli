import { readHandoff, clearHandoff, buildHandoffContext } from '../handoff.js';
import { getGitRoot } from '../session-state.js';

/**
 * origin handoff show — Display handoff context that will be passed to the next agent
 */
export async function handoffShowCommand(): Promise<void> {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log('Not inside a git repository.');
    return;
  }

  const handoff = readHandoff(repoPath);
  if (!handoff) {
    console.log('No handoff data available. A session must end before handoff is created.');
    return;
  }

  const age = Date.now() - new Date(handoff.endedAt).getTime();
  const ageMins = Math.floor(age / 60000);
  const ageStr = ageMins < 60
    ? `${ageMins}m ago`
    : ageMins < 1440
      ? `${Math.floor(ageMins / 60)}h ago`
      : `${Math.floor(ageMins / 1440)}d ago`;

  console.log(`\n  Cross-Agent Handoff Context\n`);
  console.log(`  Agent:    ${handoff.agentSlug}`);
  console.log(`  Model:    ${handoff.model}`);
  console.log(`  Session:  ${handoff.sessionId.slice(0, 8)}`);
  console.log(`  Ended:    ${ageStr}`);
  if (handoff.branch) {
    console.log(`  Branch:   ${handoff.branch}`);
  }

  if (handoff.summary) {
    console.log(`\n  Summary:`);
    console.log(`  ${handoff.summary.slice(0, 500)}`);
  }

  if (handoff.lastPrompt) {
    console.log(`\n  Last prompt:`);
    console.log(`  "${handoff.lastPrompt.slice(0, 300)}"`);
  }

  if (handoff.filesChanged.length > 0) {
    console.log(`\n  Files in progress (${handoff.filesChanged.length}):`);
    for (const f of handoff.filesChanged.slice(0, 15)) {
      console.log(`    ${f}`);
    }
    if (handoff.filesChanged.length > 15) {
      console.log(`    ... +${handoff.filesChanged.length - 15} more`);
    }
  }

  if (handoff.linesAdded > 0 || handoff.linesRemoved > 0) {
    console.log(`\n  Changes: +${handoff.linesAdded} -${handoff.linesRemoved} lines`);
  }

  if (handoff.openTodos.length > 0) {
    console.log(`\n  Open TODOs:`);
    for (const todo of handoff.openTodos) {
      console.log(`    - ${todo}`);
    }
  }

  // Show what would be injected
  const ctx = buildHandoffContext(repoPath);
  if (ctx) {
    console.log(`\n  Context that will be injected into next agent session:`);
    console.log(`  ${'─'.repeat(50)}`);
    for (const line of ctx.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log(`  ${'─'.repeat(50)}`);
  }

  console.log('');
}

/**
 * origin handoff clear — Clear handoff data for this repo
 */
export async function handoffClearCommand(): Promise<void> {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log('Not inside a git repository.');
    return;
  }

  const cleared = clearHandoff(repoPath);
  if (cleared) {
    console.log('Handoff context cleared.');
  } else {
    console.log('No handoff data to clear.');
  }
}
