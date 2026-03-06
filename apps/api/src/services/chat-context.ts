import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Docs Context — cached in memory, loaded once
// ---------------------------------------------------------------------------

let cachedDocsContext: string | null = null;

export function getDocsContext(): string {
  if (cachedDocsContext) return cachedDocsContext;

  const docsDir = path.join(__dirname, '../../../../docs');
  const files = ['API.md', 'CLI.md', 'INTEGRATIONS.md', 'MCP_SERVER.md', 'POLICIES.md'];

  let content = `Origin is an AI Agent Governance Platform that gives CTOs and CSOs full visibility into every AI coding session — what was prompted, what was built, and whether it followed the rules.

Key capabilities:
- Full session replay (prompts, responses, tool calls, files changed)
- Policy enforcement (file access, model allowlists, cost limits, review requirements)
- Complete audit trail for SOC 2 and compliance
- GitHub integration with PR status checks and comments
- Agent management with versioning, system prompts, and permissions
- Budget and cost controls per org/agent
- AI auto-review with risk assessment
- Real-time session streaming via SSE
- CLI with 15 commands and MCP server with 12 tools
- Team management with RBAC (Admin, Member, Viewer roles)

`;

  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(docsDir, file), 'utf-8');
      content += `\n--- ${file} ---\n${text}\n`;
    } catch {
      // skip missing files
    }
  }

  cachedDocsContext = content;
  return content;
}

// ---------------------------------------------------------------------------
// Org Context — fetched fresh per request for authenticated assistant
// ---------------------------------------------------------------------------

export async function getOrgContext(orgId: string): Promise<string> {
  const [org, policies, agents, recentSessions, sessionStats] = await Promise.all([
    prisma.org.findUnique({
      where: { id: orgId },
      include: { repos: { select: { name: true, path: true, provider: true } } },
    }),
    prisma.policy.findMany({
      where: { orgId },
      include: { rules: { include: { agent: { select: { name: true } } } } },
      take: 20,
    }),
    prisma.agent.findMany({
      where: { orgId },
      select: { id: true, name: true, slug: true, model: true, status: true, _count: { select: { sessions: true } } },
      take: 20,
    }),
    prisma.codingSession.findMany({
      where: { commit: { repo: { orgId } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        review: { select: { status: true, note: true } },
        commit: { select: { message: true, repo: { select: { name: true } } } },
        agent: { select: { name: true } },
      },
    }),
    prisma.codingSession.aggregate({
      where: { commit: { repo: { orgId } } },
      _sum: { costUsd: true, tokensUsed: true },
      _count: true,
      _avg: { costUsd: true },
    }),
  ]);

  let context = `=== Organization: ${org?.name} (${org?.slug}) ===\n\n`;

  // Repositories
  const repos = org?.repos || [];
  context += `Repositories (${repos.length}):\n`;
  repos.forEach(r => {
    context += `  - ${r.name} (${r.provider})\n`;
  });

  // Agents
  context += `\nAgents (${agents.length}):\n`;
  agents.forEach(a => {
    context += `  - ${a.name} [${a.slug}] — model: ${a.model}, status: ${a.status}, sessions: ${a._count.sessions}\n`;
  });

  // Policies
  context += `\nPolicies (${policies.length}):\n`;
  policies.forEach(p => {
    context += `  - ${p.name} (${p.type}, ${p.active ? 'active' : 'inactive'}) — ${p.rules.length} rules\n`;
    p.rules.forEach(r => {
      const agentScope = r.agent ? ` [agent: ${r.agent.name}]` : '';
      context += `    Rule: ${r.condition} → ${r.action} (${r.severity})${agentScope}\n`;
    });
  });

  // Recent sessions
  context += `\nRecent Sessions (last 10):\n`;
  recentSessions.forEach(s => {
    const reviewStatus = s.review?.status || 'pending';
    const agentName = s.agent?.name || 'unknown';
    const repoName = s.commit?.repo?.name || 'unknown';
    context += `  - [${reviewStatus}] ${s.model} in ${repoName} by ${agentName} — $${s.costUsd.toFixed(2)}, ${s.tokensUsed} tokens\n`;
    context += `    Commit: ${s.commit?.message?.slice(0, 80) || '(no message)'}\n`;
    if (s.review?.note) {
      context += `    Review note: ${s.review.note.slice(0, 100)}\n`;
    }
  });

  // Aggregate stats
  context += `\nOverall Stats:\n`;
  context += `  Total sessions: ${sessionStats._count}\n`;
  context += `  Total cost: $${(sessionStats._sum.costUsd || 0).toFixed(2)}\n`;
  context += `  Total tokens: ${(sessionStats._sum.tokensUsed || 0).toLocaleString()}\n`;
  context += `  Avg cost per session: $${(sessionStats._avg.costUsd || 0).toFixed(2)}\n`;

  return context;
}
