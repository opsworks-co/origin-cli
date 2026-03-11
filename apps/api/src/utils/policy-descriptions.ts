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
    default: return type;
  }
}
