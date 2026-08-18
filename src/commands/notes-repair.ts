import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { repairNoteObject } from '../marker-repair.js';

// `origin notes repair` — retroactively drop junk [Origin: …] markers from
// this repo's git notes.
//
// The parser fix (anchored ^, assistant-authored turns only) governs what gets
// written from now on. It does nothing for notes already written, which sit on
// every remote and clone that fetched them and are still served by
// `get_file_context` and `origin why`. On the repo this was built against,
// 1,223 junk marker strings spanned 445 of 457 noted commits.
//
// DRY RUN BY DEFAULT. This deletes captured content, and the judgement is a
// heuristic over stored strings rather than a re-parse (the source transcripts
// are gone). Showing the user exactly what would go, and making them ask for
// it, is the right default for a destructive pass whose input is a guess.

const REFS = ['origin', 'origin-memory'] as const;

function execOpts(timeout = 30_000) {
  return {
    windowsHide: true,
    cwd: process.cwd(),
    stdio: 'pipe' as const,
    timeout,
    encoding: 'utf-8' as const,
  };
}

function listNoted(ref: string): string[] {
  try {
    const out = execFileSync('git', ['notes', `--ref=${ref}`, 'list'], execOpts()).trim();
    if (!out) return [];
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((sha): sha is string => !!sha);
  } catch {
    return [];
  }
}

export async function notesRepairCommand(
  opts: { apply?: boolean; push?: boolean; remote?: string; ref?: string } = {},
): Promise<void> {
  const refs = opts.ref ? [opts.ref] : [...REFS];
  const apply = !!opts.apply;

  console.log(chalk.bold(`\n  ${apply ? 'Repairing' : 'Scanning'} Origin markers in git notes\n`));

  let totalDropped = 0;
  let totalKept = 0;
  let notesChanged = 0;
  let notesScanned = 0;
  const byReason = new Map<string, number>();
  const samples: Array<{ sha: string; kind: string; reason: string; content: string }> = [];
  const changedRefs = new Set<string>();

  for (const ref of refs) {
    const shas = listNoted(ref);
    if (shas.length === 0) continue;

    for (const sha of shas) {
      let raw = '';
      try {
        raw = execFileSync('git', ['notes', `--ref=${ref}`, 'show', sha], execOpts());
      } catch {
        continue;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // foreign / non-JSON note — never touch it
      }
      notesScanned++;

      const result = repairNoteObject(parsed);
      totalKept += result.kept;
      if (!result.changed) continue;

      notesChanged++;
      totalDropped += result.dropped.length;
      for (const d of result.dropped) {
        byReason.set(d.reason, (byReason.get(d.reason) || 0) + 1);
        if (samples.length < 8) {
          samples.push({ sha: sha.slice(0, 8), kind: d.kind, reason: d.reason, content: d.content });
        }
      }

      if (apply) {
        try {
          execFileSync(
            'git',
            ['notes', `--ref=${ref}`, 'add', '-f', '-m', JSON.stringify(result.note, null, 2), sha],
            execOpts(),
          );
          changedRefs.add(ref);
        } catch (err) {
          console.log(chalk.red(`  ✗ ${sha.slice(0, 8)} (${ref}): ${(err as Error).message}`));
        }
      }
    }
  }

  if (notesScanned === 0) {
    console.log(chalk.gray('  No Origin notes found in this repo.\n'));
    return;
  }

  if (totalDropped === 0) {
    console.log(chalk.green(`  ✓ Clean — ${totalKept} marker(s) across ${notesScanned} note(s), nothing to drop.\n`));
    return;
  }

  for (const s of samples) {
    const text = s.content.length > 72 ? `${s.content.slice(0, 71)}…` : s.content;
    console.log(`  ${chalk.gray(s.sha)} ${chalk.yellow(s.kind.padEnd(8))} ${chalk.gray(`[${s.reason}]`)} ${text}`);
  }
  if (totalDropped > samples.length) {
    console.log(chalk.gray(`  … and ${totalDropped - samples.length} more`));
  }

  console.log();
  console.log(`  ${apply ? 'Dropped' : 'Would drop'} ${chalk.bold(String(totalDropped))} marker(s) across ${notesChanged} note(s); ${totalKept} kept.`);
  const reasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
  console.log(chalk.gray(`  by reason: ${reasons.join(' · ')}`));

  if (!apply) {
    console.log(chalk.gray('\n  Dry run — nothing was written. Apply with:\n'));
    console.log('    origin notes repair --apply\n');
    return;
  }

  console.log(chalk.green('\n  ✓ Local notes repaired.'));

  if (opts.push) {
    const remote = opts.remote || 'origin';
    for (const ref of changedRefs) {
      try {
        execFileSync(
          'git',
          ['push', remote, `+refs/notes/${ref}:refs/notes/${ref}`],
          { ...execOpts(60_000) },
        );
        console.log(chalk.green(`  ✓ Pushed refs/notes/${ref} to ${remote}`));
      } catch (err) {
        console.log(chalk.red(`  ✗ Push of refs/notes/${ref} failed: ${(err as Error).message}`));
        console.log(chalk.gray(`    Manually: git push ${remote} +refs/notes/${ref}:refs/notes/${ref}`));
        process.exitCode = 1;
      }
    }
    console.log(chalk.gray('\n  Clones that already fetched the old notes keep the old content.\n'));
  } else {
    console.log(chalk.gray('  The remote still has the old markers — push the rewrite with:\n'));
    console.log('    origin notes repair --apply --push\n');
  }
}
