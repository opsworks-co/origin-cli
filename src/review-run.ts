// Reviewer agents, the CLI side (docs/notes/REVIEWER_AGENTS_SPEC.md).
//
// "Run reviewers" on a PR queues one ReviewRun per reviewer on the server;
// the agent runs HERE, on the person's machine, because the server holds no
// agent keys. `origin review run <ids>` checks the PR's head out in a
// worktree of its own, runs the reviewer agent read-only with the prompt the
// server built, and posts the findings. The run is captured as an ordinary
// session on branch `review/<pr>/<run>`, so its cost shows on the PR.
//
// This module is the pure part — names, argv, parsing, links — so it can be
// unit-tested without git or an agent. commands/review-run.ts does the work.
import path from 'path';
import { isIssueAgent, LAUNCH_URL_SCHEME, type IssueAgent } from './issue-prompt.js';

/** The agents a reviewer can be: the ones `origin issue start` launches, minus `print`. */
export type ReviewAgent = Exclude<IssueAgent, 'print'>;

export function isReviewAgent(x: unknown): x is ReviewAgent {
  return isIssueAgent(x) && x !== 'print';
}

/** Where an agent without structured output writes its answer, inside the worktree. */
export const REVIEW_RESULT_FILE = '.origin-review-result.json';
/** Where the answer's schema is written for codex (`--output-schema` takes a file). */
export const REVIEW_SCHEMA_FILE = '.origin-review-schema.json';

export const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const;
export const REVIEW_CONFIDENCES = ['confirmed', 'plausible'] as const;
export const REVIEW_VERDICTS = ['approve', 'request_changes', 'comment'] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export type ReviewConfidence = (typeof REVIEW_CONFIDENCES)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ReviewFinding {
  path: string;
  line: number | null;
  severity: ReviewSeverity;
  title: string;
  detail: string;
  failureScenario: string | null;
  confidence: ReviewConfidence;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}

/** The answer's shape — what claude's `--json-schema` and codex's `--output-schema` enforce. */
export const REVIEW_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...REVIEW_VERDICTS] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: [...REVIEW_SEVERITIES] },
          title: { type: 'string' },
          detail: { type: 'string' },
          failureScenario: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: [...REVIEW_CONFIDENCES] },
        },
        required: ['path', 'line', 'severity', 'title', 'detail', 'failureScenario', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
} as const;

/** What the server hands `origin review run` for one run (GET /api/reviewers/runs/:id/packet). */
export interface ReviewPacket {
  run: { id: string; status: string };
  pr: { id: string; number: number; title: string; url: string; headBranch: string; baseBranch: string; headSha: string | null; repoId: string; repoFullName: string | null };
  reviewer: { id: string; name: string; agent: string; model: string | null; instructions: string; pathFilter: string | null };
  prompt: string;
  resultSchema?: object;
  resultFile?: string;
}

// ── Names ───────────────────────────────────────────────────────────────────

/** The first 8 characters of a run id: enough to tell runs apart, short enough for a branch. */
export function runShortId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'run';
}

/** The branch the review's worktree is on: `review/<pr>/<run>`. The run's session is found by it. */
export function reviewBranchName(prNumber: number, runId: string): string {
  return `review/${prNumber}/${runShortId(runId)}`;
}

/** The review's worktree: beside the repo, like an issue's (`<repo>-worktrees/review-<pr>-<run>`). */
export function reviewWorktreePath(canonical: string, prNumber: number, runId: string): string {
  return path.join(path.dirname(canonical), `${path.basename(canonical)}-worktrees`, `review-${prNumber}-${runShortId(runId)}`);
}

// ── argv ────────────────────────────────────────────────────────────────────

export interface ReviewArgvFiles {
  /** The schema, as a file (codex reads `--output-schema` from one). */
  schemaFile: string;
  /** Where codex writes its last message (`-o`). */
  outFile: string;
  /** The schema itself (claude takes `--json-schema` inline). */
  schema: object;
}

/**
 * argv for a read-only, headless review. Hooks and session persistence stay
 * ON — unlike the issue pre-start pass, a review IS work, captured as a
 * session of its own so its cost shows on the PR.
 *   claude -p --permission-mode plan --output-format json --json-schema …
 *                                        plan mode: reads, no edits; the
 *                                        answer comes back as structured output
 *   codex exec -s read-only --output-schema <file> -o <file>
 *                                        the sandbox refuses writes; the last
 *                                        message lands in the out file
 *   gemini -p --approval-mode default --skip-trust
 *                                        default mode asks before an edit, and
 *                                        headless there is nobody to say yes
 *   cursor-agent -p --trust              commands per the worktree's .cursor/cli.json
 *   copilot -p                           no --allow-tool: no writes, no shell
 *   agy -p --project <id>                a project of the run's own
 * The reviewer's model (its own, else its agent's from the Agents page) goes
 * on as --model / -m; agy takes none, so it keeps its own.
 * These four have no structured output: the prompt tells every agent to
 * write the same JSON to the result file, which the CLI reads.
 */
export function agentReviewArgv(agent: ReviewAgent, prompt: string, files: ReviewArgvFiles, opts: { antigravityProject?: string; model?: string | null } = {}): string[] | null {
  const model = opts.model?.trim() || null;
  const m = (flag: string) => (model ? [flag, model] : []);
  switch (agent) {
    case 'claude': return ['claude', '-p', prompt, '--permission-mode', 'plan', '--output-format', 'json', '--json-schema', JSON.stringify(files.schema), ...m('--model')];
    case 'codex': return ['codex', 'exec', '-s', 'read-only', '--skip-git-repo-check', ...m('-m'), '--output-schema', files.schemaFile, '-o', files.outFile, prompt];
    case 'gemini': return ['gemini', '-p', prompt, '--approval-mode', 'default', '--skip-trust', ...m('-m')];
    case 'cursor': return ['cursor-agent', '-p', prompt, '--trust', ...m('--model')];
    case 'copilot': return ['copilot', '-p', prompt, ...m('--model')];
    case 'antigravity': return ['agy', '-p', prompt, '--project', opts.antigravityProject ?? '', '--print-timeout', '120m'];
    default: return null;
  }
}

// ── The answer ──────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normFinding(v: unknown): ReviewFinding | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  const p = str(f.path);
  const title = str(f.title);
  if (!p || !title) return null;
  const sevRaw = str(f.severity).toLowerCase();
  const severity: ReviewSeverity = sevRaw === 'high' || sevRaw === 'critical' ? 'high'
    : sevRaw === 'low' || sevRaw === 'info' || sevRaw === 'nit' ? 'low'
    : 'medium';
  const confRaw = str(f.confidence).toLowerCase();
  const confidence: ReviewConfidence = confRaw === 'confirmed' ? 'confirmed' : 'plausible';
  let line: number | null = null;
  if (typeof f.line === 'number' && Number.isFinite(f.line) && f.line > 0) line = Math.floor(f.line);
  else if (typeof f.line === 'string' && /^\d+$/.test(f.line.trim())) line = Number(f.line.trim());
  const detail = str(f.detail) || title;
  const failureScenario = str(f.failureScenario ?? f.failure_scenario) || null;
  return { path: p, line, severity, title, detail, failureScenario, confidence };
}

function normResult(v: unknown): ReviewResult | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  // claude's print-mode envelope: the structured answer, or the text one.
  if (r.structured_output && typeof r.structured_output === 'object') return normResult(r.structured_output);
  if (typeof r.result === 'string' && r.verdict === undefined) return parseReviewResult(r.result);
  if (r.verdict === undefined && r.findings === undefined) return null;
  const vRaw = str(r.verdict).toLowerCase().replace(/[\s-]+/g, '_');
  const verdict: ReviewVerdict = vRaw === 'approve' || vRaw === 'approved' || vRaw === 'lgtm' ? 'approve'
    : vRaw === 'request_changes' || vRaw === 'changes_requested' || vRaw === 'reject' ? 'request_changes'
    : 'comment';
  const findings = Array.isArray(r.findings) ? r.findings.map(normFinding).filter((f): f is ReviewFinding => !!f) : [];
  const summary = str(r.summary);
  if (!summary && findings.length === 0 && !str(r.verdict)) return null;
  return { verdict, summary, findings };
}

/**
 * The reviewer's answer from what the agent printed (claude's JSON envelope)
 * or wrote (the result file): a bare object, one inside prose, or a fenced
 * block. Severity, confidence and verdict are normalised to the schema's
 * values; a finding without a path or title is dropped. Null when unreadable.
 */
export function parseReviewResult(raw: string | null | undefined): ReviewResult | null {
  if (!raw || !raw.trim()) return null;
  const text = raw.trim();
  try { const r = normResult(JSON.parse(text)); if (r) return r; } catch { /* maybe fenced, or with prose */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) { try { const r = normResult(JSON.parse(fenced[1].trim())); if (r) return r; } catch { /* no */ } }
  // The outermost object in the text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) { try { const r = normResult(JSON.parse(text.slice(start, end + 1))); if (r) return r; } catch { /* no */ } }
  return null;
}

// ── The link ────────────────────────────────────────────────────────────────

/**
 * The link the PR page opens: `getorigin://review/run?repo=<repoId>&runs=<id,id>&pr=<number>[&name=<owner/repo>]`.
 * Like `issue/start`, it carries ids only: the CLI reads each run's prompt from
 * the API with the person's own key.
 */
export function reviewLaunchUrl(repoId: string, runIds: string[], prNumber: number, repoName?: string | null): string {
  const q = [`repo=${encodeURIComponent(repoId)}`, `runs=${encodeURIComponent(runIds.join(','))}`, `pr=${prNumber}`];
  if (repoName) q.push(`name=${encodeURIComponent(repoName)}`);
  return `${LAUNCH_URL_SCHEME}://review/run?${q.join('&')}`;
}

export interface ReviewLaunchRequest {
  repoId: string;
  runIds: string[];
  prNumber: number;
  /** owner/name, a hint for finding the checkout. */
  repoName: string | null;
}

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Parse a `getorigin://review/run` link. Null for anything else, or anything malformed. */
export function parseReviewLaunchUrl(url: string): ReviewLaunchRequest | null {
  const m = /^getorigin:\/\/review\/run\/?\?(.*)$/i.exec((url || '').trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try { q[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { return null; }
  }
  const { repo, runs, pr, name } = q;
  // Everything here reaches a command line: accept only plain ids.
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) return null;
  const runIds = (runs || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (runIds.length === 0 || runIds.length > 20 || runIds.some((id) => !RUN_ID.test(id))) return null;
  if (!pr || !/^[1-9]\d{0,8}$/.test(pr)) return null;
  // owner/name segments; a segment of dots alone (`..`) is a path, not a name.
  const repoName = name && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) && !name.split('/').some((seg) => /^\.+$/.test(seg)) && name.length <= 200 ? name : null;
  return { repoId: repo, runIds, prNumber: Number(pr), repoName };
}

/** The command the link runs, for the terminal and for the "do it by hand" hint. */
export function reviewRunCommandText(runIds: string[]): string {
  return `origin review run ${runIds.join(' ')}`;
}
