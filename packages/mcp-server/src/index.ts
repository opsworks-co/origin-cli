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
import { fetchPolicies, startSession, endSession, reportViolation } from './api.js';

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
      description: 'End the current coding session',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: { type: 'string', description: 'Session ID to end' },
          summary: { type: 'string', description: 'Summary of what was done' },
        },
        required: ['sessionId', 'summary'],
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
          tokensUsed: 0,
          toolCalls: 0,
        });
        currentSessionId = null;
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }

    case 'log_tool_call': {
      console.error(`[origin-mcp] Tool call logged: ${args?.tool} in session ${args?.sessionId}`);
      return { content: [{ type: 'text', text: JSON.stringify({ logged: true }) }] };
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
    console.error('[origin-mcp] No Origin config found. Run: origin login && origin init');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[origin-mcp] Origin MCP server running');
}

main().catch((err) => {
  console.error('[origin-mcp] Fatal error:', err);
  process.exit(1);
});
