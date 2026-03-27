import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { notifyOrgAdmins } from './notifications.js';

// ---------------------------------------------------------------------------
// AI-Powered Auto-Review with Quality Scoring
// ---------------------------------------------------------------------------
// When a session ends, this service analyzes the transcript and session data
// using Claude to produce an automated quality score and risk assessment.
// ---------------------------------------------------------------------------

interface SessionData {
  sessionId: string;
  orgId: string;
  model: string;
  prompt: string;
  filesChanged: string[];
  tokensUsed: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  costUsd: number;
  durationMs: number;
  transcript?: string;
  diff?: string;                // Actual unified diff from git
  promptChanges?: Array<{       // Prompt → file change mappings
    promptText: string;
    filesChanged: string[];
  }>;
}

interface CategoryScores {
  security: number;   // 0-100: secrets, auth changes, vulnerability risks
  scope: number;      // 0-100: changes match the prompt, no unexpected edits
  quality: number;    // 0-100: code quality, patterns, error handling
  cost: number;       // 0-100: reasonable token/cost usage for the task
}

export interface AIReviewResult {
  status: 'APPROVED' | 'FLAGGED' | 'REJECTED';
  score: number;      // 0-100 overall quality score
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  concerns: string[];
  suggestions: string[];
  categories: CategoryScores;
}

const SYSTEM_PROMPT = `You are Origin, an AI coding governance assistant. Your job is to review AI coding sessions and produce a quality score.

You will be given data about an AI coding session including the user's prompt, files modified, metrics, transcript, and code diff.

Score the session 0-100 overall and in four categories:

1. **Security** (0-100): Are there hardcoded secrets, auth changes, backdoors, or sensitive file modifications? 100 = no security concerns.
2. **Scope** (0-100): Do the changes match what was requested? Were only expected files modified? 100 = perfectly scoped.
3. **Quality** (0-100): Is the code well-written? Any errors, retries, workarounds, or poor patterns? 100 = excellent quality.
4. **Cost** (0-100): Was token/cost usage reasonable for the task size? 100 = very efficient.

The overall score should be a weighted average: security (35%), scope (25%), quality (25%), cost (15%).

Respond with a JSON object (no markdown fences):
{
  "score": 85,
  "categories": { "security": 95, "scope": 80, "quality": 85, "cost": 90 },
  "riskLevel": "low",
  "summary": "Brief 1-2 sentence summary",
  "concerns": ["specific concerns, if any"],
  "suggestions": ["actionable suggestions"]
}

Risk level mapping:
- "low": score >= 80
- "medium": score 60-79
- "high": score 40-59
- "critical": score < 40

Be concise and fair. Most routine sessions should score 75-95. Only flag genuinely risky sessions.`;

function buildPrompt(data: SessionData): string {
  let prompt = `## Session Review Request

**Model:** ${data.model}
**Cost:** $${data.costUsd.toFixed(4)}
**Tokens Used:** ${data.tokensUsed.toLocaleString()}
**Tool Calls:** ${data.toolCalls}
**Duration:** ${Math.round(data.durationMs / 1000)}s
**Lines Added:** ${data.linesAdded}
**Lines Removed:** ${data.linesRemoved}

**User Prompt:**
${data.prompt || '(no prompt captured)'}

**Files Changed:**
${data.filesChanged.length > 0 ? data.filesChanged.map(f => `- ${f}`).join('\n') : '(none detected)'}`;

  // Include prompt → change mapping for governance context
  if (data.promptChanges && data.promptChanges.length > 0) {
    prompt += '\n\n**Prompt → Changes Mapping:**';
    for (const pc of data.promptChanges) {
      prompt += `\n- Prompt: "${pc.promptText.slice(0, 200)}"\n  Files: ${pc.filesChanged.join(', ') || '(none)'}`;
    }
  }

  // Include actual code diff (truncated to fit context window)
  if (data.diff) {
    const maxDiffLen = 8000;
    const truncatedDiff = data.diff.length > maxDiffLen
      ? data.diff.slice(0, maxDiffLen) + '\n... (diff truncated)'
      : data.diff;
    prompt += `\n\n**Code Diff:**\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
  }

  // Include a truncated transcript for context (limit to ~4000 chars)
  if (data.transcript) {
    const maxLen = 4000;
    const truncated = data.transcript.length > maxLen
      ? data.transcript.slice(0, maxLen) + '\n... (truncated)'
      : data.transcript;
    prompt += `\n\n**Transcript Snippet:**\n\`\`\`\n${truncated}\n\`\`\``;
  }

  return prompt;
}

function scoreToStatus(score: number): 'APPROVED' | 'FLAGGED' | 'REJECTED' {
  if (score >= 80) return 'APPROVED';
  if (score >= 50) return 'FLAGGED';
  return 'REJECTED';
}

function scoreToRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 80) return 'low';
  if (score >= 60) return 'medium';
  if (score >= 40) return 'high';
  return 'critical';
}

function parseReviewResponse(text: string): AIReviewResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 75;
      const categories: CategoryScores = {
        security: typeof parsed.categories?.security === 'number' ? Math.round(parsed.categories.security) : score,
        scope: typeof parsed.categories?.scope === 'number' ? Math.round(parsed.categories.scope) : score,
        quality: typeof parsed.categories?.quality === 'number' ? Math.round(parsed.categories.quality) : score,
        cost: typeof parsed.categories?.cost === 'number' ? Math.round(parsed.categories.cost) : score,
      };
      return {
        score,
        categories,
        status: scoreToStatus(score),
        riskLevel: scoreToRiskLevel(score),
        summary: parsed.summary || 'AI review completed',
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    }
  } catch {
    // Fall through to default
  }

  return {
    score: 50,
    categories: { security: 50, scope: 50, quality: 50, cost: 50 },
    status: 'FLAGGED',
    riskLevel: 'medium',
    summary: 'AI review could not be parsed — flagged for manual review',
    concerns: ['Automated review response could not be parsed'],
    suggestions: ['Please review this session manually'],
  };
}

export async function runAIReview(data: SessionData): Promise<AIReviewResult | null> {
  // Try org-level LLM key first, then fall back to env var
  let apiKey: string | null = null;
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: data.orgId, provider: 'llm' },
    });
    apiKey = config?.token || null;
  } catch { /* ignore */ }
  if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY || null;
  if (!apiKey) {
    console.log('[ai-review] Skipping — no LLM key configured (set in Settings > Integrations or ANTHROPIC_API_KEY env)');
    return null;
  }

  const org = await prisma.org.findUnique({ where: { id: data.orgId } });
  if (!org) return null;

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildPrompt(data) },
      ],
    });

    const responseText = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    const result = parseReviewResponse(responseText);

    // Store structured review in database
    const adminUser = await prisma.user.findFirst({
      where: { orgId: data.orgId, role: 'ADMIN' },
    });

    if (adminUser) {
      const existing = await prisma.sessionReview.findUnique({
        where: { sessionId: data.sessionId },
      });

      if (!existing) {
        // Build human-readable note (kept for backward compat)
        const reviewNote = [
          `**AI Auto-Review** — Score: ${result.score}/100 (${result.riskLevel} risk)`,
          '',
          result.summary,
          '',
          ...(result.concerns.length > 0 ? ['**Concerns:**', ...result.concerns.map(c => `- ${c}`), ''] : []),
          ...(result.suggestions.length > 0 ? ['**Suggestions:**', ...result.suggestions.map(s => `- ${s}`)] : []),
        ].join('\n');

        await prisma.sessionReview.create({
          data: {
            sessionId: data.sessionId,
            userId: adminUser.id,
            status: result.status,
            note: reviewNote,
            score: result.score,
            riskLevel: result.riskLevel,
            concerns: JSON.stringify(result.concerns),
            suggestions: JSON.stringify(result.suggestions),
            categories: JSON.stringify(result.categories),
            isAutoReview: true,
          },
        });

        await prisma.auditLog.create({
          data: {
            orgId: data.orgId,
            action: 'AI_AUTO_REVIEW',
            resource: data.sessionId,
            metadata: JSON.stringify({
              sessionId: data.sessionId,
              score: result.score,
              status: result.status,
              riskLevel: result.riskLevel,
              categories: result.categories,
            }),
          },
        });

        if (result.status === 'FLAGGED' || result.status === 'REJECTED') {
          await notifyOrgAdmins(
            data.orgId,
            result.status === 'FLAGGED' ? 'SESSION_FLAGGED' : 'REVIEW_COMPLETED',
            `AI Review: Score ${result.score}/100 — ${result.status.toLowerCase()}`,
            result.summary,
            `/sessions/${data.sessionId}`,
            { sessionId: data.sessionId, score: result.score, status: result.status, riskLevel: result.riskLevel }
          );
        }

        console.log(`[ai-review] Session ${data.sessionId}: ${result.score}/100 ${result.status} (${result.riskLevel})`);
      }
    }

    return result;
  } catch (err) {
    console.error('[ai-review] Error:', (err as Error).message);
    return null;
  }
}
