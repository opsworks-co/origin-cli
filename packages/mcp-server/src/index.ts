#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, loadAgentConfig } from './config.js';
import { fetchPolicies, startSession, endSession, updateSession, reportViolation, logToolCall, listSessions, getSession, reviewSession, listAgents, listRepos, getStats, listAuditLogs, getPolicyVersions, getAgentVersions, listNotifications, getUnreadCount, listUsers } from './api.js';

interface PolicyData {
  id: string;
  name: string;
  type: string;
  description?: string;
  rules: Array<{ condition: string; action: string; severity: string }>;
}

let policies: PolicyData[] = [];
let currentSessionId: string | null = null;
let machineId: string = '';

async function loadPolicies() {
  try {
    const data = await fetchPolicies() as any;
    policies = data.policies || [];
  } catch (err) {
    console.error('[origin-mcp] Failed to load policies:', err);
    policies = [];
  }
}

function formatPoliciesText(): string {
  if (policies.length === 0) return 'No active governance policies.';

  let text = 'ORIGIN GOVERNANCE POLICIES (read these before starting work):\n\n';
  policies.forEach((p, i) => {
    text += `${i + 1}. ${p.type}: ${p.name}`;
    if (p.description) text += ` — ${p.description}`;
    text += '\n';
    for (const rule of p.rules) {
      try {
        const cond = JSON.parse(rule.condition);
        text += `   Condition: ${JSON.stringify(cond)}, Action: ${rule.action}, Severity: ${rule.severity}\n`;
      } catch {
        text += `   Condition: ${rule.condition}, Action: ${rule.action}\n`;
      }
    }
  });
  text += '\nThese policies are enforced by your organization via Origin. Violations are logged.';
  return text;
}

function checkFileAgainstPolicies(filepath: string, _action: string): { allowed: boolean; policy: string | null; requiresReview: boolean } {
  for (const p of policies) {
    if (p.type !== 'FILE_RESTRICTION' && p.type !== 'REQUIRE_REVIEW') continue;
    for (const rule of p.rules) {
      try {
        const cond = JSON.parse(rule.condition);
        if (cond.path) {
          // Simple glob matching: convert ** to regex
          const pattern = cond.path.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
          const regex = new RegExp(`^${pattern}$`);
          if (regex.test(filepath)) {
            if (rule.action === 'BLOCK') {
              return { allowed: false, policy: p.name, requiresReview: false };
            }
            if (rule.action === 'REQUIRE_REVIEW' || p.type === 'REQUIRE_REVIEW') {
              return { allowed: true, policy: p.name, requiresReview: true };
            }
          }
        }
      } catch {}
    }
  }
  return { allowed: true, policy: null, requiresReview: false };
}

// Create the server
const server = new Server(
  { name: 'origin-mcp-server', version: '0.1.0' },
  { capabilities: { resources: {}, tools: {} } }
);

// -- Resources --

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'origin://policies', name: 'Origin Governance Policies', description: 'Active governance policies for your organization', mimeType: 'text/plain' },
    { uri: 'origin://session', name: 'Current Session', description: 'Current coding session metadata', mimeType: 'application/json' },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === 'origin://policies') {
    await loadPolicies();
    return { contents: [{ uri, mimeType: 'text/plain', text: formatPoliciesText() }] };
  }

  if (uri === 'origin://session') {
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ sessionId: currentSessionId, machineId, startTime: new Date().toISOString() }),
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// -- Tools --

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'check_file_access',
      description: 'Check if a file path is restricted by any Origin governance policy',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filepath: { type: 'string', description: 'File path to check' },
          action: { type: 'string', enum: ['read', 'write', 'delete'], description: 'Action to check' },
        },
        required: ['filepath', 'action'],
      },
    },
    {
      name: 'report_violation',
      description: 'Report a policy violation to Origin',
      inputSchema: {
        type: 'object' as const,
        properties: {
          policy_id: { type: 'string', description: 'ID of the violated policy' },
          description: { type: 'string', description: 'Description of the violation' },
          filepath: { type: 'string', description: 'File path involved' },
        },
        required: ['policy_id', 'description', 'filepath'],
      },
    },
    {
      name: 'start_session',
      description: 'Start a new coding session with Origin tracking',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: 'The human prompt/goal' },
          model: { type: 'string', description: 'AI model being used' },
          repoPath: { type: 'string', description: 'Path to the git repository' },
        },
        required: ['prompt', 'model', 'repoPath'],
      },
    },
    {
      name: 'end_session',
      description: 'End the current coding session. Pass `transcript` (JSON string of [{role, content}, …]) to capture the full conversation; without it the Session tab only shows your prompt and the diff.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: { type: 'string', description: 'Session ID to end' },
          summary: { type: 'string', description: 'Summary of what was done' },
          transcript: { type: 'string', description: 'Full conversation transcript as a JSON string of [{role:"user"|"assistant", content:"..."}, …]. Use [Tool: name] / [Output] / [Reasoning] line markers inside content for tool calls, results, and chain-of-thought.' },
          tokensUsed: { type: 'number', description: 'Total tokens used in session' },
          inputTokens: { type: 'number', description: 'Input tokens (prompt)' },
          outputTokens: { type: 'number', description: 'Output tokens (completion)' },
          cacheReadTokens: { type: 'number', description: 'Cache read tokens' },
          cacheCreationTokens: { type: 'number', description: 'Cache write tokens' },
          toolCalls: { type: 'number', description: 'Number of tool calls made' },
          linesAdded: { type: 'number', description: 'Lines of code added' },
          linesRemoved: { type: 'number', description: 'Lines of code removed' },
          costUsd: { type: 'number', description: 'Estimated cost in USD' },
          filesChanged: { type: 'string', description: 'JSON array of changed file paths' },
          durationMs: { type: 'number', description: 'Session duration in milliseconds' },
        },
        required: ['sessionId', 'summary'],
      },
    },
    {
      name: 'update_session',
      description: 'Incrementally update an active session with live transcript / token / file changes. Call this after each turn so the Session tab reflects state in real-time instead of waiting for end_session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: { type: 'string', description: 'Session ID to update' },
          transcript: { type: 'string', description: 'Full conversation transcript so far as a JSON string of [{role, content}, …]' },
          prompt: { type: 'string', description: 'Latest or accumulated user prompt(s)' },
          filesChanged: { type: 'array', items: { type: 'string' }, description: 'Changed file paths' },
          tokensUsed: { type: 'number' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
          cacheReadTokens: { type: 'number' },
          cacheCreationTokens: { type: 'number' },
          toolCalls: { type: 'number' },
          linesAdded: { type: 'number' },
          linesRemoved: { type: 'number' },
          model: { type: 'string' },
          durationMs: { type: 'number' },
          costUsd: { type: 'number' },
          branch: { type: 'string', description: 'Current git branch (updates dashboard mid-session)' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'log_tool_call',
      description: 'Log a tool call for the audit trail',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: { type: 'string', description: 'Current session ID' },
          tool: { type: 'string', description: 'Tool name' },
          args: { type: 'string', description: 'Tool arguments (JSON)' },
          result: { type: 'string', description: 'Tool result (JSON)' },
        },
        required: ['sessionId', 'tool', 'args', 'result'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List recent AI coding sessions with optional filters',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['unreviewed', 'reviewed', 'approved', 'rejected', 'flagged'], description: 'Filter by review status' },
          model: { type: 'string', description: 'Filter by AI model' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'get_session',
      description: 'Get full details of a specific coding session including transcript, files changed, and review status',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'review_session',
      description: 'Approve, reject, or flag a coding session',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID to review' },
          status: { type: 'string', enum: ['APPROVED', 'REJECTED', 'FLAGGED'], description: 'Review status' },
          note: { type: 'string', description: 'Optional review note' },
        },
        required: ['session_id', 'status'],
      },
    },
    {
      name: 'list_agents',
      description: 'List all registered AI coding agents in the organization',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'list_repos',
      description: 'List all connected code repositories',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'get_stats',
      description: 'Get dashboard statistics: sessions this week, active agents, costs, AI authorship %, unreviewed count',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'get_audit_log',
      description: 'View recent audit log entries for the organization',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', description: 'Filter by action type (e.g. AGENT_CREATED, POLICY_UPDATED)' },
          limit: { type: 'number', description: 'Max entries (default 30)' },
        },
      },
    },
    {
      name: 'get_policy_versions',
      description: 'View version history for a policy',
      inputSchema: {
        type: 'object' as const,
        properties: {
          policy_id: { type: 'string', description: 'Policy ID' },
        },
        required: ['policy_id'],
      },
    },
    {
      name: 'get_agent_versions',
      description: 'View version history for an agent',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent ID' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'list_notifications',
      description: 'View notifications for the current user',
      inputSchema: {
        type: 'object' as const,
        properties: {
          unread: { type: 'boolean', description: 'Only show unread notifications' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'list_users',
      description: 'List all team members in the organization with activity stats',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'check_file_access': {
      const result = checkFileAgainstPolicies(args?.filepath as string, args?.action as string);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'report_violation': {
      try {
        await reportViolation({
          machineId,
          policyId: args?.policy_id as string,
          description: args?.description as string,
          filepath: args?.filepath as string,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ allowed: false, message: 'Violation reported to Origin' }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'start_session': {
      try {
        const result = await startSession({
          machineId,
          prompt: args?.prompt as string,
          model: args?.model as string,
          repoPath: args?.repoPath as string,
        }) as any;
        currentSessionId = result.sessionId;
        return { content: [{ type: 'text', text: JSON.stringify({ sessionId: result.sessionId }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'end_session': {
      try {
        await endSession({
          sessionId: args?.sessionId as string,
          summary: args?.summary as string,
          tokensUsed: (args?.tokensUsed as number) || 0,
          toolCalls: (args?.toolCalls as number) || 0,
          linesAdded: (args?.linesAdded as number) || undefined,
          linesRemoved: (args?.linesRemoved as number) || undefined,
          costUsd: (args?.costUsd as number) || undefined,
          filesChanged: args?.filesChanged as string | undefined,
          durationMs: (args?.durationMs as number) || undefined,
          transcript: (args?.transcript as string) || undefined,
          inputTokens: (args?.inputTokens as number) || undefined,
          outputTokens: (args?.outputTokens as number) || undefined,
          cacheReadTokens: (args?.cacheReadTokens as number) || undefined,
          cacheCreationTokens: (args?.cacheCreationTokens as number) || undefined,
        });
        currentSessionId = null;
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'update_session': {
      try {
        const sessionId = (args?.sessionId as string) || currentSessionId;
        if (!sessionId) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'No active session — pass sessionId or call start_session first' }) }] };
        }
        await updateSession(sessionId, {
          prompt: (args?.prompt as string) || undefined,
          transcript: (args?.transcript as string) || undefined,
          filesChanged: Array.isArray(args?.filesChanged) ? (args?.filesChanged as string[]) : undefined,
          tokensUsed: (args?.tokensUsed as number) || undefined,
          inputTokens: (args?.inputTokens as number) || undefined,
          outputTokens: (args?.outputTokens as number) || undefined,
          cacheReadTokens: (args?.cacheReadTokens as number) || undefined,
          cacheCreationTokens: (args?.cacheCreationTokens as number) || undefined,
          toolCalls: (args?.toolCalls as number) || undefined,
          linesAdded: (args?.linesAdded as number) || undefined,
          linesRemoved: (args?.linesRemoved as number) || undefined,
          model: (args?.model as string) || undefined,
          durationMs: (args?.durationMs as number) || undefined,
          costUsd: (args?.costUsd as number) || undefined,
          branch: (args?.branch as string) || undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'log_tool_call': {
      try {
        await logToolCall({
          sessionId: args?.sessionId as string,
          tool: args?.tool as string,
          args: args?.args as string,
          result: args?.result as string,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ logged: true }) }] };
      } catch (err: any) {
        // Non-critical — log locally and report success to avoid disrupting the agent
        console.error(`[origin-mcp] Failed to log tool call: ${err.message}`);
        return { content: [{ type: 'text', text: JSON.stringify({ logged: true, warning: 'Failed to persist to server' }) }] };
      }
    }

    case 'list_sessions': {
      try {
        const params: Record<string, string> = {};
        if (args?.status) params.status = args.status as string;
        if (args?.model) params.model = args.model as string;
        if (args?.limit) params.limit = String(args.limit);
        else params.limit = '20';
        const result = await listSessions(params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'get_session': {
      try {
        const result = await getSession(args?.session_id as string);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'review_session': {
      try {
        const result = await reviewSession(args?.session_id as string, args?.status as string, args?.note as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'list_agents': {
      try {
        const result = await listAgents();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'list_repos': {
      try {
        const result = await listRepos();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'get_stats': {
      try {
        const result = await getStats();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'get_audit_log': {
      try {
        const params: Record<string, string> = {};
        if (args?.action) params.action = args.action as string;
        if (args?.limit) params.limit = String(args.limit);
        else params.limit = '30';
        const result = await listAuditLogs(params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'get_policy_versions': {
      try {
        const result = await getPolicyVersions(args?.policy_id as string);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'get_agent_versions': {
      try {
        const result = await getAgentVersions(args?.agent_id as string);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'list_notifications': {
      try {
        const params: Record<string, string> = {};
        if (args?.unread) params.unread = 'true';
        if (args?.limit) params.limit = String(args.limit);
        else params.limit = '20';
        const result = await listNotifications(params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'list_users': {
      try {
        const result = await listUsers();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// -- Main --

async function main() {
  const config = loadConfig();
  const agentConfig = loadAgentConfig();
  machineId = agentConfig?.machineId || 'unknown';

  if (config) {
    await loadPolicies();
    console.error(`[origin-mcp] Loaded ${policies.length} policies`);
  } else {
    console.error('[origin-mcp] No Origin config found. Run: origin login && origin enable');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[origin-mcp] Origin MCP server running');
}

main().catch((err) => {
  console.error('[origin-mcp] Fatal error:', err);
  process.exit(1);
});
