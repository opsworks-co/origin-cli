import { execFileSync } from 'child_process';
import { scrubNoteObject } from '../git-notes.js';

// origin scrub-notes — retroactively remove prompt text from this repo's
// refs/notes/origin. New notes are metadata-only by default; this command
// exists for notes written before that default (or while the opt-in was
// on), which may already sit on the remote where anyone with read access
// can fetch them. Code edits, models, files, and counts stay — only
// prompt-text carriers (promptSummary, fullPrompt, per-prompt text, the
// promptText embedded in editsJson) are removed.
export async function scrubNotesCommand(opts: { push?: boolean; remote?: string }): Promise<void> {
  const execOpts = {
    cwd: process.cwd(),
    stdio: 'pipe' as const,
    timeout: 30_000,
    encoding: 'utf-8' as const,
  };

  let listing = '';
  try {
    listing = execFileSync('git', ['notes', '--ref=origin', 'list'], execOpts).trim();
  } catch {
    console.log('No Origin notes found in this repo (refs/notes/origin missing).');
    return;
  }
  if (!listing) {
    console.log('No Origin notes found in this repo.');
    return;
  }

  const commitShas = listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((sha): sha is string => !!sha);

  let scrubbedCount = 0;
  let cleanCount = 0;
  let skippedCount = 0;

  for (const sha of commitShas) {
    let raw = '';
    try {
      raw = execFileSync('git', ['notes', '--ref=origin', 'show', sha], execOpts);
    } catch {
      skippedCount++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not an Origin JSON note — leave foreign content untouched.
      skippedCount++;
      continue;
    }
    const { changed, scrubbed } = scrubNoteObject(parsed);
    if (!changed) {
      cleanCount++;
      continue;
    }
    try {
      execFileSync(
        'git',
        ['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(scrubbed, null, 2), sha],
        execOpts,
      );
      scrubbedCount++;
    } catch (err) {
      console.error(`Failed to rewrite note on ${sha.slice(0, 7)}: ${(err as Error).message}`);
      skippedCount++;
    }
  }

  console.log(
    `Scrubbed ${scrubbedCount} note${scrubbedCount === 1 ? '' : 's'}` +
    ` (${cleanCount} already clean${skippedCount > 0 ? `, ${skippedCount} skipped` : ''}).`,
  );

  if (scrubbedCount === 0 && !opts.push) return;

  if (opts.push) {
    const remote = opts.remote || 'origin';
    try {
      // Rewriting notes makes the local ref diverge from the remote's, so a
      // plain push is rejected. The forced refspec is intentional and safe
      // for THIS ref: refs/notes/origin is wholly owned by Origin tooling,
      // and replacing it with the scrubbed history is the entire point.
      execFileSync(
        'git',
        ['push', remote, '+refs/notes/origin:refs/notes/origin'],
        { ...execOpts, timeout: 60_000 },
      );
      console.log(`Pushed scrubbed notes to ${remote} (replaced refs/notes/origin).`);
      console.log('Note: clones that already fetched the old notes still have the old content.');
    } catch (err) {
      console.error(`Push failed: ${(err as Error).message}`);
      console.error(`Push manually with: git push ${remote} +refs/notes/origin:refs/notes/origin`);
      process.exitCode = 1;
    }
  } else if (scrubbedCount > 0) {
    console.log('Local notes scrubbed. The remote still has the old notes — push the rewrite with:');
    console.log('  origin scrub-notes --push');
  }
}
