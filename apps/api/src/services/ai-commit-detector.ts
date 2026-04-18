// ── AI Commit Detection ──────────────────────────────────────────────────────
// Heuristic detection of AI-authored commits via git metadata analysis.
// Checks Co-Authored-By trailers, author patterns, and commit message signatures.

export interface AIDetectionResult {
  aiToolDetected: string | null;
  aiDetectionMethod: string | null;
}

// ── Known AI Tool Signatures ─────────────────────────────────────────────────

interface ToolSignature {
  tool: string;
  // Co-Authored-By patterns (matched against name + email)
  coAuthorPatterns?: RegExp[];
  // Author name/email patterns
  authorPatterns?: RegExp[];
  // Commit message patterns
  messagePatterns?: RegExp[];
}

const AI_SIGNATURES: ToolSignature[] = [
  {
    tool: 'claude-code',
    coAuthorPatterns: [
      /claude.*<.*@anthropic\.com>/i,
      /claude\s*(opus|sonnet|haiku|code)?/i,
      /noreply@anthropic\.com/i,
    ],
    authorPatterns: [
      /^claude[\s-]?code$/i,
      /^claude$/i,
      /^mcp-agent$/i,
      /^ai-agent$/i,
    ],
    messagePatterns: [
      /generated\s+with\s+claude\s+code/i,
      /co-authored-by:\s*claude/i,
      /^made-with:\s*claude/im,
      /^assistant:\s*claude/im,
    ],
  },
  {
    tool: 'copilot',
    coAuthorPatterns: [
      /copilot/i,
      /github\s+copilot/i,
      /\+copilot@users\.noreply\.github\.com/i,
    ],
    authorPatterns: [
      /^(github\s+)?copilot$/i,
    ],
    messagePatterns: [
      /generated\s+by\s+copilot/i,
      /copilot\s+suggestion/i,
      /^made-with:\s*copilot/im,
      /^assistant:\s*copilot/im,
    ],
  },
  {
    tool: 'cursor',
    coAuthorPatterns: [
      /cursor/i,
      /cursor\s*(ai)?/i,
    ],
    authorPatterns: [
      /^cursor$/i,
      /^cursor\s*ai$/i,
    ],
    messagePatterns: [
      /generated\s+by\s+cursor/i,
      /^made-with:\s*cursor/im,
      /^assistant:\s*cursor/im,
    ],
  },
  {
    tool: 'aider',
    coAuthorPatterns: [
      /aider/i,
    ],
    authorPatterns: [
      /^aider$/i,
    ],
    messagePatterns: [
      /^\[?aider[\]:\s]/i,
      /aider\/\d/i,
      /^made-with:\s*aider/im,
    ],
  },
  {
    tool: 'gemini',
    coAuthorPatterns: [
      /gemini/i,
      /google\s*(ai|gemini)/i,
    ],
    authorPatterns: [
      /^gemini[\s-]?cli$/i,
      /^gemini$/i,
    ],
    messagePatterns: [
      /generated\s+by\s+gemini/i,
      /generated\s+with\s+gemini/i,
      /^made-with:\s*gemini/im,
    ],
  },
  {
    tool: 'codex',
    coAuthorPatterns: [
      /codex/i,
      /openai\s*codex/i,
      /noreply@openai\.com/i,
    ],
    authorPatterns: [
      /^codex$/i,
      /^openai[\s-]?codex$/i,
    ],
    messagePatterns: [
      /generated\s+(by|with)\s+codex/i,
      /openai\s+codex/i,
      /^made-with:\s*codex/im,
    ],
  },
  {
    tool: 'codeium',
    coAuthorPatterns: [
      /codeium/i,
      /windsurf/i,
    ],
    authorPatterns: [
      /^codeium$/i,
      /^windsurf$/i,
    ],
    messagePatterns: [
      /generated\s+by\s+codeium/i,
      /generated\s+by\s+windsurf/i,
      /^made-with:\s*(codeium|windsurf)/im,
    ],
  },
];

// ── Co-Authored-By Parser ────────────────────────────────────────────────────

const CO_AUTHOR_RE = /^co-authored-by:\s*(.+?)(?:\s*<([^>]+)>)?$/gim;

function parseCoAuthors(message: string): Array<{ name: string; email: string }> {
  const authors: Array<{ name: string; email: string }> = [];
  let match;
  while ((match = CO_AUTHOR_RE.exec(message)) !== null) {
    authors.push({
      name: match[1].trim(),
      email: (match[2] || '').trim().toLowerCase(),
    });
  }
  // Reset lastIndex for the global regex
  CO_AUTHOR_RE.lastIndex = 0;
  return authors;
}

// ── Main Detection Function ──────────────────────────────────────────────────

export function detectAITool(message: string, author: string): AIDetectionResult {
  const noDetection: AIDetectionResult = { aiToolDetected: null, aiDetectionMethod: null };

  if (!message && !author) return noDetection;

  // Priority 1: Co-Authored-By trailers (most reliable signal)
  if (message) {
    const coAuthors = parseCoAuthors(message);
    for (const coAuthor of coAuthors) {
      const combined = `${coAuthor.name} <${coAuthor.email}>`;
      for (const sig of AI_SIGNATURES) {
        if (sig.coAuthorPatterns) {
          for (const pattern of sig.coAuthorPatterns) {
            if (pattern.test(combined) || pattern.test(coAuthor.email) || pattern.test(coAuthor.name)) {
              return { aiToolDetected: sig.tool, aiDetectionMethod: 'co-author-trailer' };
            }
          }
        }
      }
    }
  }

  // Priority 2: Author name patterns
  if (author) {
    const authorName = author.trim();
    for (const sig of AI_SIGNATURES) {
      if (sig.authorPatterns) {
        for (const pattern of sig.authorPatterns) {
          if (pattern.test(authorName)) {
            return { aiToolDetected: sig.tool, aiDetectionMethod: 'author-pattern' };
          }
        }
      }
    }
  }

  // Priority 3: Commit message patterns
  if (message) {
    for (const sig of AI_SIGNATURES) {
      if (sig.messagePatterns) {
        for (const pattern of sig.messagePatterns) {
          if (pattern.test(message)) {
            return { aiToolDetected: sig.tool, aiDetectionMethod: 'commit-message' };
          }
        }
      }
    }
  }

  return noDetection;
}
