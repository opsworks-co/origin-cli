import { readAllSessionMemory, readAllCommitMemory, clearSessionMemory, buildMemoryContext } from '../memory.js';
import { getGitRoot } from '../session-state.js';

/**
 * origin memory show — Display accumulated session memory for current repo
 */
export async function memoryShowCommand(options: { limit?: string }): Promise<void> {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log('Not inside a git repository.');
    return;
  }

  const entries = readAllSessionMemory(repoPath);
  if (entries.length === 0) {
    console.log('No session memory yet. Complete a session to start building memory.');
    return;
  }

  const limit = parseInt(options.limit || '10', 10);
  const shown = entries.slice(-limit);

  // Session rollups — one evolving entry PER SESSION (regenerated as the session
  // works; these IDs are SESSIONS, not commits — a session spans many commits).
  console.log(`\n  Session summaries (${entries.length} session${entries.length !== 1 ? 's' : ''}, regenerated at session end — showing last ${shown.length})\n`);

  for (const entry of shown) {
    const age = Date.now() - new Date(entry.endedAt).getTime();
    const ageStr = formatAge(age);

    console.log(`  session ${entry.sessionId.slice(0, 8)}  ${entry.agentSlug.padEnd(12)} ${entry.model.slice(0, 25).padEnd(25)}  ${ageStr.padStart(5)} ago`);
    if (entry.summary) {
      console.log(`    ${entry.summary.slice(0, 100)}`);
    }
    if (entry.filesChanged.length > 0) {
      console.log(`    Files: ${entry.filesChanged.slice(0, 5).join(', ')}${entry.filesChanged.length > 5 ? ' ...' : ''}`);
    }
    if (entry.decisions && entry.decisions.length > 0) {
      console.log(`    Decisions:`);
      for (const d of entry.decisions.slice(0, 5)) console.log(`      - ${d}`);
    }
    if (entry.openTodos.length > 0) {
      console.log(`    TODOs: ${entry.openTodos.length} open`);
    }
    console.log('');
  }

  // Immutable per-commit log — frozen when each commit landed, never regenerated.
  const commits = readAllCommitMemory(repoPath);
  if (commits.length > 0) {
    const shownCommits = commits.slice(-limit).reverse();
    console.log(`  Commit history (${commits.length} commit${commits.length !== 1 ? 's' : ''}, immutable — showing last ${shownCommits.length})\n`);
    for (const c of shownCommits) {
      const age = formatAge(Date.now() - new Date(c.committedAt).getTime());
      console.log(`  ${c.commitSha.slice(0, 7)}  ${c.agentSlug.padEnd(12)} ${age.padStart(5)} ago  (+${c.linesAdded}/-${c.linesRemoved})`);
      console.log(`    ${c.message.slice(0, 100)}`);
      const notes = Object.entries(c.fileNotes || {}).slice(0, 6);
      if (notes.length > 0) {
        for (const [file, note] of notes) console.log(`      - ${file.split('/').pop()}: ${note}`);
      } else if (c.filesChanged.length > 0) {
        console.log(`    Files: ${c.filesChanged.slice(0, 5).join(', ')}${c.filesChanged.length > 5 ? ' ...' : ''}`);
      }
      if (c.decisions && c.decisions.length > 0) {
        console.log(`    Decisions:`);
        for (const d of c.decisions.slice(0, 4)) console.log(`      - ${d}`);
      }
      console.log('');
    }
  }

  // Show what would be injected
  const ctx = buildMemoryContext(repoPath);
  if (ctx) {
    console.log(`  Context injected into new sessions:`);
    console.log(`  ${'─'.repeat(50)}`);
    for (const line of ctx.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log(`  ${'─'.repeat(50)}`);
  }

  console.log('');
}

/**
 * origin memory clear — Clear all session memory for this repo
 */
export async function memoryClearCommand(): Promise<void> {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log('Not inside a git repository.');
    return;
  }

  const cleared = clearSessionMemory(repoPath);
  if (cleared) {
    console.log('Session memory cleared.');
  } else {
    console.log('No session memory to clear.');
  }
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
