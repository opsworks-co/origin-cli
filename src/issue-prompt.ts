// "Start an agent on this issue": the branch it works on, the prompt it is
// handed, and the command that launches it.
//
// Shared by the CLI (`origin issue start`, which launches the agent) and the
// API (GET /api/repos/:repoId/issues/:shortId/prompt, which the web shows so a
// person can preview or copy what the agent will be told). One builder, so the
// two never describe the same issue differently. The CLI copy is canonical;
// apps/api/src/utils/issue-prompt.ts is generated from it by
// scripts/sync-shared-modules.mjs. No imports: it compiles in both packages.

/** The agents `origin issue start --agent` knows. `print` launches nothing. */
export const ISSUE_AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'copilot', 'antigravity', 'print'] as const;
export type IssueAgent = (typeof ISSUE_AGENTS)[number];

export function isIssueAgent(x: unknown): x is IssueAgent {
  return typeof x === 'string' && (ISSUE_AGENTS as readonly string[]).includes(x);
}

/**
 * The whole prompt stays under this many characters. 8000 since the prompt
 * carries answered questions and the pre-start brief as well (4000 before):
 * a title-only issue left the agent guessing, and argv takes far more.
 */
export const ISSUE_PROMPT_MAX_CHARS = 8000;

/** A prompt a person edited on the issue page may run to this many characters. */
export const ISSUE_PROMPT_EDIT_MAX_CHARS = 20000;

export interface IssuePromptInput {
  shortId: string;
  title: string;
  description?: string | null;
  type?: string | null;
  /** The branch the agent works on; omitted when it stays on the current one. */
  branch?: string | null;
  /**
   * The open pull request this work updates — a fix asked for in its review.
   * The agent pushes to the PR's branch instead of starting a new one.
   */
  pullRequest?: number | null;
  /**
   * The repo-memory TODO this issue IS, when it came from one. The agent is
   * asked to emit `[Origin: Closes] <id>` so the TODO closes when its work
   * reaches the default branch.
   */
  memoryTodoId?: string | null;
  /** Lines of repo memory relevant to the issue, most relevant first. */
  memory?: string[];
  /**
   * The GitHub / GitLab issue this is, when it was imported from the host:
   * the agent names it `#<number>` and the pull request closes it on merge.
   */
  hostIssue?: { provider: 'github' | 'gitlab' | 'jira'; number: number; url?: string | null } | null;
  /**
   * Questions an earlier run (or the pre-start pass) asked about the issue,
   * with the answers a person gave, oldest first. Unanswered ones are left out.
   */
  clarifications?: Array<{ question: string; answer: string | null }>;
  /** What the pre-start pass found out before this run: where the work is, how to go about it. */
  brief?: string | null;
  /**
   * The issue this one sits under — a story's epic, a sub-task's story: what
   * the larger piece of work is, so the agent fits its change to it.
   */
  parent?: { shortId: string; title: string; description?: string | null; type?: string | null; url?: string | null } | null;
  /** For an epic: the issues under it and where each stands, so the agent sees the whole. */
  children?: Array<{ shortId: string; title: string; status: string }>;
  maxChars?: number;
}

/** The answered questions, as the prompt lists them. */
function answeredPairs(list: IssuePromptInput['clarifications']): Array<{ question: string; answer: string }> {
  return (list || [])
    .filter((c) => c && typeof c.question === 'string' && typeof c.answer === 'string' && c.question.trim() && c.answer.trim())
    .map((c) => ({ question: c.question.replace(/\s+/g, ' ').trim(), answer: (c.answer as string).trim() }));
}

/** Q/A lines within `room` characters; the newest pairs win when not all fit. */
function clarificationSection(list: IssuePromptInput['clarifications'], room: number): string {
  const pairs = answeredPairs(list);
  if (pairs.length === 0 || room < 200) return '';
  const header = '\n\nQuestions asked about this issue, and the answers (follow them):';
  let left = room - header.length;
  const kept: string[] = [];
  for (let i = pairs.length - 1; i >= 0; i--) {
    const entry = `\n- Q: ${clip(pairs[i].question, 400)}\n  A: ${clip(pairs[i].answer, 1500).replace(/\n/g, '\n     ')}`;
    if (entry.length > left) break;
    kept.unshift(entry);
    left -= entry.length;
  }
  return kept.length > 0 ? header + kept.join('') : '';
}

/** The "When you are done" part: where to commit, how to link, and the outcome line. */
function closingText(input: IssuePromptInput): string {
  const ref = issueRef(input);
  const host = input.hostIssue ? ({ github: 'GitHub', gitlab: 'GitLab', jira: 'Jira' } as const)[input.hostIssue.provider] : null;
  const closing: string[] = ['', '', 'When you are done:'];
  closing.push(input.branch && input.pullRequest
    ? `- Commit your work on the branch \`${input.branch}\`, mention ${ref} in the commit message, and push the branch so pull request #${input.pullRequest} updates. Do not open a new pull request.`
    : input.branch
      ? `- Commit your work on the branch \`${input.branch}\` and mention ${ref} in the commit message.`
      : `- Commit your work and mention ${ref} in the commit message.`);
  if (input.hostIssue?.provider === 'jira' && !input.pullRequest) {
    // Jira's development panel links a branch, commit or PR by the key in its name or message.
    closing.push(`- If you open a pull request, start its title with ${ref} so Jira links it to the issue.`);
  } else if (input.hostIssue && !input.pullRequest) {
    closing.push(`- If you open a pull request, put \`Fixes ${ref}\` in its description so ${host} closes the issue when it merges.`);
  }
  if (input.memoryTodoId) {
    closing.push(`- This issue is the repo-memory TODO ${input.memoryTodoId}. In your final message, include this line on its own: [Origin: Closes] ${input.memoryTodoId}`
      + ` — and if you find it was already done and change nothing, name what did it on that line: [Origin: Closes] ${input.memoryTodoId} — already done in <commit sha or #PR>`);
  }
  closing.push('- If something stops you, say what and why instead of guessing. If the issue leaves a choice open that a person must make, stop and ask it as a question: they answer on the issue and the next run gets the answer.');
  // Read by the server when the session ends (apps/api/src/services/issue-outcome.ts):
  // it moves the issue to closed / review / blocked. Without it the issue
  // waits in review for a person to decide.
  closing.push('- End your final message with exactly one of these lines, on its own:');
  closing.push('  [Origin: Outcome] review — <what to check> (you changed code for a person to review)');
  closing.push('  [Origin: Outcome] done — <why> (nothing needed changing: already fixed, not reproducible, or not needed)');
  closing.push('  [Origin: Outcome] blocked — <your question, or what you need> (you could not finish: a decision, access, or information is missing)');
  return closing.join('\n');
}

/** How the prompt names the issue: `#123` for a GitHub / GitLab issue, else its shortId (a Jira issue's key). */
export function issueRef(input: Pick<IssuePromptInput, 'shortId' | 'hostIssue'>): string {
  return input.hostIssue && input.hostIssue.provider !== 'jira' ? `#${input.hostIssue.number}` : input.shortId;
}

/** Lowercase, ASCII letters and digits joined by '-', at most `max` chars. */
export function slugify(text: string, max = 40): string {
  const slug = (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  // End on a whole word when one fits.
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > max / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '');
}

/** A shortId made safe for a git ref segment. */
function refSafe(shortId: string): string {
  return (shortId || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').replace(/\.\.+/g, '.') || 'issue';
}

/** `issue/<shortId>-<slug>` — the branch `origin issue start` creates. */
export function issueBranchName(shortId: string, title: string): string {
  const id = refSafe(shortId);
  const slug = slugify(title);
  return slug ? `issue/${id}-${slug}` : `issue/${id}`;
}

/**
 * The issue a branch was made for, read from its name — `issue/<shortId>-…`.
 * Null for any other branch. The shortId itself may contain '-' (`ori-a3f2`),
 * so the caller matches candidates by prefix: see branchNamesIssue.
 */
export function branchIssuePrefix(branch: string | null | undefined): string | null {
  const m = /^issue\/(.+)$/.exec((branch || '').replace(/^refs\/heads\//, ''));
  return m ? m[1] : null;
}

/** Was `branch` made by `origin issue start` for this issue? */
export function branchNamesIssue(branch: string | null | undefined, shortId: string): boolean {
  const rest = branchIssuePrefix(branch);
  if (!rest) return false;
  const id = refSafe(shortId);
  return rest === id || rest.startsWith(`${id}-`);
}

/** The command that starts an agent on an issue — what the web shows to copy. */
export interface IssueStartModes {
  /** --worktree: a checkout of the branch's own beside the repo. */
  worktree?: boolean;
  /** --background: headless, no terminal (implies --worktree). */
  background?: boolean;
  /** --force: start even though someone is already on the issue (they were warned). */
  force?: boolean;
}

export function issueStartCommandLine(shortId: string, agent: IssueAgent = 'claude', branch?: string | null, modes: IssueStartModes = {}): string {
  // A branch only when it isn't the one `issue start` would pick itself (a
  // review fix works on its PR's branch). Quoted when it needs to be.
  const b = branch && branch.trim()
    ? ` --branch ${/^[\w./-]+$/.test(branch) ? branch : `'${branch.replace(/'/g, `'\\''`)}'`}`
    : '';
  const m = modes.background ? ' --background' : modes.worktree ? ' --worktree' : '';
  return `origin issue start ${shortId} --agent ${agent}${b}${m}${modes.force ? ' --force' : ''}`;
}

/**
 * argv for launching an agent with the prompt as its first message — never a
 * shell string. Null for `print`, which gets the prompt printed instead.
 *   claude <prompt>          interactive session, prompt as the first message
 *   codex <prompt>           same
 *   gemini -i <prompt>       --prompt-interactive: run it, then stay interactive
 *   cursor-agent <prompt>    Cursor's terminal agent (the IDE has no prompt flag)
 *   copilot -i <prompt>      Copilot CLI: --interactive with a first prompt
 *   agy -i <prompt>          Antigravity's CLI, --prompt-interactive
 * A missing binary falls back to printing the prompt, to paste into the editor.
 */
export function agentLaunchArgv(agent: IssueAgent, prompt: string): string[] | null {
  switch (agent) {
    case 'claude': return ['claude', prompt];
    case 'codex': return ['codex', prompt];
    case 'gemini': return ['gemini', '-i', prompt];
    case 'cursor': return ['cursor-agent', prompt];
    case 'copilot': return ['copilot', '-i', prompt];
    case 'antigravity': return ['agy', '-i', prompt];
    default: return null;
  }
}

/** Agents whose headless mode can go on with an earlier session: `claude -p --resume`, `codex exec resume`. */
export const RESUMABLE_AGENTS = ['claude', 'codex'] as const;

/**
 * The pre-start pass's answer: either the issue is clear enough (with a
 * brief of where the work is), or the questions a person must answer first.
 */
export const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    ready: { type: 'boolean' },
    brief: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['ready', 'brief', 'questions'],
  additionalProperties: false,
} as const;

/** Agents that can run the pre-start pass read-only, unrecorded, with a JSON answer. */
export const PREFLIGHT_AGENTS = ['claude', 'codex'] as const;

/**
 * The pre-start pass's prompt: read the issue against the code, then say what
 * the work is or ask what only a person can answer. Changes nothing.
 */
export function buildPreflightPrompt(issuePrompt: string): string {
  return [
    'Before an agent works on the task below unattended, check that it can. Read the code it touches; do not make the change and do not edit anything — the agent that follows can edit, run commands and commit.',
    '',
    'Answer with JSON matching the schema:',
    '- ready: true when a capable engineer could do the work without asking anyone. Guess-able details are not questions.',
    '- brief: up to 15 lines for whoever does the work — the files and functions involved, how the code works there, and the approach. Name real paths.',
    '- questions: when not ready, at most 3 short questions only a person can answer (a product choice, a missing requirement, which of two behaviours is wanted). Never ask for access or permission. Empty when ready.',
    '',
    '--- The task ---',
    issuePrompt,
  ].join('\n');
}

/**
 * argv for the pre-start pass: read-only, no hooks and no saved session — it
 * is not work, and must not show up as a session of its own. `schemaFile` /
 * `outFile` are for codex, which reads the schema from a file and writes its
 * last message to one. Null for an agent that can't (PREFLIGHT_AGENTS).
 */
export function agentPreflightArgv(agent: IssueAgent, prompt: string, files: { schemaFile: string; outFile: string }): string[] | null {
  switch (agent) {
    case 'claude': return [
      'claude', '-p', prompt, '--permission-mode', 'plan', '--output-format', 'json',
      '--json-schema', JSON.stringify(PREFLIGHT_SCHEMA), '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
    ];
    case 'codex': return [
      'codex', 'exec', '-s', 'read-only', '--ephemeral', '--disable', 'hooks', '--skip-git-repo-check',
      '--output-schema', files.schemaFile, '-o', files.outFile, prompt,
    ];
    default: return null;
  }
}

/** The pass's answer from what the agent printed (claude) or wrote (codex). Null when it can't be read. */
export function parsePreflight(raw: string | null | undefined): { ready: boolean; brief: string; questions: string[] } | null {
  if (!raw || !raw.trim()) return null;
  const tryObj = (v: any): { ready: boolean; brief: string; questions: string[] } | null => {
    if (!v || typeof v !== 'object') return null;
    if (v.structured_output && typeof v.structured_output === 'object') return tryObj(v.structured_output);
    if (typeof v.result === 'string' && typeof v.ready !== 'boolean') return parsePreflight(v.result);
    if (typeof v.ready !== 'boolean') return null;
    const questions = Array.isArray(v.questions) ? v.questions.filter((q: unknown) => typeof q === 'string' && q.trim()).map((q: string) => q.trim()).slice(0, 3) : [];
    return { ready: v.ready && questions.length === 0, brief: typeof v.brief === 'string' ? v.brief.trim() : '', questions };
  };
  const text = raw.trim();
  try { return tryObj(JSON.parse(text)); } catch { /* maybe fenced or with prose */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return tryObj(JSON.parse(m[0])); } catch { /* no */ } }
  return null;
}

/**
 * argv for running an agent headless — no terminal, no questions — in the
 * issue's worktree. Each gets the most it can do unattended without a
 * blanket bypass: edit files and, where the agent can be scoped to it, run
 * git so it can commit. `gitDir` is the repo's common .git (a linked
 * worktree commits into it, outside the worktree). Null for `print`.
 *   claude -p --permission-mode auto      the safety classifier decides each tool call
 *   codex exec -s workspace-write         sandboxed; --add-dir lets it write .git
 *   gemini -p --approval-mode auto_edit   edits only: it leaves its changes uncommitted
 *     --skip-trust                        headless Gemini refuses a folder it has not
 *                                         trusted, and every run's worktree is new;
 *                                         this trusts it for the session only
 *   cursor-agent -p --trust               commands per the worktree's .cursor/cli.json
 *                                         (cursor-scope.ts: git + read-only, network
 *                                         tools denied); --trust because headless
 *                                         cursor-agent refuses a folder it has not
 *                                         seen, and every run's worktree is new
 *   copilot -p --allow-tool write,shell(git:*)
 *   agy -p --project <id>                a project of the run's own, granted file
 *                                         access in the worktree, git and read-only
 *                                         commands, no network (antigravity-scope.ts);
 *                                         accept-edits alone refuses every command
 */
export function agentBackgroundArgv(agent: IssueAgent, prompt: string, gitDir: string, opts: { antigravityProject?: string; resumeSessionId?: string | null } = {}): string[] | null {
  // Resume: the same agent session goes on with `prompt` (the answers), so it
  // keeps what it read and did (RESUMABLE_AGENTS). Same permissions as a new run.
  const resume = opts.resumeSessionId && (RESUMABLE_AGENTS as readonly string[]).includes(agent) ? opts.resumeSessionId : null;
  switch (agent) {
    case 'claude': return resume
      ? ['claude', '-p', prompt, '--resume', resume, '--permission-mode', 'auto']
      : ['claude', '-p', prompt, '--permission-mode', 'auto'];
    case 'codex': return resume
      ? ['codex', 'exec', '-s', 'workspace-write', '--add-dir', gitDir, 'resume', resume, prompt]
      : ['codex', 'exec', '-s', 'workspace-write', '--add-dir', gitDir, prompt];
    case 'gemini': return ['gemini', '-p', prompt, '--approval-mode', 'auto_edit', '--skip-trust'];
    case 'cursor': return ['cursor-agent', '-p', prompt, '--trust'];
    case 'copilot': return ['copilot', '-p', prompt, '--allow-tool', 'write', '--allow-tool', 'shell(git:*)'];
    case 'antigravity': return ['agy', '-p', prompt, '--project', opts.antigravityProject ?? '', '--print-timeout', '120m'];
    default: return null;
  }
}

/**
 * The link the web opens to start an agent from the browser:
 * `getorigin://issue/start?repo=<repoId>&issue=<shortId>&agent=<agent>[&name=<owner/repo>][&worktree=1|&background=1]`.
 * The CLI registers itself for `getorigin://` (`origin url-handler install`) and
 * runs `origin issue start` in a new terminal, in the repo's checkout. The
 * link carries no prompt: the CLI reads the issue, and any prompt edited on
 * it, from the API with the user's own key — so a page that opens such a link
 * can only start one of your own issues, as you wrote it. Not `origin://`:
 * EA's game launcher has long claimed that scheme.
 */
export const LAUNCH_URL_SCHEME = 'getorigin';

export function issueLaunchUrl(repoId: string, shortId: string, agent: IssueAgent, repoName?: string | null, modes: IssueStartModes = {}): string {
  const q = [`repo=${encodeURIComponent(repoId)}`, `issue=${encodeURIComponent(shortId)}`, `agent=${agent}`];
  if (repoName) q.push(`name=${encodeURIComponent(repoName)}`);
  if (modes.background) q.push('background=1');
  else if (modes.worktree) q.push('worktree=1');
  if (modes.force) q.push('force=1');
  return `${LAUNCH_URL_SCHEME}://issue/start?${q.join('&')}`;
}

export interface IssueLaunchRequest {
  repoId: string;
  shortId: string;
  agent: IssueAgent;
  /** owner/name, a hint for finding the checkout. */
  repoName: string | null;
  /** Start in a worktree of its own (`origin issue start --worktree`). */
  worktree: boolean;
  /** Headless, no terminal (`--background`, which implies a worktree). */
  background: boolean;
  /** `--force`: the person saw who is already on the issue and started anyway. */
  force?: boolean;
}

/** Parse a `getorigin://issue/start` link. Null for anything else, or anything malformed. */
export function parseIssueLaunchUrl(url: string): IssueLaunchRequest | null {
  const m = /^getorigin:\/\/issue\/start\/?\?(.*)$/i.exec((url || '').trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try { q[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { return null; }
  }
  const { repo, issue, agent, name, worktree, background, force } = q;
  // Everything here reaches a command line: accept only plain ids.
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) return null;
  if (!issue || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(issue)) return null;
  if (!isIssueAgent(agent)) return null;
  const repoName = name && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) && name.length <= 200 ? name : null;
  return { repoId: repo, shortId: issue, agent, repoName, worktree: worktree === '1' || background === '1', background: background === '1', ...(force === '1' ? { force: true } : {}) };
}

/**
 * A cloud run started from this machine: `getorigin://issue/cloud?repo=<repoId>&issue=<shortId>&runner=codex&env=<env>[&name=<owner/repo>]`.
 * Codex cloud has no public API, so the server can't start it: the CLI runs
 * `origin issue cloud`, which submits the task with the person's own
 * `codex cloud exec` login and follows it to its end (commands/issue-cloud.ts).
 * A path of its own, not an agent on `issue/start`: a CLI from before it
 * refuses the link instead of starting a local Codex.
 */
export const CLOUD_RUNNERS = ['codex'] as const;
export type CloudRunner = typeof CLOUD_RUNNERS[number];
/** A Codex cloud environment: its id, or the label `codex cloud` shows. Reaches a command line as one argument. */
export const CLOUD_ENV = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,199}$/;

/** The link without `env`: the web adds the environment the person picked. */
export function issueCloudUrl(repoId: string, shortId: string, runner: CloudRunner, repoName?: string | null): string {
  const q = [`repo=${encodeURIComponent(repoId)}`, `issue=${encodeURIComponent(shortId)}`, `runner=${runner}`];
  if (repoName) q.push(`name=${encodeURIComponent(repoName)}`);
  return `${LAUNCH_URL_SCHEME}://issue/cloud?${q.join('&')}`;
}

export interface IssueCloudRequest {
  repoId: string;
  shortId: string;
  runner: CloudRunner;
  env: string;
  repoName: string | null;
}

/** Parse a `getorigin://issue/cloud` link. Null for anything else, or anything malformed. */
export function parseIssueCloudUrl(url: string): IssueCloudRequest | null {
  const m = /^getorigin:\/\/issue\/cloud\/?\?(.*)$/i.exec((url || '').trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try { q[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { return null; }
  }
  const { repo, issue, runner, env, name } = q;
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) return null;
  if (!issue || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(issue)) return null;
  if (!(CLOUD_RUNNERS as readonly string[]).includes(runner)) return null;
  if (!env || !CLOUD_ENV.test(env.trim())) return null;
  const repoName = name && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) && name.length <= 200 ? name : null;
  return { repoId: repo, shortId: issue, runner: runner as CloudRunner, env: env.trim(), repoName };
}

/**
 * A race: the same issue handed to several agents at once
 * (`origin issue race <id> --agents a,b`), each headless in its own worktree on
 * `<issue branch>-<agent>`, all from the same base, so their attempts compare
 * like for like on the issue's Attempts table.
 *
 * `getorigin://issue/race?repo=<repoId>&issue=<shortId>&agents=a,b[&name=<owner/repo>][&force=1]`.
 * A path of its own, not a parameter on `issue/start`: a CLI from before races
 * would otherwise run only the link's first agent and look like a race.
 */
export const MIN_RACE_AGENTS = 2;
export const MAX_RACE_AGENTS = 4;

/** The agents a race may take: real ones, each once, 2–4 of them. Null otherwise. */
export function raceAgents(list: unknown): IssueAgent[] | null {
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : null;
  if (!raw) return null;
  const agents = raw.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (agents.length < MIN_RACE_AGENTS || agents.length > MAX_RACE_AGENTS) return null;
  if (new Set(agents).size !== agents.length) return null;
  if (!agents.every((a) => isIssueAgent(a) && a !== 'print')) return null;
  return agents as IssueAgent[];
}

/** The branch one agent's arm of a race works on. */
export function raceArmBranch(branch: string, agent: IssueAgent): string {
  return `${branch}-${agent}`;
}

export function issueRaceUrl(repoId: string, shortId: string, agents: IssueAgent[], repoName?: string | null, modes: { force?: boolean } = {}): string {
  const q = [`repo=${encodeURIComponent(repoId)}`, `issue=${encodeURIComponent(shortId)}`, `agents=${agents.join(',')}`];
  if (repoName) q.push(`name=${encodeURIComponent(repoName)}`);
  if (modes.force) q.push('force=1');
  return `${LAUNCH_URL_SCHEME}://issue/race?${q.join('&')}`;
}

export interface IssueRaceRequest {
  repoId: string;
  shortId: string;
  agents: IssueAgent[];
  repoName: string | null;
  force?: boolean;
}

/** Parse a `getorigin://issue/race` link. Null for anything else, or anything malformed. */
export function parseIssueRaceUrl(url: string): IssueRaceRequest | null {
  const m = /^getorigin:\/\/issue\/race\/?\?(.*)$/i.exec((url || '').trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try { q[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { return null; }
  }
  const { repo, issue, agents, name, force } = q;
  // Everything here reaches a command line: accept only plain ids.
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) return null;
  if (!issue || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(issue)) return null;
  const list = raceAgents(agents);
  if (!list) return null;
  const repoName = name && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) && name.length <= 200 ? name : null;
  return { repoId: repo, shortId: issue, agents: list, repoName, ...(force === '1' ? { force: true } : {}) };
}

/**
 * An epic worked through as a sequence of its stories
 * (`origin issue run-epic <KEY>`): the CLI claims the next open story under
 * the epic from the live task queue (POST …/issues/claim-next with parentId),
 * starts an agent on it as `origin issue start` does, finishes or releases the
 * claim from how the run ended, then claims the next, until none is left.
 *
 * `getorigin://issue/run-epic?repo=<repoId>&issue=<epic shortId>[&agent=<agent>][&name=<owner/repo>][&max=<n>]`.
 * A path of its own, not `issue/start` on the epic: a CLI from before it
 * refuses the link instead of handing the whole epic to one agent.
 */
export function issueRunEpicCommandLine(shortId: string, opts: { agent?: IssueAgent | null; max?: number | null } = {}): string {
  const a = opts.agent && opts.agent !== 'claude' ? ` --agent ${opts.agent}` : '';
  const m = opts.max && opts.max > 0 ? ` --max ${opts.max}` : '';
  return `origin issue run-epic ${shortId}${a}${m}`;
}

export function issueRunEpicUrl(repoId: string, shortId: string, repoName?: string | null, opts: { agent?: IssueAgent | null; max?: number | null } = {}): string {
  const q = [`repo=${encodeURIComponent(repoId)}`, `issue=${encodeURIComponent(shortId)}`];
  if (opts.agent && opts.agent !== 'claude') q.push(`agent=${opts.agent}`);
  if (repoName) q.push(`name=${encodeURIComponent(repoName)}`);
  if (opts.max && opts.max > 0) q.push(`max=${Math.floor(opts.max)}`);
  return `${LAUNCH_URL_SCHEME}://issue/run-epic?${q.join('&')}`;
}

export interface IssueRunEpicRequest {
  repoId: string;
  shortId: string;
  /** The agent each story is handed to; claude when the link names none. */
  agent: IssueAgent;
  repoName: string | null;
  /** Stop after this many stories; null = until none is left. */
  max: number | null;
}

/** Parse a `getorigin://issue/run-epic` link. Null for anything else, or anything malformed. */
export function parseIssueRunEpicUrl(url: string): IssueRunEpicRequest | null {
  const m = /^getorigin:\/\/issue\/run-epic\/?\?(.*)$/i.exec((url || '').trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try { q[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { return null; }
  }
  const { repo, issue, agent, name, max } = q;
  // Everything here reaches a command line: accept only plain ids.
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) return null;
  if (!issue || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(issue)) return null;
  const a = agent === undefined ? 'claude' : agent;
  if (!isIssueAgent(a) || a === 'print') return null;
  if (max !== undefined && !/^[1-9][0-9]{0,2}$/.test(max)) return null;
  const repoName = name && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) && name.length <= 200 ? name : null;
  return { repoId: repo, shortId: issue, agent: a, repoName, max: max === undefined ? null : Number(max) };
}

/** Who is already on an issue, as `origin issue start` and the Start dialog both judge it. */
export interface IssueBusy { who: string; agent: string; since: string; sessionId: string | null }

/**
 * Someone (or some agent) already on the issue: a live linked session, or a
 * run reported started within the last 3h that never reported an end. Pure;
 * reads the API's single-issue shape (`sessions[]`, `runs[]`).
 */
export function issueBusy(issue: { sessions?: any[] | null; runs?: any[] | null } | null | undefined, now: number): IssueBusy[] {
  if (!issue) return [];
  const out: IssueBusy[] = [];
  for (const s of issue.sessions || []) {
    if (s?.state !== 'running') continue;
    out.push({ who: s.userName || 'Someone', agent: s.agent?.name || 'an agent', since: String(s.createdAt || ''), sessionId: s.sessionId || null });
  }
  for (const r of issue.runs || []) {
    if (r?.status !== 'started') continue;
    const at = Date.parse(r.startedAt);
    if (!Number.isFinite(at) || now - at > 3 * 3600_000) continue;
    // The run that made one of those sessions is already counted.
    if (out.some((o) => Math.abs(Date.parse(o.since) - at) < 5 * 60_000)) continue;
    out.push({ who: r.mine ? 'You' : r.userName || 'Someone', agent: r.agent || 'an agent', since: String(r.startedAt), sessionId: null });
  }
  return out;
}

/**
 * Split acceptance criteria out of an issue body: a section headed
 * "Acceptance criteria" (markdown heading or a line ending in ':'), else the
 * body's checklist items (`- [ ] …`). Returns the body without that section.
 */
export function extractAcceptanceCriteria(description: string | null | undefined): { body: string; criteria: string[] } {
  const text = (description || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { body: '', criteria: [] };
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^\s*(#{1,6}\s*)?(\*\*)?acceptance criteria(\*\*)?\s*:?\s*$/i.test(l));
  if (head !== -1) {
    let end = lines.length;
    for (let i = head + 1; i < lines.length; i++) {
      if (/^\s*#{1,6}\s/.test(lines[i])) { end = i; break; }
    }
    const criteria = lines.slice(head + 1, end)
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, '').trim())
      .filter(Boolean);
    const body = [...lines.slice(0, head), ...lines.slice(end)].join('\n').trim();
    return { body, criteria };
  }
  const checklist = lines.filter((l) => /^\s*[-*+]\s*\[[ xX]\]\s+/.test(l));
  if (checklist.length > 0) {
    const criteria = checklist.map((l) => l.replace(/^\s*[-*+]\s*\[[ xX]\]\s+/, '').trim()).filter(Boolean);
    const body = lines.filter((l) => !/^\s*[-*+]\s*\[[ xX]\]\s+/.test(l)).join('\n').trim();
    return { body, criteria };
  }
  return { body: text, criteria: [] };
}

/**
 * Paths an issue names: tokens with a '/' or a file extension, as written.
 * Used to pick the repo memory that touched them.
 */
export function mentionedPaths(text: string | null | undefined): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s`'"(\[])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.[A-Za-z][A-Za-z0-9]{0,6}|(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+)(?=$|[\s`'"),:;\]])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || '')) !== null) {
    const p = m[1].replace(/[.,]+$/, '');
    if (/^https?:/i.test(p) || /^\d+(\.\d+)+$/.test(p) || p.length < 3) continue;
    // A bare "e.g." or "v1.2" is not a path.
    if (!p.includes('/') && !/\.[A-Za-z]{1,6}$/.test(p)) continue;
    if (/^(e\.g|i\.e|etc)\.?$/i.test(p)) continue;
    out.add(p);
    if (out.size >= 20) break;
  }
  return [...out];
}

/** The most of an epic's issues the prompt lists. */
const MAX_CHILDREN_IN_PROMPT = 30;

/**
 * The tree around the issue: the epic (or parent) it is part of, with what
 * that says, and for an epic the issues under it. Within `room`. Pure.
 */
function treeSection(input: Pick<IssuePromptInput, 'parent' | 'children'>, room: number): string {
  const out: string[] = [];
  const p = input.parent;
  if (p && p.shortId) {
    const kind = p.type === 'epic' ? 'epic' : 'issue';
    const title = clip((p.title || '').replace(/\s+/g, ' ').trim(), 300);
    const lines = [`Part of ${kind} ${p.shortId}: ${title}`];
    if (p.url) lines.push(p.url);
    const desc = (p.description || '').replace(/\r\n/g, '\n').trim();
    if (desc) lines.push(`What the ${kind} says:`, clip(desc, Math.max(200, Math.floor(room * 0.6))));
    out.push(`\n\n${lines.join('\n')}`);
  }
  const kids = (input.children || []).filter((c) => c && typeof c.shortId === 'string' && c.shortId);
  if (kids.length > 0) {
    const lines = kids.slice(0, MAX_CHILDREN_IN_PROMPT).map((c) => `- ${c.shortId} ${clip((c.title || '').replace(/\s+/g, ' ').trim(), 120)} (${c.status || 'open'})`);
    if (kids.length > MAX_CHILDREN_IN_PROMPT) lines.push(`- …and ${kids.length - MAX_CHILDREN_IN_PROMPT} more`);
    out.push(`\n\nThe issues under this one, and where each stands — work on this issue as the whole they add up to, not on each of them:\n${lines.join('\n')}`);
  }
  const text = out.join('');
  return text.length <= room ? text : clip(text, room);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The prompt handed to the agent: the issue, its acceptance criteria, the
 * slice of repo memory that bears on it, and how to finish. Capped at
 * `maxChars` (default 4000): the issue body is clipped first to leave room for
 * the closing instruction, and memory fills what is left, line by line.
 */
export function buildIssuePrompt(input: IssuePromptInput): string {
  const max = Math.max(500, input.maxChars ?? ISSUE_PROMPT_MAX_CHARS);
  const { body, criteria } = extractAcceptanceCriteria(input.description);
  const title = clip((input.title || '').replace(/\s+/g, ' ').trim(), 300);
  const kind = input.type && input.type !== 'task' ? ` (${input.type})` : '';

  const ref = issueRef(input);
  const host = input.hostIssue ? ({ github: 'GitHub', gitlab: 'GitLab', jira: 'Jira' } as const)[input.hostIssue.provider] : null;
  const head: string[] = [`Work on ${host ? `${host} ` : ''}issue ${ref}${kind}: ${title}`];
  if (input.hostIssue?.url) head.push(input.hostIssue.url);

  const closing = closingText(input);

  // What was asked and answered goes in ahead of the issue text's clipping:
  // it is what a person decided, and a re-run that misses it asks again.
  const qa = clarificationSection(input.clarifications, Math.floor(max * 0.35));
  const brief = input.brief && input.brief.trim()
    ? `\n\nWhat a look at the code found before this run (a starting point — check it):\n${clip(input.brief.trim(), Math.floor(max * 0.25))}`
    : '';

  // The issue text gets what the fixed parts leave, with room kept for memory.
  const fixed = head.join('\n').length + closing.length + qa.length + brief.length + 64;
  const issueBudget = Math.max(200, Math.floor((max - fixed) * 0.7));
  const sections: string[] = [];
  if (body) sections.push(['', '', 'Details:', clip(body, issueBudget)].join('\n'));
  if (criteria.length > 0) {
    const room = Math.max(120, issueBudget - (body ? Math.min(body.length, issueBudget) : 0));
    const lines: string[] = [];
    let used = 0;
    for (const c of criteria) {
      const line = `- ${clip(c, 300)}`;
      if (used + line.length + 1 > room && lines.length > 0) break;
      lines.push(line);
      used += line.length + 1;
    }
    sections.push(['', '', 'Acceptance criteria:', ...lines].join('\n'));
  }

  // The epic it is part of, and an epic's own issues, after the issue's text
  // and before memory: context, with a fifth of the prompt at most.
  const tree = treeSection(input, Math.floor(max * 0.2));
  let text = head.join('\n') + sections.join('') + tree + qa + brief;
  const memory = (input.memory || []).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (memory.length > 0) {
    const header = '\n\nWhat earlier sessions in this repo recorded about this (from Origin memory):';
    let room = max - text.length - closing.length - header.length;
    const kept: string[] = [];
    for (const line of memory) {
      const entry = `\n- ${clip(line, 400)}`;
      if (entry.length > room) break;
      kept.push(entry);
      room -= entry.length;
    }
    if (kept.length > 0) text += header + kept.join('');
  }
  text += closing;
  return text.length <= max ? text : clip(text, max);
}

/**
 * The prompt that resumes a run which stopped on a question: the agent still
 * has the issue and its own work in its session, so it gets the answers and
 * how to finish — not the whole issue again.
 */
export function buildResumePrompt(input: IssuePromptInput): string {
  const max = Math.max(500, input.maxChars ?? ISSUE_PROMPT_MAX_CHARS);
  const ref = issueRef(input);
  const closing = closingText(input);
  const head = `You stopped working on issue ${ref} to ask for input. A person has answered — carry on from where you left off.`;
  const qa = clarificationSection(input.clarifications, max - head.length - closing.length - 16);
  const text = head + qa + closing;
  return text.length <= max ? text : clip(text, max);
}
