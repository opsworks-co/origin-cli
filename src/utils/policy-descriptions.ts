// ⚠️  GENERATED FILE — DO NOT EDIT.
//
// Copied from apps/api/src/utils/policy-descriptions.ts by scripts/sync-shared-modules.mjs (pair "policy-descriptions").
// Edit the canonical file there, then run `pnpm sync:shared-modules`.
// shared-modules-drift.test.ts fails if this copy is stale.

// CANONICAL COPY. packages/cli/src/utils/policy-descriptions.ts is generated from
// this file by scripts/sync-shared-modules.mjs — edit here, then
// `pnpm sync:shared-modules`. The policy types are defined and enforced on
// this side; the CLI's `origin policies` shows the same words.
//
export interface ConditionDescription {
  summary: string;
  fixHint: string;
}

export function describeCondition(type: string, conditionJson: string): ConditionDescription {
  let cond: Record<string, any> = {};
  try { cond = JSON.parse(conditionJson); } catch { /* */ }

  switch (type) {
    case 'MODEL_ALLOWLIST': {
      const models = (cond.models as string[]) || [];
      const list = models.map(m => m.replace('claude-', '').replace('-20250514', '')).join(', ');
      return {
        summary: models.length ? `Only allow models: ${list}` : 'Model allowlist (no models specified)',
        fixHint: models.length ? `Use an approved model: ${list}` : 'Contact your admin for approved models',
      };
    }
    case 'COST_LIMIT': {
      if (cond.max_cost != null) return {
        summary: `Max session cost: $${Number(cond.max_cost).toFixed(2)}`,
        fixHint: `Keep session cost under $${Number(cond.max_cost).toFixed(2)}`,
      };
      if (cond.max_tokens != null) return {
        summary: `Max tokens per session: ${Number(cond.max_tokens).toLocaleString()}`,
        fixHint: `Keep token usage under ${Number(cond.max_tokens).toLocaleString()}`,
      };
      return { summary: 'Cost limit policy', fixHint: 'Reduce session cost or token usage' };
    }
    case 'FILE_RESTRICTION': {
      const p = cond.path || '(unknown pattern)';
      return {
        summary: `Restricted files: ${p}`,
        fixHint: `Do not modify files matching "${p}"`,
      };
    }
    case 'REQUIRE_REVIEW': {
      if (cond.cost_above != null) return {
        summary: `Review required if cost > $${Number(cond.cost_above).toFixed(2)}`,
        fixHint: `Keep cost under $${Number(cond.cost_above).toFixed(2)} to skip review`,
      };
      if (cond.files_above != null) return {
        summary: `Review required if > ${cond.files_above} files changed`,
        fixHint: `Change fewer than ${cond.files_above} files to skip review`,
      };
      if (cond.max_lines != null) return {
        summary: `Review required if > ${cond.max_lines} lines added`,
        fixHint: `Keep additions under ${cond.max_lines} lines to skip review`,
      };
      if (cond.max_duration_minutes != null) return {
        summary: `Review required if session > ${cond.max_duration_minutes} minutes`,
        fixHint: `Keep sessions under ${cond.max_duration_minutes} minutes`,
      };
      if (cond.tokens_above != null) return {
        summary: `Review required if > ${Number(cond.tokens_above).toLocaleString()} tokens`,
        fixHint: `Keep token usage under ${Number(cond.tokens_above).toLocaleString()}`,
      };
      if (cond.path) return {
        summary: `Review required for files matching "${cond.path}"`,
        fixHint: `Changes to "${cond.path}" will require human review`,
      };
      return { summary: 'Review required', fixHint: 'This session will require human review' };
    }
    case 'CONTENT_FILTER': {
      const p = cond.pattern || '(unknown pattern)';
      return {
        summary: `Block diff content matching: ${p}`,
        fixHint: `Do not include content matching "${p}" in your changes`,
      };
    }
    case 'COMMIT_MESSAGE': {
      if (cond.pattern) return {
        summary: `Require commit format: ${cond.pattern}`,
        fixHint: `Use commit messages matching format "${cond.pattern}"`,
      };
      if (cond.blocked_pattern) return {
        summary: `Block commits matching: ${cond.blocked_pattern}`,
        fixHint: `Do not use "${cond.blocked_pattern}" in commit messages`,
      };
      return { summary: 'Commit message policy', fixHint: 'Check commit message format' };
    }
    case 'SESSION_LIMITS': {
      const parts: string[] = [];
      if (cond.idle_notify_minutes != null) parts.push(`notify after ${cond.idle_notify_minutes}m idle`);
      if (cond.max_idle_minutes != null) parts.push(`auto-end after ${cond.max_idle_minutes}m idle`);
      if (cond.max_duration_minutes != null) parts.push(`block new prompts after ${cond.max_duration_minutes}m`);
      return {
        summary: parts.length ? `Session limits: ${parts.join(', ')}` : 'Session limits policy',
        fixHint: 'Close idle sessions and start a fresh session for each new task',
      };
    }
    default:
      return { summary: conditionJson, fixHint: 'Check with your admin' };
  }
}

export function describeAction(action: string): string {
  switch (action.toUpperCase()) {
    case 'BLOCK': return 'Blocks session';
    case 'WARN': return 'Warning only';
    case 'REQUIRE_REVIEW': return 'Flags for review';
    case 'NOTIFY': return 'Notifies admins';
    default: return action;
  }
}

export function policyTypeLabel(type: string): string {
  switch (type) {
    case 'MODEL_ALLOWLIST': return 'Model Allowlist';
    case 'COST_LIMIT': return 'Cost Limit';
    case 'FILE_RESTRICTION': return 'File Restriction';
    case 'REQUIRE_REVIEW': return 'Require Review';
    case 'CONTENT_FILTER': return 'Content Filter';
    case 'COMMIT_MESSAGE': return 'Commit Message';
    case 'SESSION_LIMITS': return 'Session Limits';
    default: return type;
  }
}
