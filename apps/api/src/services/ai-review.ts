import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { notifyOrgAdmins } from './notifications.js';

// ---------------------------------------------------------------------------
// AI-Powered Auto-Review
// ---------------------------------------------------------------------------
// When a session ends, this service analyzes the transcript and session data
// using Claude to produce an automated risk assessment and review.
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

interface AIReviewResult {
  status: 'APPROVED' | 'FLAGGED' | 'REJECTED';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  concerns: string[];
  suggestions: string[];
}

const SYSTEM_PROMPT = `You are Origin, an AI coding governance assistant. Your job is to review AI coding sessions and assess their risk level.

You will be given data about an AI coding session including:
- The user's prompt/request
- Files that were modified
- Token usage, cost, and duration metrics
- A transcript snippet of the session

Your task is to analyze this session and provide a risk assessment. Consider:

1. **Security risks**: Does the session modify auth, security, or sensitive files? Are credentials/secrets potentially exposed? Check the actual code diff for hardcoded secrets, backdoors, or suspicious code.
2. **Scope risks**: Did the AI modify many files relative to the request? Were unexpected files changed? Does the diff contain changes beyond what was requested?
3. **Cost risks**: Was the token/cost usage abnormally high for the task?
4. **Code quality risks**: Based on the transcript and actual code diff, were there signs of issues (errors, retries, workarounds, poor patterns)?
5. **Policy compliance**: Does the work appear to follow standard development practices?
6. **Prompt-change alignment**: Do the code changes match what was requested in each prompt? Were any unexpected changes made beyond the prompt scope?

Respond with a JSON object (no markdown fences) with these fields:
{
  "status": "APPROVED" | "FLAGGED" | "REJECTED",
  "riskLevel": "low" | "medium" | "high" | "critical",
  "summary": "Brief 1-2 sentence summary of the review",
  "concerns": ["list of specific concerns, if any"],
  "suggestions": ["list of actionable suggestions"]
}

Guidelines for status:
- APPROVED: Low risk, routine changes, appears safe
- FLAGGED: Medium risk, needs human review (e.g., security-related files, high cost, many file changes)
- REJECTED: High risk, potentially dangerous changes (e.g., modifying auth/secrets, deleting production data)

Be concise. Focus on actionable insights. When in doubt, flag for human review rather than auto-approving.`;

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

function parseReviewResponse(text: string): AIReviewResult {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        status: ['APPROVED', 'FLAGGED', 'REJECTED'].includes(parsed.status) ? parsed.status : 'FLAGGED',
        riskLevel: ['low', 'medium', 'high', 'critical'].includes(parsed.riskLevel) ? parsed.riskLevel : 'medium',
        summary: parsed.summary || 'AI review completed',
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    }
  } catch {
    // Fall through to default
  }

  // Default if parsing fails
  return {
    status: 'FLAGGED',
    riskLevel: 'medium',
    summary: 'AI review could not be parsed — flagged for manual review',
    concerns: ['Automated review response could not be parsed'],
    suggestions: ['Please review this session manually'],
  };
}

export async function runAIReview(data: SessionData): Promise<AIReviewResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[ai-review] Skipping — no ANTHROPIC_API_KEY set');
    return null;
  }

  // Check if auto-review is enabled for this org
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

    // Create the review in the database
    // Use a special "system" user or the first admin
    const adminUser = await prisma.user.findFirst({
      where: { orgId: data.orgId, role: 'ADMIN' },
    });

    if (adminUser) {
      // Check if review already exists
      const existing = await prisma.sessionReview.findUnique({
        where: { sessionId: data.sessionId },
      });

      if (!existing) {
        const reviewNote = [
          `**AI Auto-Review** (${result.riskLevel} risk)`,
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
          },
        });

        // Log audit event
        await prisma.auditLog.create({
          data: {
            orgId: data.orgId,
            action: 'AI_AUTO_REVIEW',
            resource: data.sessionId,
            metadata: JSON.stringify({
              sessionId: data.sessionId,
              status: result.status,
              riskLevel: result.riskLevel,
            }),
          },
        });

        // Notify admins if flagged or rejected
        if (result.status === 'FLAGGED' || result.status === 'REJECTED') {
          await notifyOrgAdmins(
            data.orgId,
            result.status === 'FLAGGED' ? 'SESSION_FLAGGED' : 'REVIEW_COMPLETED',
            `AI Review: Session ${result.status.toLowerCase()}`,
            result.summary,
            `/sessions/${data.sessionId}`,
            { sessionId: data.sessionId, status: result.status, riskLevel: result.riskLevel }
          );
        }

        console.log(`[ai-review] Session ${data.sessionId}: ${result.status} (${result.riskLevel} risk)`);
      }
    }

    return result;
  } catch (err) {
    console.error('[ai-review] Error:', (err as Error).message);
    return null;
  }
}
