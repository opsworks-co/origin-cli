/**
 * Policy Engine — server-side enforcement of governance policies.
 *
 * Supported policy types:
 *   FILE_RESTRICTION  — Block or flag file access patterns
 *   REQUIRE_REVIEW    — Auto-flag sessions for review based on conditions
 *   MODEL_ALLOWLIST   — Restrict which AI models can be used
 *   COST_LIMIT        — Per-session cost thresholds
 *
 * Condition format (JSON):
 *   { "path": "**\/.env" }                      — glob match on file path
 *   { "models": ["claude-sonnet-4-20250514"] }   — allowed model list
 *   { "max_cost": 5.0 }                         — max cost per session
 *   { "max_tokens": 100000 }                    — max tokens per session
 *   { "max_files": 20 }                         — max files changed
 *   { "max_lines": 500 }                        — max lines added
 *   { "max_duration_minutes": 30 }              — max session duration
 */

import { prisma } from '../db.js';
import { notifyOrgAdmins } from './notifications.js';

// ── Types ─────────────────────────────────────────────────────────

export interface PolicyData {
  id: string;
  name: string;
  type: string;
  description: string | null;
  rules: Array<{
    id: string;
    condition: string;
    action: string;
    severity: string;
    agentId: string | null;
    machineId: string | null;
    repoId: string | null;
  }>;
}

export interface SessionContext {
  sessionId: string;
  orgId: string;
  model: string;
  costUsd: number;
  tokensUsed: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  durationMs: number;
  filesChanged: string[];
  agentId?: string | null;
  machineId?: string | null;
  repoId?: string | null;
}

export interface RuleScope {
  agentId?: string | null;
  machineId?: string | null;
  repoId?: string | null;
}

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  policyType: string;
  ruleId: string;
  condition: string;
  action: string;
  severity: string;
  message: string;
}

export interface EnforcementResult {
  allowed: boolean;
  violations: PolicyViolation[];
  requiresReview: boolean;
  reviewReason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────

function parseCondition(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    return {};
  } catch {
    return {};
  }
}

/** Check if a rule should be skipped based on scope (agent, machine, repo). */
function shouldSkipRule(
  rule: { agentId: string | null; machineId: string | null; repoId: string | null },
  scope: RuleScope,
): boolean {
  if (rule.agentId && rule.agentId !== scope.agentId) return true;
  if (rule.machineId && rule.machineId !== scope.machineId) return true;
  if (rule.repoId && rule.repoId !== scope.repoId) return true;
  return false;
}

function matchGlob(pattern: string, filepath: string): boolean {
  // Convert glob to regex: ** → .*, * → [^/]*, ? → .
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(filepath);
}

// ── Load Policies ─────────────────────────────────────────────────

export async function loadOrgPolicies(orgId: string): Promise<PolicyData[]> {
  const policies = await prisma.policy.findMany({
    where: { orgId, active: true },
    include: { rules: true },
  });

  return policies.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    description: p.description,
    rules: p.rules.map((r) => ({
      id: r.id,
      condition: r.condition,
      action: r.action,
      severity: r.severity,
      agentId: r.agentId,
      machineId: r.machineId,
      repoId: r.repoId,
    })),
  }));
}

// ── Enforce: Session Start ────────────────────────────────────────
// Check MODEL_ALLOWLIST before allowing a session to start.

export async function enforceSessionStart(
  orgId: string,
  model: string,
  scope: RuleScope = {},
): Promise<EnforcementResult> {
  // Skip model enforcement when model is unknown — can't enforce what we don't know yet.
  // Model will be validated at session-end when transcript data provides the actual model.
  if (!model || model === 'unknown') {
    return { allowed: true, violations: [], requiresReview: false };
  }

  const policies = await loadOrgPolicies(orgId);
  const violations: PolicyViolation[] = [];

  for (const policy of policies) {
    if (policy.type !== 'MODEL_ALLOWLIST') continue;

    for (const rule of policy.rules) {
      // Skip scoped rules that don't match
      if (shouldSkipRule(rule, scope)) continue;

      const cond = parseCondition(rule.condition);
      const allowedModels = cond.models as string[] | undefined;

      if (allowedModels && Array.isArray(allowedModels) && allowedModels.length > 0) {
        const modelAllowed = allowedModels.some(
          (m) => model.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(model.toLowerCase()),
        );

        if (!modelAllowed) {
          violations.push({
            policyId: policy.id,
            policyName: policy.name,
            policyType: policy.type,
            ruleId: rule.id,
            condition: rule.condition,
            action: rule.action,
            severity: rule.severity,
            message: `Model "${model}" is not in the allowed list: ${allowedModels.join(', ')}`,
          });
        }
      }
    }
  }

  const blocked = violations.some(
    (v) => v.action.toUpperCase() === 'BLOCK',
  );

  return {
    allowed: !blocked,
    violations,
    requiresReview: false,
  };
}

// ── Enforce: Session End ──────────────────────────────────────────
// Check REQUIRE_REVIEW, COST_LIMIT, and FILE_RESTRICTION at session end.

export async function enforceSessionEnd(ctx: SessionContext): Promise<EnforcementResult> {
  const policies = await loadOrgPolicies(ctx.orgId);
  const violations: PolicyViolation[] = [];
  let requiresReview = false;
  const reviewReasons: string[] = [];

  for (const policy of policies) {
    for (const rule of policy.rules) {
      // Skip scoped rules that don't match
      if (shouldSkipRule(rule, ctx)) continue;

      const cond = parseCondition(rule.condition);
      let matched = false;
      let message = '';

      switch (policy.type) {
        case 'COST_LIMIT': {
          const maxCost = cond.max_cost as number | undefined;
          if (maxCost && ctx.costUsd > maxCost) {
            matched = true;
            message = `Session cost $${ctx.costUsd.toFixed(2)} exceeds limit $${maxCost.toFixed(2)}`;
          }
          const maxTokens = cond.max_tokens as number | undefined;
          if (maxTokens && ctx.tokensUsed > maxTokens) {
            matched = true;
            message = `Tokens used ${ctx.tokensUsed.toLocaleString()} exceeds limit ${maxTokens.toLocaleString()}`;
          }
          break;
        }

        case 'REQUIRE_REVIEW': {
          // Check cost threshold
          const costAbove = cond.cost_above as number | undefined;
          if (costAbove !== undefined && ctx.costUsd > costAbove) {
            matched = true;
            message = `Session cost $${ctx.costUsd.toFixed(2)} exceeds review threshold $${costAbove.toFixed(2)}`;
          }
          // Check tokens threshold
          const tokensAbove = cond.tokens_above as number | undefined;
          if (tokensAbove !== undefined && ctx.tokensUsed > tokensAbove) {
            matched = true;
            message = `Tokens ${ctx.tokensUsed.toLocaleString()} exceeds review threshold ${tokensAbove.toLocaleString()}`;
          }
          // Check files threshold
          const filesAbove = cond.files_above as number | undefined;
          if (filesAbove !== undefined && ctx.filesChanged.length > filesAbove) {
            matched = true;
            message = `Files changed (${ctx.filesChanged.length}) exceeds review threshold (${filesAbove})`;
          }
          // Check lines threshold
          const linesAbove = cond.max_lines as number | undefined;
          if (linesAbove !== undefined && ctx.linesAdded > linesAbove) {
            matched = true;
            message = `Lines added (${ctx.linesAdded}) exceeds review threshold (${linesAbove})`;
          }
          // Check duration threshold
          const durationAbove = cond.max_duration_minutes as number | undefined;
          if (durationAbove !== undefined && ctx.durationMs > durationAbove * 60000) {
            matched = true;
            message = `Duration (${Math.round(ctx.durationMs / 60000)}m) exceeds review threshold (${durationAbove}m)`;
          }
          // Check file path patterns
          const pathPattern = cond.path as string | undefined;
          if (pathPattern) {
            for (const file of ctx.filesChanged) {
              if (matchGlob(pathPattern, file)) {
                matched = true;
                message = `File "${file}" matches review pattern "${pathPattern}"`;
                break;
              }
            }
          }
          break;
        }

        case 'FILE_RESTRICTION': {
          const pathPattern = cond.path as string | undefined;
          if (pathPattern) {
            for (const file of ctx.filesChanged) {
              if (matchGlob(pathPattern, file)) {
                matched = true;
                message = `File "${file}" matches restricted pattern "${pathPattern}"`;
                break;
              }
            }
          }
          break;
        }
      }

      if (matched) {
        violations.push({
          policyId: policy.id,
          policyName: policy.name,
          policyType: policy.type,
          ruleId: rule.id,
          condition: rule.condition,
          action: rule.action,
          severity: rule.severity,
          message,
        });

        // Determine actions
        const action = rule.action.toUpperCase();
        if (action === 'REQUIRE_REVIEW' || policy.type === 'REQUIRE_REVIEW') {
          requiresReview = true;
          reviewReasons.push(`${policy.name}: ${message}`);
        }
        if (action === 'WARN' || action === 'NOTIFY') {
          reviewReasons.push(`${policy.name}: ${message}`);
        }
      }
    }
  }

  return {
    allowed: true, // Session already completed; we just flag/review
    violations,
    requiresReview,
    reviewReason: reviewReasons.length > 0 ? reviewReasons.join('\n') : undefined,
  };
}

// ── Post-Session Enforcement Actions ──────────────────────────────
// Actually create violations, reviews, notifications based on enforcement result.

export async function applyEnforcementActions(
  ctx: SessionContext,
  result: EnforcementResult,
): Promise<void> {
  if (result.violations.length === 0) return;

  // Log each violation to audit log
  for (const v of result.violations) {
    await prisma.auditLog.create({
      data: {
        orgId: ctx.orgId,
        action: 'POLICY_VIOLATION',
        resource: v.policyId,
        metadata: JSON.stringify({
          sessionId: ctx.sessionId,
          policyId: v.policyId,
          policyName: v.policyName,
          policyType: v.policyType,
          ruleId: v.ruleId,
          severity: v.severity,
          message: v.message,
        }),
      },
    });
  }

  // Auto-flag for review if needed
  if (result.requiresReview) {
    // Check if session already has a review
    const existingReview = await prisma.sessionReview.findUnique({
      where: { sessionId: ctx.sessionId },
    });

    if (!existingReview) {
      // Find the first admin/owner user to attribute the auto-review to
      const adminUser = await prisma.user.findFirst({
        where: { orgId: ctx.orgId, role: { in: ['ADMIN', 'OWNER'] } },
      });

      if (adminUser) {
        const reviewNote = [
          '**Policy Auto-Flag**\n',
          'This session was automatically flagged based on policy rules:\n',
          ...result.violations.map(
            (v) => `- **${v.policyName}** (${v.policyType}): ${v.message}`,
          ),
        ].join('\n');

        await prisma.sessionReview.create({
          data: {
            sessionId: ctx.sessionId,
            userId: adminUser.id,
            status: 'FLAGGED',
            note: reviewNote,
          },
        });
      }
    }
  }

  // Notify admins about violations
  const highSeverity = result.violations.filter(
    (v) => v.severity.toUpperCase() === 'HIGH',
  );

  if (highSeverity.length > 0 || result.requiresReview) {
    const summary = result.violations
      .map((v) => `${v.policyName}: ${v.message}`)
      .join('; ');

    await notifyOrgAdmins(
      ctx.orgId,
      'POLICY_VIOLATION',
      `Policy Violation: ${result.violations.length} rule${result.violations.length !== 1 ? 's' : ''} triggered`,
      summary.slice(0, 200),
      `/sessions/${ctx.sessionId}`,
      {
        sessionId: ctx.sessionId,
        violations: result.violations.length,
        requiresReview: result.requiresReview,
      },
    );
  }
}

// ── Agent-Level Enforcement ─────────────────────────────────────
// Enforce the agent's own config limits (maxCostPerSession, maxTokensPerSession,
// permissions.blockedPaths) as hard caps, separate from the policy system.

export interface AgentEnforcementResult {
  violations: Array<{
    field: string;
    message: string;
    severity: 'HIGH';
  }>;
  requiresReview: boolean;
}

export async function enforceAgentLimits(ctx: SessionContext): Promise<AgentEnforcementResult> {
  const result: AgentEnforcementResult = { violations: [], requiresReview: false };

  if (!ctx.agentId) return result;

  const agent = await prisma.agent.findUnique({
    where: { id: ctx.agentId },
    select: {
      name: true,
      maxCostPerSession: true,
      maxTokensPerSession: true,
      permissions: true,
    },
  });

  if (!agent) return result;

  // Check per-session cost limit
  if (agent.maxCostPerSession && agent.maxCostPerSession > 0 && ctx.costUsd > agent.maxCostPerSession) {
    result.violations.push({
      field: 'maxCostPerSession',
      message: `Agent "${agent.name}" cost $${ctx.costUsd.toFixed(2)} exceeds per-session limit $${agent.maxCostPerSession.toFixed(2)}`,
      severity: 'HIGH',
    });
    result.requiresReview = true;
  }

  // Check per-session token limit
  if (agent.maxTokensPerSession && agent.maxTokensPerSession > 0 && ctx.tokensUsed > agent.maxTokensPerSession) {
    result.violations.push({
      field: 'maxTokensPerSession',
      message: `Agent "${agent.name}" used ${ctx.tokensUsed.toLocaleString()} tokens, exceeds per-session limit ${agent.maxTokensPerSession.toLocaleString()}`,
      severity: 'HIGH',
    });
    result.requiresReview = true;
  }

  // Check blocked file paths from agent permissions
  let permissions: { blockedPaths?: string[]; filePatterns?: string[] } = {};
  try {
    permissions = JSON.parse(agent.permissions || '{}');
  } catch { /* ignore */ }

  if (permissions.blockedPaths && Array.isArray(permissions.blockedPaths) && permissions.blockedPaths.length > 0) {
    for (const file of ctx.filesChanged) {
      for (const pattern of permissions.blockedPaths) {
        if (matchGlob(pattern, file)) {
          result.violations.push({
            field: 'permissions.blockedPaths',
            message: `Agent "${agent.name}" modified blocked file "${file}" (pattern: ${pattern})`,
            severity: 'HIGH',
          });
          result.requiresReview = true;
          break; // one match per file is enough
        }
      }
    }
  }

  // Check allowed file patterns (if set, files outside these patterns are violations)
  if (permissions.filePatterns && Array.isArray(permissions.filePatterns) && permissions.filePatterns.length > 0) {
    for (const file of ctx.filesChanged) {
      const allowed = permissions.filePatterns.some((pattern) => matchGlob(pattern, file));
      if (!allowed) {
        result.violations.push({
          field: 'permissions.filePatterns',
          message: `Agent "${agent.name}" modified file "${file}" outside allowed patterns: ${permissions.filePatterns.join(', ')}`,
          severity: 'HIGH',
        });
        result.requiresReview = true;
      }
    }
  }

  // Log violations and auto-flag
  if (result.violations.length > 0) {
    for (const v of result.violations) {
      await prisma.auditLog.create({
        data: {
          orgId: ctx.orgId,
          action: 'AGENT_LIMIT_EXCEEDED',
          resource: ctx.agentId,
          metadata: JSON.stringify({
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            agentName: agent.name,
            field: v.field,
            message: v.message,
          }),
        },
      });
    }

    // Auto-flag session for review
    const existingReview = await prisma.sessionReview.findUnique({
      where: { sessionId: ctx.sessionId },
    });

    if (!existingReview) {
      const adminUser = await prisma.user.findFirst({
        where: { orgId: ctx.orgId, role: { in: ['ADMIN', 'OWNER'] } },
      });

      if (adminUser) {
        await prisma.sessionReview.create({
          data: {
            sessionId: ctx.sessionId,
            userId: adminUser.id,
            status: 'FLAGGED',
            note: [
              '**Agent Limit Exceeded**\n',
              ...result.violations.map((v) => `- ${v.message}`),
            ].join('\n'),
          },
        });
      }
    }

    // Notify admins
    await notifyOrgAdmins(
      ctx.orgId,
      'AGENT_LIMIT_EXCEEDED',
      `Agent Limit Exceeded: ${agent.name}`,
      result.violations.map((v) => v.message).join('; ').slice(0, 200),
      `/sessions/${ctx.sessionId}`,
      { sessionId: ctx.sessionId, agentId: ctx.agentId, violations: result.violations.length },
    );
  }

  return result;
}
