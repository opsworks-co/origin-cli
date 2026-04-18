#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { policiesCommand } from './commands/policies.js';
import { syncCommand } from './commands/sync.js';
import { whoamiCommand } from './commands/whoami.js';
import { sessionsCommand, sessionDetailCommand, sessionEndCommand, sessionCleanCommand } from './commands/sessions.js';
import { reviewCommand } from './commands/review.js';
import { reviewPRCommand } from './commands/review-pr.js';
import { intentReviewCommand } from './commands/intent-review.js';
import { agentsCommand, agentCreateCommand } from './commands/agents.js';
import { reposCommand, repoAddCommand } from './commands/repos.js';
import { auditCommand } from './commands/audit.js';
import { statsCommand } from './commands/stats.js';
import { recapCommand } from './commands/recap.js';
import { enableCommand } from './commands/enable.js';
import { disableCommand } from './commands/disable.js';
import { linkCommand } from './commands/link.js';
import { hooksCommand, handlePostCommit, handlePrePush, handlePreCommit, handlePrepareCommitMsg } from './commands/hooks.js';
import { explainCommand } from './commands/explain.js';
import { askCommand } from './commands/ask.js';
import { promptsCommand } from './commands/prompts.js';
import { whyCommand } from './commands/why.js';
import { chatCommand } from './commands/chat.js';
import { webCommand } from './commands/web.js';
import { doctorCommand } from './commands/doctor.js';
import { resetCommand } from './commands/reset.js';
import { cleanCommand } from './commands/clean.js';
import { configGetCommand, configSetCommand, configListCommand } from './commands/config-cmd.js';
import { resumeCommand } from './commands/resume.js';
import { shareCommand } from './commands/share.js';
import { blameCommand } from './commands/blame.js';
import { diffCommand } from './commands/diff.js';
import { searchCommand } from './commands/search.js';
import { rewindCommand } from './commands/rewind.js';
import { trailCommand, trailListCommand, trailCreateCommand, trailUpdateCommand, trailAssignCommand, trailLabelCommand } from './commands/trail.js';
import { ciCheckCommand, ciSquashMergeCommand, ciGenerateWorkflowCommand, ciSessionCheckCommand } from './commands/ci.js';
import { pluginListCommand, pluginInstallCommand, pluginRemoveCommand } from './commands/plugin.js';
import { upgradeCommand } from './commands/upgrade.js';
import { analyzeCommand } from './commands/analyze.js';
import { handoffShowCommand, handoffClearCommand } from './commands/handoff.js';
import { memoryShowCommand, memoryClearCommand } from './commands/memory.js';
import { todoListCommand, todoDoneCommand, todoShowCommand, todoAddCommand, todoRemoveCommand } from './commands/todo.js';
import { explainCompareCommand } from './commands/explain.js';
import { dbImportCommand, dbStatsCommand } from './commands/db.js';
import { proxyInstallCommand, proxyUninstallCommand, proxyStatusCommand } from './commands/proxy.js';
import { verifyCommand } from './commands/verify.js';
import { verifyInstallCommand } from './commands/verify-install.js';
import { ignoreListCommand, ignoreAddCommand, ignoreRemoveCommand, ignoreTestCommand } from './commands/ignore.js';
import { exportCommand } from './commands/export.js';
import { compareCommand } from './commands/compare.js';
import { reworkCommand } from './commands/rework.js';
import { reportCommand } from './commands/report.js';
import { logCommand } from './commands/log.js';
import { showCommand } from './commands/show.js';
import { attachCommand } from './commands/attach.js';
import { backfillCommand } from './commands/backfill.js';
import { snapshotSaveCommand, snapshotListCommand, snapshotRestoreCommand, snapshotCleanCommand } from './commands/snapshot.js';
import { promptStatusCommand } from './commands/prompt-status.js';
import { shellPromptCommand } from './commands/shell-prompt.js';
import {
  issueCreateCommand, issueListCommand, issueShowCommand, issueUpdateCommand,
  issueCloseCommand, issueReadyCommand, issueBlockedCommand,
  issueDepAddCommand, issueDepRemoveCommand, issueDepTreeCommand, issueLinkCommand,
} from './commands/issue.js';
import { checkForUpdate } from './version-check.js';
import { BUILD_INFO } from './build-info.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

// Install a global sanitizer so every console.error / console.warn goes
// through secret-redaction and home-directory collapsing before hitting
// the user's terminal or shell history.
import { installGlobalConsoleSanitizer } from './error-sanitize.js';
installGlobalConsoleSanitizer();

const program = new Command();

// `--version` prints the package version. `--version --verbose` (or the
// dedicated `version` subcommand below) additionally prints the git SHA and
// build timestamp captured at build time. This is the only reliable way to
// answer "what exactly is this binary?" after the fact.
const verboseRequested = process.argv.includes('--verbose');
const versionString = verboseRequested
  ? `${pkg.version} (${BUILD_INFO.gitShortSha}${BUILD_INFO.gitDirty ? '-dirty' : ''}, built ${BUILD_INFO.builtAt})`
  : pkg.version;

program
  .name('origin')
  .description('Origin — AI Coding Agent Governance CLI')
  .version(versionString);

program.command('version')
  .description('Show CLI version and build provenance')
  .option('--verbose', 'Include git SHA, branch, and build timestamp')
  .option('--json', 'Output as JSON')
  .action((opts: { verbose?: boolean; json?: boolean }) => {
    if (opts.json) {
      const { version: _bv, ...rest } = BUILD_INFO;
      console.log(JSON.stringify({ version: pkg.version, ...rest }, null, 2));
      return;
    }
    console.log(`origin ${pkg.version}`);
    if (opts.verbose) {
      console.log(`  git:    ${BUILD_INFO.gitSha}${BUILD_INFO.gitDirty ? ' (dirty)' : ''}`);
      console.log(`  branch: ${BUILD_INFO.gitBranch}`);
      console.log(`  built:  ${BUILD_INFO.builtAt}`);
    }
  });

// ─── Setup ────────────────────────────────────────────────────────────────

program.command('login')
  .description('Login to Origin')
  .option('--key <apiKey>', 'API key (skip interactive prompt)')
  .option('--url <apiUrl>', 'API URL (default: https://getorigin.io)')
  .option('--profile <name>', 'Save as named profile (default: auto-detect "dev" or "team")')
  .action(loginCommand);
program.command('init')
  .description('Register this machine + install GLOBAL git hooks (tracks all repos)')
  .option('--standalone', 'Force standalone mode (skip API, even when logged in)')
  .option('--local', 'Install hooks for this repo only (default: global — tracks every repo)')
  .option('--no-hooks', 'Skip hook installation entirely')
  .action(initCommand);
program.command('enable')
  .description('Install Origin hooks for session tracking')
  .option('-a, --agent <agent>', 'Agent to enable (claude-code, cursor, gemini, windsurf, aider). Auto-detects if omitted.')
  .option('-g, --global', 'Install hooks globally (~/) so ALL repos are tracked automatically')
  .option('-l, --link <slug>', 'Link this repo to an Origin agent by slug (writes .origin.json)')
  .option('-s, --agent-slug <slug>', 'Override agent slug for this tool (e.g. cursor-frontend). Saved to config.')
  .option('--no-chain', 'Replace existing hooks instead of chaining')
  .action(enableCommand);
program.command('disable')
  .description('Remove Origin hooks')
  .option('-g, --global', 'Remove global hooks from ~/  ')
  .action(disableCommand);
program.command('link [slug]')
  .description('Link this repo to an Origin agent (set .origin.json)')
  .option('--clear', 'Remove agent mapping')
  .option('--list', 'Show current link')
  .option('--unlink', 'Remove link')
  .action(linkCommand);
program.command('attach [agent]')
  .description('Attach Origin tracking to an already-running AI agent session')
  .action(attachCommand);
program.command('status').description('Show current status (active session, branch, repo info)').action(statusCommand);
program.command('prompt-status')
  .description('Output a short PS1/prompt string for the current session state (fast, local-only)')
  .action(promptStatusCommand);
program.command('shell-prompt')
  .description('Output shell integration script to stdout — pipe to eval in .bashrc/.zshrc')
  .action(shellPromptCommand);
program.command('whoami').description('Show current user and org info').action(whoamiCommand);

// ─── Session Management ──────────────────────────────────────────────────

program.command('explain [sessionId]')
  .description('Explain a coding session (prompts, files, cost, review)')
  .option('-c, --commit <sha>', 'Look up session by commit SHA (via git notes)')
  .option('-s, --short', 'Short output (skip prompt-change mapping)')
  .option('--summarize', 'Generate AI-powered summary (intent, outcome, learnings, friction)')
  .option('--json', 'Output as JSON')
  .action(explainCommand);
program.command('ask <query>')
  .description('Ask about AI-generated code — find the session and prompts behind any file or change')
  .option('-f, --file <path>', 'Ask about a specific file')
  .option('-l, --line <n>', 'Focus on a specific line number')
  .option('-s, --session <id>', 'Search within a specific session')
  .option('--limit <n>', 'Max results', '5')
  .action(askCommand);

program.command('prompts <file-or-session-id>')
  .description('Show AI prompts for a file or session — pass a file path or session ID')
  .option('-e, --expand', 'Show the actual code diff for each prompt')
  .option('--limit <n>', 'Max entries to show', '10')
  .action(promptsCommand);

program.command('why <file[:line]>')
  .description('Find which AI session and prompt wrote a specific line of code')
  .action(whyCommand);

program.command('chat')
  .description('Interactive AI assistant — ask questions about your AI-authored code in natural language')
  .option('-q, --question <text>', 'Ask a single question (non-interactive)')
  .action(chatCommand);

program.command('web')
  .description('Launch local web dashboard — AI attribution, sessions, and prompts in the browser')
  .option('-p, --port <n>', 'Port number', '3141')
  .action(webCommand);

program.command('doctor')
  .description('Scan for and fix stuck/orphaned sessions')
  .option('-f, --fix', 'Auto-fix issues found')
  .option('-v, --verbose', 'Show detailed diagnostic info')
  .action(doctorCommand);
program.command('reset')
  .description('Clear local session state for this repo')
  .option('-f, --force', 'Force clear even if session looks active')
  .action(resetCommand);
program.command('clean')
  .description('Remove orphaned branches, stale sessions, temp files')
  .option('--dry-run', 'Show what would be cleaned without deleting')
  .option('-f, --force', 'Skip confirmation')
  .action(cleanCommand);

// ─── Cross-Agent Handoff ─────────────────────────────────────────────────

const handoff = program.command('handoff').description('Cross-agent context handoff');
handoff.action(handoffShowCommand);
handoff.command('show')
  .description('Show handoff context that will be passed to the next agent')
  .action(handoffShowCommand);
handoff.command('clear')
  .description('Clear handoff data for this repo')
  .action(handoffClearCommand);

// ─── Session Memory ─────────────────────────────────────────────────────

const memory = program.command('memory').description('Session memory — accumulated context across sessions');
memory.action(memoryShowCommand);
memory.command('show')
  .description('Display accumulated session memory for current repo')
  .option('-l, --limit <n>', 'Number of sessions to show', '10')
  .action(memoryShowCommand);
memory.command('clear')
  .description('Clear all session memory for this repo')
  .action(memoryClearCommand);

// ─── AI TODO Tracker ─────────────────────────────────────────────────────

const todo = program.command('todo').description('AI-extracted TODO tracker across sessions');
todo.action(todoListCommand);
todo.command('list')
  .description('List open TODOs')
  .option('-a, --all', 'Show TODOs from all repos')
  .option('-d, --done', 'Show completed TODOs')
  .action(todoListCommand);
todo.command('done <id>')
  .description('Mark a TODO as complete')
  .action(todoDoneCommand);
todo.command('show <id>')
  .description('Show details of a TODO')
  .action(todoShowCommand);
todo.command('add <text>')
  .description('Manually add a TODO')
  .action(todoAddCommand);
todo.command('remove <id>')
  .description('Remove a TODO')
  .action(todoRemoveCommand);

// ─── AI Issue Tracker ───────────────────────────────────────────────────

const issue = program.command('issue').description('AI-native issue tracker — git-tracked, dependency-aware');
issue.action(issueListCommand);

issue.command('create <title>')
  .description('Create a new issue')
  .option('-t, --type <type>', 'Issue type: bug, feature, task, chore', 'task')
  .option('-p, --priority <n>', 'Priority: 1 (critical) to 4 (low)', '3')
  .option('-l, --label <labels...>', 'Labels')
  .option('-d, --dep <ids...>', 'Depends on issue IDs')
  .option('--description <text>', 'Description')
  .option('--json', 'Output as JSON')
  .action(issueCreateCommand);

issue.command('list')
  .description('List issues')
  .option('-s, --status <status>', 'Filter by status: open, in-progress, blocked, closed')
  .option('-p, --priority <n>', 'Filter by priority')
  .option('-l, --label <label>', 'Filter by label')
  .option('-t, --type <type>', 'Filter by type')
  .option('--json', 'Output as JSON')
  .action(issueListCommand);

issue.command('show <id>')
  .description('Show issue details')
  .option('--json', 'Output as JSON')
  .action(issueShowCommand);

issue.command('update <id>')
  .description('Update an issue')
  .option('-s, --status <status>', 'New status: open, in-progress, blocked, closed')
  .option('-p, --priority <n>', 'New priority')
  .option('-t, --title <title>', 'New title')
  .option('--type <type>', 'New type')
  .option('-l, --label <labels...>', 'Replace labels')
  .option('--description <text>', 'New description')
  .option('--json', 'Output as JSON')
  .action(issueUpdateCommand);

issue.command('close <id>')
  .description('Close an issue')
  .option('--json', 'Output as JSON')
  .action(issueCloseCommand);

issue.command('ready')
  .description('Show issues with no unresolved dependencies — ready to work on')
  .option('--json', 'Output as JSON')
  .action(issueReadyCommand);

issue.command('blocked')
  .description('Show issues blocked by unresolved dependencies')
  .option('--json', 'Output as JSON')
  .action(issueBlockedCommand);

issue.command('link <id> <sessionId>')
  .description('Link a session to an issue')
  .option('--json', 'Output as JSON')
  .action(issueLinkCommand);

const issueDep = issue.command('dep').description('Manage issue dependencies');

issueDep.command('add <id> <blocksId>')
  .description('Add a dependency: <id> depends on <blocksId>')
  .option('--json', 'Output as JSON')
  .action(issueDepAddCommand);

issueDep.command('remove <id> <depId>')
  .description('Remove a dependency')
  .option('--json', 'Output as JSON')
  .action(issueDepRemoveCommand);

issueDep.command('tree <id>')
  .description('Show dependency tree')
  .option('--json', 'Output as JSON')
  .action(issueDepTreeCommand);

// ─── Session Compare ────────────────────────────────────────────────────

program.command('session-compare <id1> <id2>')
  .description('Compare two sessions side by side')
  .action(explainCompareCommand);

// ─── Attribution & Blame ─────────────────────────────────────────────────

program.command('blame <file>')
  .description('Show AI vs human attribution per line (like git blame)')
  .option('-l, --line <range>', 'Show specific line range (e.g., 10-20)')
  .option('--json', 'Output as JSON')
  .action(blameCommand);

program.command('diff [range]')
  .description('Show diff with AI/human attribution annotations')
  .option('--ai-only', 'Only show AI-authored changes')
  .option('--human-only', 'Only show human-authored changes')
  .option('--json', 'Output as JSON')
  .action(diffCommand);

program.command('stats')
  .description('View attribution statistics for the current repo')
  .option('--local', 'Compute stats from local git data (default when in a repo)')
  .option('--dashboard', 'Show org-wide dashboard stats from Origin API')
  .option('-g, --global', 'Show stats across all repos (default: current repo only)')
  .option('-r, --range <range>', 'Commit range (e.g., HEAD~50..HEAD)')
  .action(statsCommand);

program.command('recap')
  .description('End-of-day summary: sessions, cost, tokens, files, commits, TODOs, top model')
  .option('-d, --days <n>', 'Number of days to include (default: 1 = today only)', '1')
  .action(recapCommand);

program.command('log')
  .description('Show git log with Origin session info inline (agent, cost, prompts)')
  .option('-l, --limit <n>', 'Max commits to show', '20')
  .option('-a, --all', 'Show all branches')
  .action(logCommand);

program.command('show <commit>')
  .description('Show the Origin session linked to a commit')
  .option('--json', 'Output as JSON')
  .action(showCommand);

program.command('report')
  .description('Generate a markdown sprint report summarizing AI activity')
  .option('-r, --range <range>', 'Date range: 7d, 14d, or 30d', '7d')
  .option('-o, --output <file>', 'Write report to file instead of stdout')
  .option('-f, --format <format>', 'Output format: md, json, or csv', 'md')
  .action(reportCommand);

program.command('verify')
  .description('Health check — show agent config, repo config, mode, sessions, attribution')
  .option('--json', 'Output as JSON')
  .action(verifyCommand);

program.command('verify-install')
  .description('Verify the installed CLI binary against the canonical manifest (tamper check)')
  .option('--json', 'Output as JSON')
  .option('--offline', 'Skip network fetches — only sanity-check what is on disk')
  .action(verifyInstallCommand);

program.command('rework')
  .description('Detect AI-generated code that was reverted or heavily modified (rework hotspots)')
  .option('-d, --days <n>', 'Number of days to look back', '7')
  .option('-l, --limit <n>', 'Max results to show', '20')
  .action(reworkCommand);

program.command('compare <arg1> [arg2]')
  .description('Compare AI attribution between branches or commit ranges')
  .option('--json', 'Output as JSON')
  .action(compareCommand);

program.command('export')
  .description('Export session data as CSV, JSON, or Agent Trace v0.1.0')
  .option('-f, --format <format>', 'Output format (json, csv, agent-trace)', 'json')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('-l, --limit <n>', 'Limit number of sessions')
  .option('-m, --model <name>', 'Filter by model')
  .option('-s, --session <id>', 'Export only a specific session (agent-trace format)')
  .action(exportCommand);

const ignoreCmd = program.command('ignore').description('Manage file ignore patterns for Origin tracking');
ignoreCmd.action(ignoreListCommand);
ignoreCmd.command('add <pattern>').description('Add an ignore pattern to .origin.json').action(ignoreAddCommand);
ignoreCmd.command('remove <pattern>').description('Remove an ignore pattern').action(ignoreRemoveCommand);
ignoreCmd.command('test <filepath>').description('Test if a file would be ignored').action(ignoreTestCommand);

// ─── Backfill ─────────────────────────────────────────────────────────────

program.command('backfill')
  .description('Retroactively tag old commits with AI attribution by matching against agent history and heuristics')
  .option('-d, --days <n>', 'How far back to scan', '90')
  .option('--dry-run', 'Show results without tagging (default behavior)')
  .option('--apply', 'Actually write git notes')
  .option('--min-confidence <level>', 'Only tag commits above this confidence: high, medium, low', 'medium')
  .action(backfillCommand);

// ─── Search & Analysis ───────────────────────────────────────────────────

program.command('search <query>')
  .description('Full-text search across all AI prompt history')
  .option('-l, --limit <n>', 'Max results', '20')
  .option('--from <date>', 'Filter by date (e.g., 7d, 2w, 1m, or 2025-01-01)')
  .option('--agent <name>', 'Filter by agent (claude, cursor, gemini, codex, windsurf, aider)')
  .option('-m, --model <model>', 'Filter by model')
  .option('-r, --repo <path>', 'Filter by repo path')
  .action(searchCommand);

program.command('analyze')
  .description('Analyze AI prompting patterns and metrics')
  .option('-d, --days <n>', 'Number of days to analyze', '30')
  .option('-m, --model <model>', 'Filter by model')
  .option('-e, --export <path>', 'Export results to file')
  .option('--json', 'Output as JSON')
  .action(analyzeCommand);

// ─── Session Browsing ────────────────────────────────────────────────────

program.command('resume [branch]')
  .description('Resume an AI session from a previous branch')
  .option('--launch', 'Auto-launch the AI agent with context')
  .option('--json', 'Output context as JSON')
  .action(resumeCommand);

program.command('rewind')
  .description('Rewind to a previous AI snapshot (time travel)')
  .option('-i, --interactive', 'Interactive snapshot browser')
  .option('-t, --to <sha>', 'Rewind to specific commit SHA')
  .option('--list', 'List snapshots without rewinding')
  .action(rewindCommand);

// ─── Snapshots ────────────────────────────────────────────────────────────

const snapshot = program.command('snapshot').description('Mid-session shadow snapshots (no commits)');
snapshot.action(snapshotSaveCommand);
snapshot.command('list')
  .description('List every snapshot in this repo (use --session <tag> to filter)')
  .option('-s, --session <tag>', 'Only show snapshots for this session tag')
  .action(snapshotListCommand);
snapshot.command('restore <id>')
  .description('Restore working tree to a snapshot')
  .action(snapshotRestoreCommand);
snapshot.command('clean')
  .description('Remove all shadow snapshots')
  .action(snapshotCleanCommand);

program.command('share <sessionId>')
  .description('Create a shareable prompt bundle from a session')
  .option('-p, --prompt <index>', 'Share a specific prompt by index')
  .option('-o, --output <path>', 'Write to file instead of clipboard')
  .option('--public', 'Create a public share URL (requires platform connection)')
  .action(shareCommand);

// ─── Trail System ────────────────────────────────────────────────────────

const trail = program.command('trail').description('Branch-centric work tracking');
trail.action(trailCommand);
trail.command('list')
  .description('List all trails')
  .option('-s, --status <status>', 'Filter by status (active, review, done, paused)')
  .action(trailListCommand);
trail.command('create <name>')
  .description('Create a trail for the current branch')
  .option('-p, --priority <priority>', 'Priority (low, medium, high, critical)', 'medium')
  .option('-l, --label <labels...>', 'Labels to add')
  .action(trailCreateCommand);
trail.command('update')
  .description('Update the current trail')
  .option('-s, --status <status>', 'New status (active, review, done, paused)')
  .option('-p, --priority <priority>', 'New priority')
  .option('-t, --title <title>', 'New title')
  .action(trailUpdateCommand);
trail.command('assign <user>')
  .description('Assign a reviewer to the current trail')
  .action(trailAssignCommand);
trail.command('label <labels...>')
  .description('Add labels to the current trail')
  .action(trailLabelCommand);

// ─── Config ──────────────────────────────────────────────────────────────

const config = program.command('config').description('Manage Origin configuration');
config.command('get <key>')
  .description('Get a config value')
  .action(configGetCommand);
config.command('set <key> <value>')
  .description('Set a config value')
  .action(configSetCommand);
config.command('list')
  .description('List all config values')
  .action(configListCommand);

// ─── Database ────────────────────────────────────────────────────────────

const db = program.command('db').description('Local prompt database management');
db.command('import')
  .description('Import prompts from origin-sessions branch into local DB')
  .option('-f, --format <format>', 'Import format (default: origin-sessions, or agent-trace)')
  .option('--file <path>', 'Input file (for agent-trace format; otherwise reads stdin)')
  .action(dbImportCommand);
db.command('stats')
  .description('Show local database statistics')
  .action(dbStatsCommand);

// ─── CI/CD Integration ──────────────────────────────────────────────────

const ci = program.command('ci').description('CI/CD integration for AI attribution');
ci.command('check')
  .description('Report AI attribution stats (run in CI)')
  .option('-r, --range <range>', 'Commit range to check')
  .action(ciCheckCommand);
ci.command('squash-merge <baseBranch>')
  .description('Preserve attribution through squash merge')
  .action(ciSquashMergeCommand);
ci.command('generate-workflow')
  .description('Generate GitHub Actions workflow snippet')
  .action(ciGenerateWorkflowCommand);
ci.command('session-check')
  .description('Verify all commits have linked Origin sessions (tamper detection)')
  .option('--since <commit>', 'Check from specific commit instead of branch point')
  .option('--warn-only', 'Exit 0 even if commits lack sessions (print warning only)')
  .option('--json', 'Output results as JSON')
  .action(ciSessionCheckCommand);

// ─── Plugin System ───────────────────────────────────────────────────────

const plugin = program.command('plugin').description('External agent plugin management');
plugin.command('list')
  .description('List installed plugins')
  .action(pluginListCommand);
plugin.command('install <name> <command>')
  .description('Install an external agent plugin')
  .action(pluginInstallCommand);
plugin.command('remove <name>')
  .description('Remove an installed plugin')
  .action(pluginRemoveCommand);

// ─── Git Proxy ───────────────────────────────────────────────────────────

const proxy = program.command('proxy').description('Transparent git proxy for attribution tracking');
proxy.command('install')
  .description('Install git proxy wrapper (adds ~/.origin/bin to PATH)')
  .action(proxyInstallCommand);
proxy.command('uninstall')
  .description('Remove git proxy wrapper')
  .action(proxyUninstallCommand);
proxy.command('status')
  .description('Show proxy installation status')
  .action(proxyStatusCommand);

// ─── Upgrade ─────────────────────────────────────────────────────────────

program.command('upgrade')
  .description('Upgrade Origin CLI to latest version')
  .option('--check', 'Only check for updates, do not install')
  .option('--dry-run', 'Show what would be downloaded and installed without touching anything')
  .option('--rollback', 'Re-install the previous version from the last backup')
  .action(upgradeCommand);

// ─── Internal Hook Handlers ──────────────────────────────────────────────

const hooks = program.command('hooks').description('Internal hook handlers (used by AI agents)');
hooks.command('claude-code <event>').description('Handle Claude Code hook event').action((event) => hooksCommand(event, 'claude-code'));
hooks.command('cursor <event>').description('Handle Cursor hook event').action((event) => hooksCommand(event, 'cursor'));
hooks.command('gemini <event>').description('Handle Gemini CLI hook event').action((event) => hooksCommand(event, 'gemini'));
hooks.command('codex <event>').description('Handle Codex CLI hook event').action((event) => hooksCommand(event, 'codex'));
hooks.command('windsurf <event>').description('Handle Windsurf hook event').action((event) => hooksCommand(event, 'windsurf'));
hooks.command('aider <event>').description('Handle Aider hook event').action((event) => hooksCommand(event, 'aider'));
hooks.command('git-pre-commit').description('Handle git pre-commit hook (secret scan)').action(() => handlePreCommit());
hooks.command('git-prepare-commit-msg <msgFile> [source] [sha]')
  .description('Handle git prepare-commit-msg hook (writes Origin-Session trailer)')
  .action((msgFile: string, source?: string) => handlePrepareCommitMsg(msgFile, source));
hooks.command('git-post-commit').description('Handle git post-commit hook').action(() => handlePostCommit());
hooks.command('git-pre-push').description('Handle git pre-push hook').action(() => handlePrePush());
hooks.command('git-post-rewrite').description('Handle git post-rewrite hook (rebase/amend)').action(async () => {
  const { preserveAttributionBatch, parseRewriteInput, handleCherryPick } = await import('./history-preservation.js');
  const { getGitRoot } = await import('./session-state.js');
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) return;
  // Read old-sha new-sha pairs from stdin
  let input = '';
  try {
    input = require('fs').readFileSync(0, 'utf-8');
  } catch { /* no stdin */ }
  if (input) {
    const mappings = parseRewriteInput(input);
    preserveAttributionBatch(repoPath, mappings);
  }
  // Also check for cherry-pick context
  handleCherryPick(repoPath);
});
hooks.command('git-post-checkout').description('Handle git post-checkout hook').action(async () => {
  const { handlePostCheckout } = await import('./history-preservation.js');
  const { getGitRoot } = await import('./session-state.js');
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) return;
  const args = process.argv.slice(process.argv.indexOf('git-post-checkout') + 1);
  const prevHead = args[0] || '';
  const newHead = args[1] || '';
  handlePostCheckout(repoPath, prevHead, newHead);
});

// ─── Sessions ────────────────────────────────────────────────────────────

const sessions = program.command('sessions').description('List coding sessions');
sessions
  .option('-s, --status <status>', 'Filter by status (unreviewed, approved, rejected, flagged)')
  .option('-m, --model <model>', 'Filter by model')
  .option('-l, --limit <n>', 'Max results', '20')
  .option('-a, --all', 'Show sessions from all repos (default: current repo only)')
  .option('-g, --global', 'Alias for --all')
  .option('--local', 'Show only local sessions (not synced to Origin)')
  .option('--source', 'Show source column (local/origin) for each session')
  .action(sessionsCommand);

program.command('session <id>').description('View session detail').action(sessionDetailCommand);

sessions.command('end <sessionId>').description('End a running session').action(sessionEndCommand);
sessions.command('clean')
  .description('End all stale RUNNING sessions')
  .option('--all', 'End all running sessions across all repos')
  .action(sessionCleanCommand);

program.command('review <sessionId>')
  .description('Review a coding session')
  .option('--approve', 'Approve the session')
  .option('--reject', 'Reject the session')
  .option('--flag', 'Flag the session for review')
  .option('-n, --note <note>', 'Review note')
  .action(reviewCommand);

program.command('review-pr <url>')
  .description('Analyze AI sessions behind a GitHub PR')
  .action(reviewPRCommand);

program.command('intent-review [branch]')
  .description('Intent-based review — shows WHY code was written (prompts, reasoning, risk) not just WHAT changed')
  .option('-f, --format <format>', 'Output format: json, md (default: terminal)')
  .option('-o, --output <file>', 'Write output to file')
  .action(intentReviewCommand);

// ─── Repos ───────────────────────────────────────────────────────────────

const repos = program.command('repos').description('List repositories');
repos.action(reposCommand);

program.command('repo:add')
  .description('Add a repository')
  .requiredOption('--name <name>', 'Repository name')
  .requiredOption('--path <path>', 'Repository path')
  .option('--provider <provider>', 'Provider (local, github)', 'local')
  .action(repoAddCommand);

program.command('sync').description('Sync session data from current repo').action(syncCommand);

// ─── Agents ──────────────────────────────────────────────────────────────

const agents = program.command('agents').description('List agents');
agents.action(agentsCommand);

program.command('agent:create')
  .description('Create a new agent')
  .requiredOption('--name <name>', 'Agent name')
  .requiredOption('--slug <slug>', 'Agent slug')
  .requiredOption('--model <model>', 'AI model')
  .option('--description <desc>', 'Description')
  .action(agentCreateCommand);

// ─── Policies ────────────────────────────────────────────────────────────

program.command('policies').description('List active policies').action(policiesCommand);

// ─── Audit ───────────────────────────────────────────────────────────────

program.command('audit')
  .description('Generate compliance audit trail (SOC 2, ISO 27001, GDPR)')
  .option('--from <date>', 'Start date (YYYY-MM-DD, default: 30 days ago)')
  .option('--to <date>', 'End date (YYYY-MM-DD, default: today)')
  .option('--author <name>', 'Filter by author name')
  .option('--agent <name>', 'Filter by agent name')
  .option('-f, --format <format>', 'Output format: md, json, csv', 'md')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(auditCommand);

// ─── Versioning ──────────────────────────────────────────────────────────

program.command('policy:versions <id>')
  .description('View version history for a policy')
  .action(async (id: string) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getPolicyVersions(id);
      if (!data.versions?.length) {
        console.log(chalk.gray('No version history.'));
        return;
      }
      for (const v of data.versions) {
        console.log(`${chalk.bold(`v${v.version}`)} ${chalk.gray(v.changeType)} — ${chalk.gray(new Date(v.createdAt).toLocaleString())}`);
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

program.command('agent:versions <id>')
  .description('View version history for an agent')
  .action(async (id: string) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getAgentVersions(id);
      if (!data.versions?.length) {
        console.log(chalk.gray('No version history.'));
        return;
      }
      for (const v of data.versions) {
        console.log(`${chalk.bold(`v${v.version}`)} ${chalk.gray(v.changeType)} — ${chalk.gray(new Date(v.createdAt).toLocaleString())}`);
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

// ─── Notifications ───────────────────────────────────────────────────────

program.command('notifications')
  .description('View notifications')
  .option('--unread', 'Show unread only')
  .option('-l, --limit <n>', 'Max results', '20')
  .action(async (opts: any) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const params: Record<string, string> = { limit: opts.limit };
      if (opts.unread) params.unread = 'true';
      const data = await api.getNotifications(params);
      if (!data.notifications?.length) {
        console.log(chalk.gray('No notifications.'));
        return;
      }
      for (const n of data.notifications) {
        const unread = n.read ? ' ' : chalk.blue('●');
        console.log(`${unread} ${chalk.bold(n.title)} — ${n.message} ${chalk.gray(new Date(n.createdAt).toLocaleString())}`);
      }
      console.log(chalk.gray(`\n${data.total} total`));
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

// ─── Team / Users ────────────────────────────────────────────────────────

program.command('team')
  .description('List team members')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getUsers();
      if (!data.users?.length) {
        console.log(chalk.gray('No team members.'));
        return;
      }
      for (const u of data.users) {
        const role = u.role === 'OWNER' ? chalk.magenta(u.role) : u.role === 'ADMIN' ? chalk.yellow(u.role) : chalk.blue(u.role);
        console.log(`  ${chalk.bold(u.name)} ${chalk.gray(`<${u.email}>`)} ${role} — ${u.sessions} sessions, ${u.reviews} reviews, $${u.totalCost.toFixed(2)}`);
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

program.command('user <id>')
  .description('View user detail')
  .action(async (id: string) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getUser(id);
      const u = data.user;
      console.log(`\n  ${chalk.bold(u.name)} ${chalk.gray(`<${u.email}>`)}`);
      console.log(`  Role: ${u.role}  Member since: ${new Date(u.createdAt).toLocaleDateString()}`);
      console.log(`\n  Sessions: ${u.stats.sessions}  Reviews: ${u.stats.reviews}  Cost: $${u.stats.totalCost.toFixed(2)}  Lines: +${u.stats.linesAdded}`);
      if (data.sessions?.length) {
        console.log(chalk.gray('\n  Recent Sessions:'));
        for (const s of data.sessions.slice(0, 5)) {
          const status = s.review?.status || 'pending';
          console.log(`    ${chalk.blue(s.model)} ${s.repoName || '—'} $${s.costUsd.toFixed(2)} ${chalk.gray(status)} ${chalk.gray(new Date(s.createdAt).toLocaleString())}`);
        }
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

// ─── Convenience command: unified context view ─────────────────────────
// `context` is a convenience aggregator that shows handoff + memory side by
// side. It does NOT replace `handoff` or `memory` — both remain primary,
// top-level commands for users who want just one or the other.
const context = program.command('context')
  .description('Cross-agent context — handoff + accumulated session memory');
context.action(async () => {
  // Default: show both handoff and memory in one view
  console.log('\x1b[2m→ Handoff:\x1b[0m');
  await handoffShowCommand();
  console.log('\n\x1b[2m→ Memory:\x1b[0m');
  await memoryShowCommand({});
});
context.command('show')
  .description('Show handoff + session memory for this repo')
  .option('-l, --limit <n>', 'Number of memory sessions to show', '10')
  .action(async (opts) => {
    console.log('\x1b[2m→ Handoff:\x1b[0m');
    await handoffShowCommand();
    console.log('\n\x1b[2m→ Memory:\x1b[0m');
    await memoryShowCommand(opts);
  });
context.command('handoff')
  .description('Show only cross-agent handoff context')
  .action(handoffShowCommand);
context.command('memory')
  .description('Show only accumulated session memory')
  .option('-l, --limit <n>', 'Number of sessions to show', '10')
  .action(memoryShowCommand);
context.command('clear')
  .description('Clear handoff and memory for this repo')
  .option('--handoff-only', 'Clear only handoff')
  .option('--memory-only', 'Clear only memory')
  .action(async (opts: { handoffOnly?: boolean; memoryOnly?: boolean }) => {
    if (opts.memoryOnly) {
      await memoryClearCommand();
    } else if (opts.handoffOnly) {
      await handoffClearCommand();
    } else {
      await handoffClearCommand();
      await memoryClearCommand();
    }
  });

// ─── Help categorization ────────────────────────────────────────────────
// Every command does unique work and stays top-level. The long flat list in
// `--help` is overwhelming, so we group commands by purpose in a custom help
// section appended below the default command list. Commander still enumerates
// every command above; this is purely extra guidance.
//
// Rule for picking groups: which primary job does a user have when they reach
// for this command? A command appears in exactly one group.
const COMMAND_GROUPS: Array<{ label: string; commands: string[] }> = [
  {
    label: 'SETUP',
    commands: ['login', 'init', 'enable', 'disable', 'link', 'attach', 'whoami', 'status'],
  },
  {
    label: 'ATTRIBUTION',
    commands: ['blame', 'diff', 'stats', 'compare', 'ask', 'why', 'prompts', 'search'],
  },
  {
    label: 'SESSIONS',
    commands: ['sessions', 'session', 'session-compare', 'log', 'show', 'explain', 'share', 'resume'],
  },
  {
    label: 'REVIEW',
    commands: ['review', 'review-pr', 'intent-review'],
  },
  {
    label: 'TRACKING',
    commands: ['issue', 'todo', 'trail', 'handoff', 'memory', 'context'],
  },
  {
    label: 'ANALYTICS',
    commands: ['recap', 'report', 'analyze', 'rework'],
  },
  {
    label: 'TIME TRAVEL',
    commands: ['rewind', 'snapshot'],
  },
  {
    label: 'CHAT / AI',
    commands: ['chat'],
  },
  {
    label: 'DATA',
    commands: ['export', 'backfill', 'db'],
  },
  {
    label: 'GOVERNANCE',
    commands: ['policies', 'audit', 'ignore'],
  },
  {
    label: 'INTEGRATIONS',
    commands: ['repos', 'agents', 'sync', 'config', 'proxy', 'ci', 'plugin', 'web'],
  },
  {
    label: 'HEALTH',
    commands: ['doctor', 'verify', 'verify-install', 'clean', 'reset'],
  },
  {
    label: 'SHELL',
    commands: ['prompt-status', 'shell-prompt'],
  },
  {
    label: 'META',
    commands: ['version', 'upgrade', 'hooks'],
  },
];

program.addHelpText('after', () => {
  const allRegistered = new Map<string, Command>();
  for (const cmd of program.commands) {
    allRegistered.set(cmd.name(), cmd);
  }
  const lines: string[] = ['', 'Commands by purpose:'];
  for (const group of COMMAND_GROUPS) {
    const entries = group.commands
      .map((name) => allRegistered.get(name))
      .filter((cmd): cmd is Command => !!cmd)
      .map((cmd) => {
        const desc = (cmd.description() || '').split('\n')[0];
        return `    ${cmd.name().padEnd(18)} ${desc}`;
      });
    if (entries.length === 0) continue;
    lines.push('');
    lines.push(`  ${group.label}`);
    lines.push(...entries);
  }
  return lines.join('\n');
});

// ─── Version Check (post-action) ────────────────────────────────────────

program.hook('postAction', async () => {
  try {
    const result = await checkForUpdate();
    if (result?.updateAvailable) {
      const chalk = (await import('chalk')).default;
      console.log(chalk.yellow(`\n  Update available: ${result.current} → ${result.latest}`));
      console.log(chalk.gray(`  Run: origin upgrade\n`));
    }
  } catch { /* never fail */ }
});

program.parse();
