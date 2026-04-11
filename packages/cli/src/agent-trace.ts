import { randomUUID } from 'crypto';
import { git, gitDetailed, runDetailed } from './utils/exec.js';
import { getLineBlame, type LineAttribution } from './attribution.js';
import { getGitRoot, getHeadSha } from './session-state.js';

const HEX = /^[a-fA-F0-9]+$/;

// ─── Agent Trace Types (v0.1.0) ─────────────────────────────────────────

export interface AgentTraceContributor {
  type: 'ai' | 'human' | 'mixed' | 'unknown';
  model_id?: string;
}

export interface AgentTraceRange {
  start_line: number;
  end_line: number;
}

export interface AgentTraceConversation {
  url: string;
  contributor: AgentTraceContributor;
  ranges: AgentTraceRange[];
}

export interface AgentTraceFile {
  path: string;
  conversations: AgentTraceConversation[];
}

export interface AgentTraceRecord {
  version: '0.1.0';
  id: string;
  timestamp: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: AgentTraceFile[];
  metadata: Record<string, unknown>;
}

// ─── Model ID Mapping ───────────────────────────────────────────────────

const ORIGIN_TO_MODEL_ID: Record<string, string> = {
  'claude': 'anthropic/claude-opus-4-6',
  'claude-code': 'anthropic/claude-opus-4-6',
  'gemini': 'google/gemini-2.0-flash',
  'gemini-cli': 'google/gemini-2.0-flash',
  'cursor': 'cursor/default',
  'codex': 'openai/gpt-5.3-codex',
};

const MODEL_ID_TO_ORIGIN: Record<string, string> = {
  'anthropic/claude-opus-4-6': 'claude',
  'anthropic/claude-opus-4-5': 'claude',
  'anthropic/claude-sonnet-4': 'claude',
  'google/gemini-2.0-flash': 'gemini',
  'cursor/default': 'cursor',
  'openai/gpt-5.3-codex': 'codex',
};

function originAgentToModelId(tool?: string, model?: string): string | undefined {
  if (tool && ORIGIN_TO_MODEL_ID[tool]) return ORIGIN_TO_MODEL_ID[tool];
  if (model) {
    const m = model.toLowerCase();
    if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return 'anthropic/claude-opus-4-6';
    if (m.includes('gemini')) return 'google/gemini-2.0-flash';
    if (m.includes('gpt') || m.includes('codex')) return 'openai/gpt-5.3-codex';
  }
  return undefined;
}

function modelIdToOriginAgent(modelId: string): string {
  if (MODEL_ID_TO_ORIGIN[modelId]) return MODEL_ID_TO_ORIGIN[modelId];
  const m = modelId.toLowerCase();
  if (m.includes('anthropic') || m.includes('claude')) return 'claude';
  if (m.includes('google') || m.includes('gemini')) return 'gemini';
  if (m.includes('cursor')) return 'cursor';
  if (m.includes('openai') || m.includes('codex') || m.includes('gpt')) return 'codex';
  return 'ai';
}

// ─── Helpers ────────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
  cwd,
  timeoutMs: 10_000,
  maxBuffer: 10 * 1024 * 1024,
});

function getToolVersion(repoPath: string): string {
  try {
    // Safe: node is a fixed file, all other args are literal strings — no shell.
    const r = runDetailed(
      'node',
      ['-e', "process.stdout.write(require('@origin/cli/package.json').version)"],
      execOpts(repoPath),
    );
    const v = (r.stdout || '').trim();
    if (r.status === 0 && v) return v;
  } catch { /* fallback */ }
  return '0.0.0';
}

function getTrackedFiles(repoPath: string): string[] {
  try {
    return git(['ls-files'], execOpts(repoPath))
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getFilesForSession(repoPath: string, sessionId: string): string[] {
  // Look for commits with this sessionId in their origin notes
  const files = new Set<string>();
  try {
    const commits = git(
      ['log', '--format=%H', '-100', 'HEAD'],
      execOpts(repoPath),
    ).trim().split('\n').filter(Boolean);

    for (const sha of commits) {
      if (!HEX.test(sha)) continue;
      try {
        const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], execOpts(repoPath));
        if (r.status !== 0) continue;
        const note = JSON.parse(r.stdout.trim());
        const data = note?.origin || note;
        if (data?.sessionId === sessionId) {
          const changed = git(
            ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
            execOpts(repoPath),
          ).trim().split('\n').filter(Boolean);
          for (const f of changed) files.add(f);
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return Array.from(files);
}

function getDiffFiles(repoPath: string): string[] {
  // Get files that have been changed in recent commits (HEAD~20..HEAD as default scope)
  try {
    const r = gitDetailed(['diff', '--name-only', 'HEAD~20..HEAD'], execOpts(repoPath));
    if (r.status === 0) {
      return r.stdout.trim().split('\n').filter(Boolean);
    }
    return git(['diff', '--name-only', 'HEAD'], execOpts(repoPath))
      .trim().split('\n').filter(Boolean);
  } catch {
    return getTrackedFiles(repoPath);
  }
}

// ─── Group line attributions into conversations ─────────────────────────

interface ConversationGroup {
  sessionId: string;
  type: 'ai' | 'human' | 'mixed' | 'unknown';
  modelId?: string;
  ranges: AgentTraceRange[];
}

function groupLinesIntoConversations(lines: LineAttribution[]): ConversationGroup[] {
  // Group consecutive lines by sessionId + authorship
  const groups: ConversationGroup[] = [];

  let current: {
    sessionId: string;
    authorship: string;
    tool?: string;
    model?: string;
    startLine: number;
    endLine: number;
  } | null = null;

  for (const line of lines) {
    const sid = line.sessionId || (line.authorship === 'human' ? '__human__' : '__unknown__');
    const key = `${sid}|${line.authorship}`;

    if (current && `${current.sessionId}|${current.authorship}` === key && line.lineNumber === current.endLine + 1) {
      current.endLine = line.lineNumber;
    } else {
      if (current) {
        pushGroup(groups, current);
      }
      current = {
        sessionId: sid,
        authorship: line.authorship,
        tool: line.tool,
        model: line.model,
        startLine: line.lineNumber,
        endLine: line.lineNumber,
      };
    }
  }
  if (current) {
    pushGroup(groups, current);
  }

  // Merge ranges for same session
  const merged = new Map<string, ConversationGroup>();
  for (const g of groups) {
    const key = `${g.sessionId}|${g.type}|${g.modelId || ''}`;
    if (merged.has(key)) {
      merged.get(key)!.ranges.push(...g.ranges);
    } else {
      merged.set(key, { ...g, ranges: [...g.ranges] });
    }
  }

  return Array.from(merged.values());
}

function pushGroup(groups: ConversationGroup[], current: {
  sessionId: string;
  authorship: string;
  tool?: string;
  model?: string;
  startLine: number;
  endLine: number;
}): void {
  const contributorType = current.authorship === 'ai' ? 'ai'
    : current.authorship === 'human' ? 'human'
    : current.authorship === 'mixed' ? 'mixed'
    : 'unknown';

  groups.push({
    sessionId: current.sessionId,
    type: contributorType as 'ai' | 'human' | 'mixed' | 'unknown',
    modelId: originAgentToModelId(current.tool, current.model),
    ranges: [{ start_line: current.startLine, end_line: current.endLine }],
  });
}

// ─── Export ─────────────────────────────────────────────────────────────

/**
 * Export repository attribution data in Cursor Agent Trace v0.1.0 format.
 *
 * Uses existing getLineBlame() for per-line attribution and maps it to
 * the Agent Trace JSON schema.
 */
export function exportAgentTrace(repoPath: string, sessionId?: string): AgentTraceRecord {
  const revision = getHeadSha(repoPath) || 'unknown';

  // Determine which files to include
  let files: string[];
  if (sessionId) {
    files = getFilesForSession(repoPath, sessionId);
  } else {
    files = getDiffFiles(repoPath);
  }

  // Build per-file trace entries
  const traceFiles: AgentTraceFile[] = [];

  for (const filePath of files) {
    // Verify file exists at HEAD
    const exists = gitDetailed(['cat-file', '-e', `HEAD:${filePath}`], execOpts(repoPath));
    if (exists.status !== 0) continue; // file deleted

    const lines = getLineBlame(repoPath, filePath);
    if (lines.length === 0) continue;

    // If sessionId filter is set, only include lines from that session
    const filteredLines = sessionId
      ? lines.filter(l => l.sessionId === sessionId || l.authorship === 'human')
      : lines;

    const conversationGroups = groupLinesIntoConversations(filteredLines);

    const conversations: AgentTraceConversation[] = conversationGroups.map(g => ({
      url: g.sessionId.startsWith('__')
        ? `origin://unknown`
        : `origin://session/${g.sessionId}`,
      contributor: {
        type: g.type,
        ...(g.modelId ? { model_id: g.modelId } : {}),
      },
      ranges: g.ranges,
    }));

    if (conversations.length > 0) {
      traceFiles.push({ path: filePath, conversations });
    }
  }

  return {
    version: '0.1.0',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    vcs: { type: 'git', revision },
    tool: { name: 'origin', version: getToolVersion(repoPath) },
    files: traceFiles,
    metadata: {},
  };
}

// ─── Import ─────────────────────────────────────────────────────────────

/**
 * Import an Agent Trace record and write attribution as git notes on the
 * specified VCS revision.
 */
export function importAgentTrace(repoPath: string, traceData: AgentTraceRecord): void {
  const revision = traceData.vcs?.revision;
  if (!revision || revision === 'unknown') {
    throw new Error('Agent trace record has no valid VCS revision.');
  }

  // Verify the revision exists in this repo. Only allow safe ref characters.
  if (!/^[a-zA-Z0-9_./~^-]+$/.test(revision)) {
    throw new Error(`Invalid revision format: ${revision}`);
  }
  const exists = gitDetailed(['cat-file', '-e', revision], execOpts(repoPath));
  if (exists.status !== 0) {
    throw new Error(`Revision ${revision} not found in repository.`);
  }

  // Build Origin note data from trace
  const attribution: Record<string, {
    aiLines: number[];
    humanLines: number[];
    model?: string;
    agent?: string;
  }> = {};

  for (const file of traceData.files) {
    const fileAttr: { aiLines: number[]; humanLines: number[]; model?: string; agent?: string } = {
      aiLines: [],
      humanLines: [],
    };

    for (const conv of file.conversations) {
      const lineNumbers: number[] = [];
      for (const range of conv.ranges) {
        for (let l = range.start_line; l <= range.end_line; l++) {
          lineNumbers.push(l);
        }
      }

      if (conv.contributor.type === 'ai' || conv.contributor.type === 'mixed') {
        fileAttr.aiLines.push(...lineNumbers);
        if (conv.contributor.model_id) {
          fileAttr.model = conv.contributor.model_id;
          fileAttr.agent = modelIdToOriginAgent(conv.contributor.model_id);
        }
      } else {
        fileAttr.humanLines.push(...lineNumbers);
      }
    }

    attribution[file.path] = fileAttr;
  }

  // Build the note payload
  const noteData = {
    origin: {
      sessionId: traceData.id,
      source: 'agent-trace',
      sourceVersion: traceData.version,
      sourceTool: traceData.tool?.name,
      timestamp: traceData.timestamp,
      attribution: { files: attribution },
    },
  };

  // Write git note
  try {
    git(
      ['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(noteData), revision],
      execOpts(repoPath),
    );
  } catch (err: any) {
    throw new Error(`Failed to write git note: ${err.message}`);
  }
}
