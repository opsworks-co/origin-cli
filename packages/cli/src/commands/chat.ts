import chalk from 'chalk';
import readline from 'readline';
import { execSync } from 'child_process';
import { getGitRoot, getBranch } from '../session-state.js';
import { loadConfig, loadAgentConfig } from '../config.js';
import { getAllPrompts, searchPrompts, getPromptsBySession } from '../local-db.js';

/**
 * origin chat — Interactive AI assistant for your repo's AI context.
 *
 * Ask natural language questions about:
 * - Who/what wrote specific code
 * - Session history and prompts
 * - AI vs human stats
 * - Cost and token usage
 * - Policy compliance
 *
 * Uses Anthropic API (ANTHROPIC_API_KEY env var).
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function gatherRepoContext(cwd: string): string {
  const repoRoot = getGitRoot(cwd);
  if (!repoRoot) return 'Not inside a git repository.';

  const parts: string[] = [];
  const branch = getBranch(cwd);
  parts.push(`Repository: ${repoRoot}`);
  if (branch) parts.push(`Branch: ${branch}`);

  // Git notes count
  try {
    const noteCount = execSync('git notes --ref=origin list 2>/dev/null | wc -l', {
      encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    parts.push(`AI-annotated commits: ${noteCount}`);
  } catch { /* ignore */ }

  // Recent AI commits with notes
  try {
    const log = execSync('git log --format="%H|%aI|%s|%an" -30 2>/dev/null', {
      encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (log) {
      const commits = log.split('\n').filter(Boolean);
      const aiCommits: string[] = [];
      const humanCommits: string[] = [];
      for (const line of commits) {
        const [sha, date, msg, author] = line.split('|');
        try {
          const note = execSync(`git notes --ref=origin show ${sha} 2>/dev/null`, {
            encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          const parsed = JSON.parse(note);
          const data = parsed.origin || parsed;
          aiCommits.push(`  ${sha.slice(0, 8)} ${date.slice(0, 10)} [${data.model || 'AI'}] ${msg} (session: ${data.sessionId || 'unknown'})`);
        } catch {
          humanCommits.push(`  ${sha.slice(0, 8)} ${date.slice(0, 10)} [Human: ${author}] ${msg}`);
        }
      }
      if (aiCommits.length > 0) {
        parts.push(`\nRecent AI commits (${aiCommits.length}):`);
        parts.push(...aiCommits.slice(0, 15));
      }
      if (humanCommits.length > 0) {
        parts.push(`\nRecent Human commits (${humanCommits.length}):`);
        parts.push(...humanCommits.slice(0, 10));
      }
    }
  } catch { /* ignore */ }

  // Session list from origin-sessions branch
  try {
    const tree = execSync('git ls-tree --name-only origin-sessions:sessions/ 2>/dev/null', {
      encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (tree) {
      const sessions = tree.split('\n').filter(Boolean);
      parts.push(`\nTracked sessions: ${sessions.length}`);
      // Get metadata for recent sessions
      for (const sid of sessions.slice(-10)) {
        try {
          const meta = execSync(`git show origin-sessions:sessions/${sid}/metadata.json 2>/dev/null`, {
            encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (meta) {
            const m = JSON.parse(meta);
            parts.push(`  ${sid}: model=${m.model || '?'}, cost=$${m.costUsd?.toFixed(4) || '?'}, tokens=${m.tokensUsed || '?'}`);
          }
        } catch {
          parts.push(`  ${sid}`);
        }
      }
    }
  } catch { /* ignore */ }

  // Local DB prompts summary
  try {
    const allPrompts = getAllPrompts();
    if (allPrompts.length > 0) {
      parts.push(`\nPrompt database: ${allPrompts.length} prompts stored`);
      // Model breakdown
      const models: Record<string, number> = {};
      for (const p of allPrompts) {
        models[p.model] = (models[p.model] || 0) + 1;
      }
      for (const [model, count] of Object.entries(models)) {
        parts.push(`  ${model}: ${count} prompts`);
      }
    }
  } catch { /* ignore */ }

  // Agent config
  const agentConfig = loadAgentConfig();
  if (agentConfig) {
    parts.push(`\nAgent: ${agentConfig.hostname}, tools: ${agentConfig.detectedTools.join(', ') || 'none'}`);
  }

  // Stats summary
  try {
    const shortlog = execSync('git shortlog -sn --all 2>/dev/null | head -10', {
      encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (shortlog) {
      parts.push(`\nCommit authors:\n${shortlog}`);
    }
  } catch { /* ignore */ }

  return parts.join('\n');
}

async function callAnthropic(
  messages: ChatMessage[],
  systemPrompt: string,
  apiKey: string
): Promise<string> {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  return data.content?.[0]?.text || '(no response)';
}

function getApiKey(): string | null {
  // 1. Environment variable
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // 2. Origin config
  const config = loadConfig();
  if (config && (config as any).anthropicApiKey) return (config as any).anthropicApiKey;

  return null;
}

export async function chatCommand(opts: { question?: string }) {
  const cwd = process.cwd();
  const apiKey = getApiKey();

  if (!apiKey) {
    console.log(chalk.bold('\n  Origin Chat\n'));
    console.log(chalk.red('  No API key found. Set ANTHROPIC_API_KEY environment variable:'));
    console.log(chalk.gray('\n  export ANTHROPIC_API_KEY=sk-ant-...\n'));
    console.log(chalk.gray('  Or add to your shell profile (~/.zshrc or ~/.bashrc)'));
    process.exit(1);
  }

  // Gather repo context
  const context = gatherRepoContext(cwd);

  const systemPrompt = `You are Origin Chat, an AI assistant built into the Origin CLI. You help developers understand their AI-authored code.

You have access to the following context about the user's repository and AI coding sessions:

${context}

Your capabilities:
- Answer questions about which AI wrote specific code
- Summarize session history, costs, and token usage
- Explain AI vs human code distribution
- Help find specific prompts or sessions
- Provide insights about AI coding patterns

Guidelines:
- Be concise and direct
- Use specific data from the context when possible
- Reference commit SHAs, session IDs, and model names
- If you don't have enough data, suggest Origin commands the user can run
- Format output for terminal (no markdown headers, use plain text)`;

  // Single question mode
  if (opts.question) {
    console.log(chalk.bold('\n  Origin Chat\n'));
    try {
      const response = await callAnthropic(
        [{ role: 'user', content: opts.question }],
        systemPrompt,
        apiKey
      );
      console.log(chalk.white(`  ${response.replace(/\n/g, '\n  ')}`));
      console.log('');
    } catch (err: any) {
      console.log(chalk.red(`  Error: ${err.message}`));
    }
    return;
  }

  // Interactive mode
  console.log(chalk.bold('\n  Origin Chat') + chalk.gray(' — ask anything about your AI-authored code\n'));
  console.log(chalk.gray('  Type your question and press Enter. Type "exit" or Ctrl+C to quit.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: ChatMessage[] = [];

  const askQuestion = () => {
    rl.question(chalk.cyan('  you > '), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        console.log(chalk.gray('\n  Goodbye.\n'));
        rl.close();
        return;
      }

      messages.push({ role: 'user', content: trimmed });

      try {
        // Show thinking indicator
        process.stdout.write(chalk.gray('  thinking...'));

        const response = await callAnthropic(messages, systemPrompt, apiKey);

        // Clear thinking indicator
        process.stdout.write('\r' + ' '.repeat(30) + '\r');

        messages.push({ role: 'assistant', content: response });

        // Print response with indentation
        const lines = response.split('\n');
        for (const line of lines) {
          console.log(chalk.white(`  ${line}`));
        }
        console.log('');
      } catch (err: any) {
        process.stdout.write('\r' + ' '.repeat(30) + '\r');
        console.log(chalk.red(`  Error: ${err.message}\n`));
      }

      askQuestion();
    });
  };

  askQuestion();
}
