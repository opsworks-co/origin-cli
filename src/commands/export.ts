import chalk from 'chalk';
import { listSessionIds, readSessionFile } from '../session-store.js';
import fs from 'fs';
import path from 'path';
import { git, gitDetailed } from '../utils/exec.js';
import { getGitRoot } from '../session-state.js';
import { AttributionExportError, exportAttributionRecords, type AttributionExport } from '../attribution-export.js';

const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

interface ExportSession {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  status: string;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  linesAdded: number;
  linesRemoved: number;
  filesCount: number;
  filesChanged: string[];
  branch: string;
}

function listLocalSessions(repoPath: string): ExportSession[] {
  const gitOpts = { cwd: repoPath };
  const sessions: ExportSession[] = [];

  {
    const r = gitDetailed(['rev-parse', 'refs/heads/origin-sessions'], gitOpts);
    if (r.status !== 0) return sessions;
  }

  try {
    const raw = listSessionIds(repoPath).map((id) => `sessions/${id}`).join('\n');
    if (!raw) return sessions;

    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));

    for (const dir of dirs) {
      if (!SAFE_ID.test(dir)) continue;
      try {
        const metadataJson = (readSessionFile(repoPath, dir, 'metadata.json') ?? '').trim();
        const m = JSON.parse(metadataJson);
        sessions.push({
          sessionId: m.sessionId || dir,
          model: m.model || 'unknown',
          startedAt: m.startedAt || '',
          endedAt: m.endedAt || '',
          status: m.status || 'ended',
          durationMs: m.durationMs || 0,
          costUsd: m.cost?.usd || 0,
          tokensUsed: m.tokens?.total || 0,
          linesAdded: m.lines?.added || 0,
          linesRemoved: m.lines?.removed || 0,
          filesCount: (m.filesChanged || []).length,
          filesChanged: m.filesChanged || [],
          branch: m.git?.branch || '',
        });
      } catch { /* skip */ }
    }
  } catch { /* no sessions */ }

  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sessions;
}

function toCsv(sessions: ExportSession[]): string {
  const headers = ['sessionId', 'model', 'startedAt', 'endedAt', 'status', 'durationMs', 'costUsd', 'tokensUsed', 'linesAdded', 'linesRemoved', 'filesCount', 'branch'];
  const lines = [headers.join(',')];

  for (const s of sessions) {
    const row = [
      s.sessionId,
      csvEscape(s.model),
      s.startedAt,
      s.endedAt,
      s.status,
      String(s.durationMs),
      s.costUsd.toFixed(4),
      String(s.tokensUsed),
      String(s.linesAdded),
      String(s.linesRemoved),
      String(s.filesCount),
      csvEscape(s.branch),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export interface ExportOptions { format?: string; output?: string; limit?: string; model?: string; session?: string; strict?: boolean }

/**
 * Write `data` to `target` in one step: a temp file next to it, then a rename,
 * so a failure never leaves a partial file or a half-overwritten target.
 */
function writeFileAtomic(target: string, data: string): void {
  const tmp = path.join(path.dirname(path.resolve(target)), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function failRangeExport(message: string): void {
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = 1;
}

/**
 * `origin export --format=json <range>` (OR-12/A6): a JSON array of the
 * canonical v1 attribution records of the range, oldest first. A commit whose
 * note carries an unusable record is left out with one warning on stderr, or,
 * with `--strict`, fails the export. Nothing reaches stdout or `--output`
 * unless the whole range was read without a Git error; warnings are printed
 * only then, so a failed run never reports a partial success.
 */
function exportRangeCommand(range: string, opts: ExportOptions): void {
  const format = (opts.format || 'json').toLowerCase();
  if (format !== 'json') {
    failRangeExport(`--format ${opts.format} cannot be used with a range; a range exports JSON attribution records only.`);
    return;
  }
  const incompatible = (['limit', 'model', 'session'] as const).filter((k) => opts[k] !== undefined);
  if (incompatible.length > 0) {
    failRangeExport(`${incompatible.map((k) => `--${k}`).join(', ')} cannot be used with a range.`);
    return;
  }

  let result: AttributionExport;
  try {
    result = exportAttributionRecords(process.cwd(), range);
  } catch (err) {
    if (err instanceof AttributionExportError) {
      failRangeExport(err.message);
      return;
    }
    throw err;
  }

  if (opts.strict && result.skipped.length > 0) {
    for (const s of result.skipped) console.error(chalk.red(`Error: unusable attribution for ${s.sha}: ${s.message}`));
    failRangeExport(`--strict: ${result.skipped.length} unusable attribution record${result.skipped.length !== 1 ? 's' : ''}; nothing was exported.`);
    return;
  }
  for (const s of result.skipped) console.error(chalk.yellow(`Warning: skipped attribution for ${s.sha}: ${s.message}`));

  const output = JSON.stringify(result.records, null, 2) + '\n';
  const count = result.records.length;

  if (opts.output) {
    try {
      writeFileAtomic(opts.output, output);
    } catch (err: any) {
      failRangeExport(`could not write ${opts.output}: ${err?.message ?? err}`);
      return;
    }
    console.error(chalk.green(`  Exported ${count} attribution record${count !== 1 ? 's' : ''} to ${opts.output}`));
  } else {
    process.stdout.write(output);
  }
}

export async function exportCommand(range: string | undefined, opts?: ExportOptions) {
  if (range !== undefined) {
    exportRangeCommand(range, opts ?? {});
    return;
  }
  if (opts?.strict) {
    failRangeExport('--strict applies only to a commit range: origin export --format=json --strict <range>.');
    return;
  }
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Handle agent-trace format separately
  const format = (opts?.format || 'json').toLowerCase();
  if (format === 'agent-trace') {
    const { exportAgentTrace } = await import('../agent-trace.js');
    const trace = exportAgentTrace(repoPath, opts?.session);
    const output = JSON.stringify(trace, null, 2) + '\n';

    if (opts?.output) {
      fs.writeFileSync(opts.output, output);
      console.error(chalk.green(`  Exported Agent Trace v0.1.0 (${trace.files.length} files) to ${opts.output}`));
    } else {
      process.stdout.write(output);
    }
    return;
  }

  let sessions = listLocalSessions(repoPath);

  if (sessions.length === 0) {
    console.error(chalk.gray('No sessions found. Start an AI coding session to begin tracking.'));
    return;
  }

  // Apply filters
  if (opts?.model) {
    const m = opts.model.toLowerCase();
    sessions = sessions.filter(s => s.model.toLowerCase().includes(m));
  }
  if (opts?.limit) {
    const n = parseInt(opts.limit, 10);
    if (n > 0) sessions = sessions.slice(0, n);
  }

  // Format output
  let output: string;

  if (format === 'csv') {
    output = toCsv(sessions);
  } else {
    output = JSON.stringify(sessions, null, 2) + '\n';
  }

  // Write to file or stdout
  if (opts?.output) {
    fs.writeFileSync(opts.output, output);
    console.error(chalk.green(`  Exported ${sessions.length} session${sessions.length !== 1 ? 's' : ''} to ${opts.output}`));
  } else {
    process.stdout.write(output);
  }
}
