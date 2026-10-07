import { getGitRoot } from '../session-state.js';
import {
  INTERACTIVE_PUBLISH_BUDGET_MS,
  publishAttributionNotes,
  redactRemoteCredentials,
  resolveAutoPublishRemote,
  type NotesPublishResult,
  type PublishOptions,
} from '../git-notes.js';

// origin push-metadata [remote] — publish refs/notes/origin, the ref that
// carries Origin's attribution notes, to a remote.
//
// The pre-push hook already does this on every `git push`; this is the same
// publisher (publishAttributionNotes) run on demand: after a push made with
// --no-verify, from a machine without the hooks, or to a remote nobody pushes
// code to. It publishes the attribution ref only — the origin-sessions branch
// and the memory notes have their own privacy gates and stay with pre-push.
//
// Unlike the hook, this is strict: a real failure is reported and exits
// non-zero. No notes is a successful no-op; no such remote is a user error.

export interface PushMetadataOutcome {
  exitCode: 0 | 1;
  lines: string[];
  result?: NotesPublishResult;
}

/** The command without process side effects — exported for tests. */
export function runPushMetadata(cwd: string, remoteArg?: string, publish: PublishOptions = {}): PushMetadataOutcome {
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    return { exitCode: 1, lines: ['Not inside a git repository.'] };
  }
  // No argument means `origin` and nothing else: another remote (an upstream,
  // a customer's repository) only ever receives the notes when it is named.
  const remote = (remoteArg || '').trim() || resolveAutoPublishRemote(repoPath);
  if (!remote) {
    return {
      exitCode: 1,
      lines: [
        'This repository has no `origin` remote, the default destination.',
        'The notes can carry prompt text, so name the remote to publish to: origin push-metadata <remote>',
      ],
    };
  }
  const safe = redactRemoteCredentials(remote);
  // A person is waiting: a longer budget than the hooks get, but still finite.
  const result = publishAttributionNotes(repoPath, remote, { budgetMs: INTERACTIVE_PUBLISH_BUDGET_MS, ...publish });
  switch (result.status) {
    case 'pushed':
      return {
        exitCode: 0,
        result,
        lines: [
          result.merged
            ? `Published refs/notes/origin to ${safe} (merged the remote's notes first; on a commit both sides annotated, the local note was kept).`
            : `Published refs/notes/origin to ${safe}.`,
        ],
      };
    case 'no-notes':
      return {
        exitCode: 0,
        result,
        lines: ['No Origin attribution notes in this repository (refs/notes/origin does not exist). Nothing to publish.'],
      };
    case 'no-remote':
      return { exitCode: 1, result, lines: [`No remote named "${safe}".`] };
    case 'failed':
      return {
        exitCode: 1,
        result,
        lines: [
          result.attempts > 0
            ? `Could not publish refs/notes/origin to ${safe} after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}.`
            : `Could not publish refs/notes/origin to ${safe}.`,
          `  ${redactRemoteCredentials(result.reason)}`,
        ],
      };
  }
}

export async function pushMetadataCommand(remote?: string): Promise<void> {
  const outcome = runPushMetadata(process.cwd(), remote);
  const write = outcome.exitCode === 0 ? console.log : console.error;
  for (const line of outcome.lines) write(line);
  if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
}
