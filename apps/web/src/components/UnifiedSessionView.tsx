import { useState, useMemo, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { SessionDiff, PromptChange } from '../api';
import type { SessionCommit, SessionSnapshot } from '../api/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Adaptive timestamp:
//   today     → "22:20"
//   yesterday → "Yesterday 22:20"
//   older     → "Apr 14 22:20"
function formatPromptTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.getFullYear() === now.getFullYear() &&
                  d.getMonth() === now.getMonth() &&
                  d.getDate() === now.getDate();
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.getFullYear() === yesterday.getFullYear() &&
                      d.getMonth() === yesterday.getMonth() &&
                      d.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: string;
  content: string;
  toolCalls?: ToolCallEntry[];
}

// Structured tool-call data preserved by the CLI's transcript formatter.
// `input` carries the full Bash command / Edit hunk / etc.; `result` the
// (capped) output. Indexed by id so summary lines can match them.
interface ToolCallEntry {
  id?: string;
  name: string;
  input: Record<string, any>;
  result?: string;
  resultTruncated?: boolean;
}

interface DiffFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  hunks: string[];
  uncommitted?: boolean; // true if this file has uncommitted (not yet committed) changes
}

interface TranscriptTurn {
  turnIndex: number;
  humanMessage: Message | null;
  assistantMessages: Message[];
  promptChange: PromptChange | null;
  systemMessage?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDiff(raw: string): DiffFile[] {
  if (!raw) return [];
  const files: DiffFile[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);
  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const path = headerMatch ? headerMatch[2] : lines[0] || 'unknown';
    let linesAdded = 0;
    let linesRemoved = 0;
    const hunkLines: string[] = [];
    let inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        inHunk = true;
        hunkLines.push(line);
      } else if (inHunk) {
        hunkLines.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
        if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
      }
    }
    files.push({ path, linesAdded, linesRemoved, hunks: hunkLines });
  }
  return files;
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

// ---------------------------------------------------------------------------
// Data correlation
// ---------------------------------------------------------------------------

function buildUnifiedTurns(
  transcript: Message[],
  promptChanges: PromptChange[],
): TranscriptTurn[] {
  const changesByIndex = new Map<number, PromptChange>();
  for (const pc of promptChanges) {
    changesByIndex.set(pc.promptIndex, pc);
  }

  const turns: TranscriptTurn[] = [];
  let humanIndex = -1;
  const matchedIndices = new Set<number>();

  for (const msg of transcript) {
    // Skip system messages — not shown in the session view
    if (msg.role === 'system') continue;

    const isHuman = msg.role === 'human' || msg.role === 'user';
    if (isHuman) {
      humanIndex++;
      const pc = changesByIndex.get(humanIndex) || null;
      if (pc) matchedIndices.add(humanIndex);
      turns.push({
        turnIndex: humanIndex,
        humanMessage: msg,
        assistantMessages: [],
        promptChange: pc,
      });
    } else if (turns.length > 0) {
      turns[turns.length - 1].assistantMessages.push(msg);
    }
  }

  // Append orphan promptChanges
  for (const pc of promptChanges) {
    if (!matchedIndices.has(pc.promptIndex) && pc.promptIndex > humanIndex) {
      turns.push({
        turnIndex: pc.promptIndex,
        humanMessage: null,
        assistantMessages: [],
        promptChange: pc,
      });
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Formatted assistant message renderer
// ---------------------------------------------------------------------------

type ToolCategory = 'read' | 'write' | 'exec' | 'search' | 'web' | 'agent' | 'mcp' | 'meta';

const TOOL_CATEGORY_STYLE: Record<ToolCategory, { border: string; label: string }> = {
  // border uses raw color so tailwind's JIT can't prune it; label is a utility class.
  read:   { border: 'rgb(56 189 248 / 0.55)',  label: 'text-sky-300' },    // Read / Glob / Grep
  write:  { border: 'rgb(251 191 36 / 0.55)',  label: 'text-amber-300' }, // Edit / Write
  exec:   { border: 'rgb(52 211 153 / 0.55)',  label: 'text-emerald-300' }, // Bash
  search: { border: 'rgb(167 139 250 / 0.55)', label: 'text-violet-300' }, // WebSearch
  web:    { border: 'rgb(244 114 182 / 0.55)', label: 'text-pink-300' },   // WebFetch
  agent:  { border: 'rgb(129 140 248 / 0.55)', label: 'text-indigo-300' }, // Task
  mcp:    { border: 'rgb(45 212 191 / 0.55)',  label: 'text-teal-300' },   // mcp__*
  meta:   { border: 'rgb(148 163 184 / 0.45)', label: 'text-slate-400' },  // TodoWrite etc.
};

function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Read': case 'Glob': case 'Grep': case 'NotebookRead': return 'read';
    case 'Edit': case 'Write': case 'NotebookEdit':             return 'write';
    case 'Bash':                                                 return 'exec';
    case 'WebSearch':                                            return 'search';
    case 'WebFetch':                                             return 'web';
    case 'Task':                                                 return 'agent';
    default:                                                     return 'meta';
  }
}

// ── Tool call row — collapsed by default, click to reveal full input + result.
// Only structured tool calls (CLI ≥ this build) are expandable; older
// transcripts render a static one-liner.
function ToolCallRow({
  name,
  arg,
  swatch,
  structured,
}: {
  name: string;
  arg: string;
  swatch: { border: string; label: string };
  structured?: ToolCallEntry;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!structured && (Object.keys(structured.input || {}).length > 0 || !!structured.result);
  // Pick the most readable input field for display — prefer commands/files
  // over arbitrary fields like description.
  const fullInputDisplay = (() => {
    if (!structured) return '';
    const inp = structured.input || {};
    if (typeof inp.command === 'string') return inp.command;
    if (typeof inp.file_path === 'string') return inp.file_path;
    if (typeof inp.path === 'string') return inp.path;
    if (typeof inp.pattern === 'string') return inp.pattern;
    if (typeof inp.url === 'string') return inp.url;
    if (typeof inp.query === 'string') return inp.query;
    // Fall back to JSON dump for less common shapes (Edit, Task, etc.)
    try { return JSON.stringify(inp, null, 2); } catch { return ''; }
  })();

  return (
    <div className="my-1">
      <div
        className={`group flex items-baseline gap-2 pl-3 border-l-2 text-[12px] leading-[1.65] font-mono ${
          hasDetail ? 'cursor-pointer hover:bg-gray-800/40 rounded-r' : ''
        }`}
        style={{ borderColor: swatch.border }}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className={`text-[10px] uppercase tracking-wider font-semibold ${swatch.label}`}>
          {name}
        </span>
        {arg && (
          <span className="text-gray-400 truncate" title={arg}>
            {arg}
          </span>
        )}
        {hasDetail && (
          <span className="ml-auto text-[10px] text-gray-600 group-hover:text-gray-400">
            {open ? '▾' : '▸'}
          </span>
        )}
      </div>
      {open && structured && (
        <div className="ml-3 mt-1 mb-2 pl-3 border-l-2 border-gray-800/60 space-y-2">
          {fullInputDisplay && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Input</div>
              <pre className="text-[11px] leading-[1.5] font-mono text-gray-300 bg-gray-900/60 rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
                {fullInputDisplay}
              </pre>
            </div>
          )}
          {structured.result && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                Result {structured.resultTruncated && <span className="normal-case text-gray-600">(truncated)</span>}
              </div>
              <pre className="text-[11px] leading-[1.5] font-mono text-gray-400 bg-gray-900/40 rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
                {structured.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FormattedMessage({
  text,
  hideToolCalls,
  toolCalls,
}: {
  text: string;
  hideToolCalls?: boolean;
  toolCalls?: ToolCallEntry[];
}) {
  const elements: React.ReactNode[] = [];

  // Track which structured tool call we're currently consuming. Tool-call
  // markers appear in `text` in the same order they do in `toolCalls`, so a
  // running counter is enough to pair them.
  let toolIdx = 0;

  // Split into blocks: code blocks, tool calls, and regular text
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang ... ```
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <div key={key++} className="my-2 rounded-md border border-gray-700 overflow-hidden">
          {lang && (
            <div className="bg-gray-800 px-3 py-1 text-[10px] text-gray-500 font-mono border-b border-gray-700">
              {lang}
            </div>
          )}
          <pre className="bg-gray-900/80 px-3 py-2 text-[12px] leading-[1.6] font-mono text-gray-300 overflow-x-auto">
            {codeLines.join('\n')}
          </pre>
        </div>,
      );
      continue;
    }

    // Tool call patterns: [Tool: ToolName], [Tool: ToolName → arg], [Tool: ToolName: arg]
    const toolMatch = line.match(/^\[Tool:\s*([^\]→:]+?)(?:\s*[→:]\s*(.+?))?\]$/);
    if (toolMatch) {
      if (hideToolCalls) {
        // Filter says hide tool calls — skip the line entirely.
        // Still bump toolIdx so subsequent rows pair with the right entry.
        toolIdx++;
        i++;
        continue;
      }
      const rawName = toolMatch[1].trim();
      const toolArg = toolMatch[2]?.trim() || '';

      // Simplify MCP tool names: mcp__Claude_Preview__preview_click → Preview: click
      let displayName = rawName;
      const mcpMatch = rawName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
      if (mcpMatch) {
        const server = mcpMatch[1].replace(/_/g, ' ');
        const tool = mcpMatch[2].replace(/_/g, ' ');
        displayName = `${server}: ${tool}`;
      }

      const category = toolCategory(rawName);
      const swatch = TOOL_CATEGORY_STYLE[category];

      // Pair with structured data when available — emits an expandable row
      // that shows full input + result on click. Falls back to the legacy
      // one-liner when no structured data exists (older transcripts).
      const structured = toolCalls?.[toolIdx];
      toolIdx++;

      elements.push(
        <ToolCallRow
          key={key++}
          name={displayName}
          arg={toolArg}
          swatch={swatch}
          structured={structured}
        />,
      );
      i++;
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      elements.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }

    // Collect consecutive normal text lines into a paragraph
    const textLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !lines[i].match(
        /^\[(?:Tool:\s*)?(?:Read|Edit|Write|Grep|Glob|Bash|Search|WebFetch|Task)(?:\s*[→:]\s*.+?)?\]$/,
      )
    ) {
      textLines.push(lines[i]);
      i++;
    }

    if (textLines.length > 0) {
      const paragraph = textLines.join('\n');
      elements.push(
        <p key={key++} className="text-[13px] leading-[1.7] text-gray-400">
          {formatInlineText(paragraph)}
        </p>,
      );
    }
  }

  // Group consecutive tool call elements into compact clusters
  const grouped: React.ReactNode[] = [];
  let toolBatch: React.ReactNode[] = [];

  const flushToolBatch = () => {
    if (toolBatch.length > 0) {
      grouped.push(
        <div
          key={`batch-${grouped.length}`}
          className="my-2 rounded-md border border-gray-800/70 bg-gray-900/40 py-1.5"
        >
          {toolBatch}
        </div>,
      );
      toolBatch = [];
    }
  };

  for (const el of elements) {
    // Check if this is a tool call element (has 'my-1' in className)
    const isToolCall =
      el && typeof el === 'object' && 'props' in (el as any) &&
      (el as any).props?.className?.includes('my-1 ');
    if (isToolCall) {
      toolBatch.push(el);
    } else {
      flushToolBatch();
      grouped.push(el);
    }
  }
  flushToolBatch();

  return <div className="space-y-0.5">{grouped}</div>;
}

/** Render inline formatting: `code`, **bold**, *italic*, file paths */
function formatInlineText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Split by inline code, bold, and italic markers
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++}>{text.slice(lastIndex, match.index)}</span>,
      );
    }

    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      // Inline code
      parts.push(
        <code
          key={key++}
          className="bg-gray-800 text-indigo-300 px-1.5 py-0.5 rounded text-[12px] font-mono"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      // Bold
      parts.push(
        <strong key={key++} className="text-gray-200 font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      // Italic
      parts.push(
        <em key={key++} className="text-gray-300 italic">
          {token.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DiffHunkRenderer({ hunks }: { hunks: string[] }) {
  return (
    <pre className="text-[11.5px] leading-[1.65] font-mono">
      {hunks.map((line, i) => {
        let className = 'px-4 ';
        if (line.startsWith('@@')) {
          className += 'bg-indigo-950/30 text-indigo-400/70 py-0.5 border-t border-b border-indigo-500/10 text-[10.5px]';
        } else if (line.startsWith('+')) {
          className += 'bg-emerald-950/25 text-emerald-300/90 border-l-2 border-emerald-500/40';
        } else if (line.startsWith('-')) {
          className += 'bg-red-950/25 text-red-300/90 border-l-2 border-red-500/40';
        } else {
          className += 'text-gray-600 border-l-2 border-transparent';
        }
        return (
          <div key={i} className={className}>
            {line || '\u00a0'}
          </div>
        );
      })}
    </pre>
  );
}

function TurnCard({
  turn,
  isExpanded,
  onToggle,
  expandedFiles,
  onToggleFile,
  diffCache,
  hideToolCalls,
  snapshots,
}: {
  turn: TranscriptTurn;
  isExpanded: boolean;
  onToggle: () => void;
  expandedFiles: Record<string, boolean>;
  onToggleFile: (key: string) => void;
  diffCache: React.MutableRefObject<Map<number, DiffFile[]>>;
  hideToolCalls?: boolean;
  snapshots?: SessionSnapshot[];
}) {
  const pc = turn.promptChange;
  const hasChanges = pc && pc.filesChanged.length > 0;
  const hasDiff = pc && pc.diff && pc.diff.length > 0;
  const hasUncommittedDiff = pc && pc.uncommittedDiff && pc.uncommittedDiff.length > 0;

  const promptText =
    turn.humanMessage?.content || pc?.promptText || '(empty prompt)';

  // Lazy diff parsing — parse combined diff, mark uncommitted files using uncommittedDiff paths
  const files = useMemo(() => {
    if (!hasDiff) return [];
    if (diffCache.current.has(turn.turnIndex)) {
      return diffCache.current.get(turn.turnIndex)!;
    }
    const allFiles = parseDiff(pc!.diff);
    // Identify uncommitted file paths from the separate uncommittedDiff field
    if (hasUncommittedDiff) {
      const uncommittedPaths = new Set(
        parseDiff(pc!.uncommittedDiff!).map(f => f.path)
      );
      for (const f of allFiles) {
        if (uncommittedPaths.has(f.path)) f.uncommitted = true;
      }
    }
    diffCache.current.set(turn.turnIndex, allFiles);
    return allFiles;
  }, [hasDiff, hasUncommittedDiff, turn.turnIndex, pc, diffCache]);

  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);

  // Assistant response
  const assistantText = turn.assistantMessages.map((m) => m.content).join('\n\n');
  // Concatenated structured tool calls in the same order as the merged text.
  const assistantToolCalls = turn.assistantMessages.flatMap((m) => m.toolCalls || []);
  const [showFullResponse, setShowFullResponse] = useState(false);
  const TRUNCATE_LEN = 800;
  const truncatedResponse =
    assistantText.length > TRUNCATE_LEN && !showFullResponse
      ? assistantText.slice(0, TRUNCATE_LEN)
      : assistantText;

  return (
    <div className={`rounded-lg border overflow-hidden transition-colors ${
      isExpanded
        ? 'border-gray-700 bg-gray-800/20'
        : hasChanges
          ? 'border-gray-800 bg-gray-800/10 hover:bg-gray-800/30'
          : 'border-gray-800/50 bg-transparent hover:bg-gray-800/20'
    }`}>
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full text-left px-5 py-3 transition-colors group"
      >
        <div className="flex items-start gap-3">
          {/* Turn number + snapshot rail dots — one dot per snapshot taken
              during this prompt, capped to 5 with a "+N" overflow indicator. */}
          <div className="flex-shrink-0 flex flex-col items-center gap-1 mt-0.5">
            <span className={`text-xs font-mono w-7 h-7 rounded-full flex items-center justify-center ${
              hasChanges
                ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                : 'bg-gray-800 text-gray-500 border border-gray-700'
            }`}>
              {turn.turnIndex + 1}
            </span>
            {snapshots && snapshots.length > 0 && (
              <div
                className="flex flex-col items-center gap-0.5"
                title={`${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} taken during this prompt`}
              >
                {snapshots.slice(0, 5).map((sn) => (
                  <span
                    key={sn.id}
                    className={`w-1.5 h-1.5 rounded-full ${
                      sn.type === 'manual' ? 'bg-amber-400/80' : 'bg-emerald-400/60'
                    }`}
                  />
                ))}
                {snapshots.length > 5 && (
                  <span className="text-[8px] font-mono text-gray-500">+{snapshots.length - 5}</span>
                )}
              </div>
            )}
          </div>

          {/* Prompt text */}
          <div className="flex-1 min-w-0">
            <p className={`text-[13px] leading-relaxed ${
              isExpanded ? 'text-gray-200' : 'text-gray-300 line-clamp-2'
            }`}>
              {promptText}
            </p>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
            {pc?.createdAt && (
              <span className="text-[11px] text-gray-600 tabular-nums" title={new Date(pc.createdAt).toLocaleString()}>
                {formatPromptTime(pc.createdAt)}
              </span>
            )}
            {(hasChanges || files.length > 0) && (
              <span className="text-[11px] text-gray-500 bg-gray-800/60 px-1.5 py-0.5 rounded">
                {files.length > 0 ? files.length : pc!.filesChanged.length} file{(files.length > 0 ? files.length : pc!.filesChanged.length) !== 1 ? 's' : ''}
              </span>
            )}
            {hasDiff && (
              <span className="text-[11px] font-mono">
                <span className="text-green-400/80">+{totalAdded}</span>
                {' '}
                <span className="text-red-400/80">-{totalRemoved}</span>
              </span>
            )}
            <span className="text-gray-700 group-hover:text-gray-500 transition-colors text-xs">
              {isExpanded ? '\u25BC' : '\u25B6'}
            </span>
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-gray-800/60">
          {/* System context is available in session details but hidden from the turn view */}
          {/* Assistant response */}
          {assistantText && (
            <div className="px-5 py-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center">
                  <span className="text-[10px] text-gray-400">A</span>
                </div>
                <span className="text-[11px] font-medium text-gray-500">Assistant</span>
              </div>
              <div className="ml-7">
                <FormattedMessage
                  text={truncatedResponse}
                  hideToolCalls={hideToolCalls}
                  toolCalls={assistantToolCalls}
                />
                {assistantText.length > TRUNCATE_LEN && !showFullResponse && (
                  <span className="text-gray-600">...</span>
                )}
              </div>
              {assistantText.length > TRUNCATE_LEN && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFullResponse((prev) => !prev);
                  }}
                  className="text-[11px] text-indigo-400/70 hover:text-indigo-400 mt-2 ml-7 transition-colors"
                >
                  {showFullResponse ? '\u25B2 Show less' : `\u25BC Show full response (${Math.round(assistantText.length / 1000)}k chars)`}
                </button>
              )}
            </div>
          )}

          {/* Files changed with diffs */}
          {(hasChanges || hasDiff) && (
            <div className={`px-5 py-4 space-y-1.5 ${assistantText ? 'border-t border-gray-800/40' : ''}`}>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center">
                  <span className="text-[10px] text-indigo-400">{'\u{2702}'}</span>
                </div>
                <span className="text-[11px] font-medium text-gray-500">
                  {hasChanges
                    ? `${pc!.filesChanged.length} file${pc!.filesChanged.length !== 1 ? 's' : ''} changed`
                    : `${files.length} file${files.length !== 1 ? 's' : ''} changed`}
                </span>
                {(hasDiff || hasChanges) && (
                  <span className="text-[11px] font-mono text-gray-600">
                    <span className="text-green-400/60">+{totalAdded}</span>
                    {' '}
                    <span className="text-red-400/60">-{totalRemoved}</span>
                  </span>
                )}
              </div>

              {hasDiff ? (
                files.map((file, fileIdx) => {
                  const fileKey = `${turn.turnIndex}-${file.path}-${fileIdx}`;
                  const isFileCollapsed = expandedFiles[fileKey] === false;
                  const isUncommitted = file.uncommitted;
                  return (
                    <div
                      key={fileKey}
                      className={`rounded-lg overflow-hidden ${
                        isUncommitted
                          ? 'ring-1 ring-violet-500/30'
                          : 'ring-1 ring-gray-800/80'
                      }`}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFile(fileKey);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[11px] transition-colors ${
                          isUncommitted
                            ? 'bg-violet-950/30 hover:bg-violet-950/50'
                            : 'bg-gray-800/40 hover:bg-gray-800/70'
                        }`}
                      >
                        <span className="text-gray-600 text-[10px] transition-transform" style={{ transform: isFileCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>
                          {'\u25B6'}
                        </span>
                        <span className={`font-mono flex-1 truncate text-[11.5px] ${
                          isUncommitted ? 'text-violet-300/80' : 'text-gray-300'
                        }`}>
                          {shortenPath(file.path)}
                        </span>
                        {isUncommitted && (
                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400/80">
                            uncommitted
                          </span>
                        )}
                        <span className="font-mono flex items-center gap-1.5">
                          <span className="text-emerald-400/80 text-[11px]">+{file.linesAdded}</span>
                          <span className="text-red-400/80 text-[11px]">-{file.linesRemoved}</span>
                        </span>
                      </button>
                      {!isFileCollapsed && (
                        <div className="overflow-x-auto border-t border-gray-800/30">
                          <DiffHunkRenderer hunks={file.hunks} />
                        </div>
                      )}
                    </div>
                  );
                })
              ) : hasChanges ? (
                <div className="space-y-1 ml-7">
                  {pc!.filesChanged.map((file) => (
                    <div
                      key={file}
                      className="flex items-center gap-2 text-[11px] font-mono text-gray-500"
                    >
                      <span className="truncate" title={file}>
                        {shortenPath(file)}
                      </span>
                    </div>
                  ))}
                  <p className="text-[11px] text-gray-700 italic mt-1">
                    (no diff captured)
                  </p>
                </div>
              ) : null}
            </div>
          )}

          {/* Empty expanded state */}
          {!hasChanges && !hasDiff && !assistantText && (
            <div className="px-5 py-3 text-[11px] text-gray-700">
              No response or code changes captured
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Git Diff footer
// ---------------------------------------------------------------------------

function SessionDiffFooter({
  sessionDiff,
  isExpanded,
  onToggle,
}: {
  sessionDiff: SessionDiff;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const files = useMemo(() => parseDiff(sessionDiff.diff), [sessionDiff.diff]);
  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  return (
    <div className="border-t-2 border-indigo-500/20 mt-6">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-gray-800/20 transition-colors text-left"
      >
        <span className="text-gray-600 text-xs">{isExpanded ? '\u25BC' : '\u25B6'}</span>
        <span className="text-sm font-medium text-gray-400">Full Session Diff</span>
        <div className="flex items-center gap-3 text-[11px] text-gray-600">
          {sessionDiff.commitShas && sessionDiff.commitShas.length > 0 && (
            <span>
              {sessionDiff.commitShas.length} commit{sessionDiff.commitShas.length !== 1 ? 's' : ''}
            </span>
          )}
          <span>{files.length} files</span>
          <span className="text-green-400/60 font-mono">+{totalAdded}</span>
          <span className="text-red-400/60 font-mono">-{totalRemoved}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="px-5 pb-4 space-y-1.5">
          {sessionDiff.diffTruncated && (
            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded px-3 py-2 text-yellow-300 text-xs mb-2">
              Diff was truncated (showing first 500KB).
            </div>
          )}
          {files.map((file, fileIdx) => {
            const fileKey = `git-${file.path}-${fileIdx}`;
            const isCollapsed = collapsedFiles[fileKey] ?? false;
            return (
              <div
                key={fileKey}
                className="border border-gray-800/60 rounded-md overflow-hidden"
              >
                <button
                  onClick={() =>
                    setCollapsedFiles((prev) => ({
                      ...prev,
                      [fileKey]: !prev[fileKey],
                    }))
                  }
                  className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-800/30 hover:bg-gray-800/60 text-left text-[11px] transition-colors"
                >
                  <span className="text-gray-600 text-[10px]">
                    {isCollapsed ? '\u25B6' : '\u25BC'}
                  </span>
                  <span className="font-mono text-gray-300 flex-1 truncate">
                    {shortenPath(file.path)}
                  </span>
                  <span className="text-green-400/70 font-mono">+{file.linesAdded}</span>
                  <span className="text-red-400/70 font-mono">-{file.linesRemoved}</span>
                </button>
                {!isCollapsed && (
                  <div className="overflow-x-auto border-t border-gray-800/40">
                    <DiffHunkRenderer hunks={file.hunks} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface UnifiedSessionViewProps {
  transcript: Message[];
  promptChanges: PromptChange[];
  sessionDiff?: SessionDiff | null;
  // Optional repo id + commit list to render commits inline in the timeline.
  // When provided, each commit slots beneath the prompt that produced it
  // (matched via PromptChange.commitSha) and links to its detail page.
  commits?: SessionCommit[];
  repoId?: string | null;
  // Auto-snapshots for the rail. Each one attributed to a prompt turn renders
  // a small dot; counts pile up next to the turn number.
  snapshots?: SessionSnapshot[];
  // Sort default:
  //   true  (RUNNING sessions) — latest turn at top, feed-like
  //   false (COMPLETED sessions) — oldest first, reads like a conversation
  defaultNewestFirst?: boolean;
}

// Categories for the left-rail filter. Counts are computed from transcript
// markers like `[Tool: Bash → ...]`, prompt count, response count, and the
// commits[] prop. Hiding a category narrows what each TurnCard shows; toggling
// "commits" hides the inline commit rows.
type FilterKey = 'prompts' | 'responses' | 'tools' | 'commits';

export default function UnifiedSessionView({
  transcript,
  promptChanges,
  sessionDiff,
  commits,
  repoId,
  snapshots,
  defaultNewestFirst = true,
}: UnifiedSessionViewProps) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [visibleCount, setVisibleCount] = useState(50);
  const [showSessionDiff, setShowSessionDiff] = useState(false);
  const [newestFirst, setNewestFirst] = useState(defaultNewestFirst);
  const [hidden, setHidden] = useState<Set<FilterKey>>(new Set());
  const diffCache = useRef<Map<number, DiffFile[]>>(new Map());

  const turns = useMemo(
    () => buildUnifiedTurns(transcript, promptChanges),
    [transcript, promptChanges],
  );

  // Per-tool-category counts from transcript markers — same regex the
  // FormattedMessage renderer uses, kept in sync.
  const counts = useMemo(() => {
    let promptsN = 0;
    let responsesN = 0;
    const toolsByCategory: Record<ToolCategory, number> = {
      read: 0, write: 0, exec: 0, search: 0, web: 0, agent: 0, mcp: 0, meta: 0,
    };
    let toolsTotal = 0;
    for (const t of turns) {
      if (t.humanMessage || t.promptChange?.promptText) promptsN++;
      const allText = t.assistantMessages.map((m) => m.content).join('\n');
      // Strip tool-call lines to figure out if there's any actual response text.
      const nonToolText = allText
        .split('\n')
        .filter((ln) => !/^\[Tool:\s*[^\]]+\]$/.test(ln))
        .join('\n')
        .trim();
      if (nonToolText.length > 0) responsesN++;
      const matches = allText.match(/^\[Tool:\s*([^\]→:]+?)(?:\s*[→:].*)?\]$/gm) || [];
      for (const m of matches) {
        const nameMatch = m.match(/^\[Tool:\s*([^\]→:]+?)(?:\s*[→:]|])/);
        const name = nameMatch ? nameMatch[1].trim() : '';
        if (!name) continue;
        toolsByCategory[toolCategory(name)]++;
        toolsTotal++;
      }
    }
    return {
      prompts: promptsN,
      responses: responsesN,
      tools: toolsTotal,
      toolsByCategory,
      commits: commits?.length || 0,
    };
  }, [turns, commits]);

  // Group commits by the prompt that produced them so we can render an inline
  // commit row beneath each turn card.
  const commitsByPromptIndex = useMemo(() => {
    const map = new Map<number, SessionCommit[]>();
    if (!commits || commits.length === 0) return map;
    // Match each commit to the PromptChange that recorded its SHA.
    for (const c of commits) {
      const pc = promptChanges.find((p) => p.commitSha === c.sha);
      const idx = pc?.promptIndex ?? -1;
      const arr = map.get(idx) || [];
      arr.push(c);
      map.set(idx, arr);
    }
    return map;
  }, [commits, promptChanges]);

  // Group snapshots by promptIndex. The CLI tags each upload with the active
  // prompt — so we can decorate that turn's rail without correlating timestamps.
  const snapshotsByPromptIndex = useMemo(() => {
    const map = new Map<number, SessionSnapshot[]>();
    if (!snapshots || snapshots.length === 0) return map;
    for (const sn of snapshots) {
      const idx = sn.promptIndex ?? -1;
      const arr = map.get(idx) || [];
      arr.push(sn);
      map.set(idx, arr);
    }
    return map;
  }, [snapshots]);

  // Commits that didn't match any prompt (legacy rows pre commitSha capture).
  // Surface them at the end so they aren't lost.
  const orphanedCommits = useMemo(() => commitsByPromptIndex.get(-1) || [], [commitsByPromptIndex]);

  const toggleFilter = useCallback((key: FilterKey) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const showCommits = !hidden.has('commits');
  const showTools = !hidden.has('tools');
  const showPrompts = !hidden.has('prompts');
  const showResponses = !hidden.has('responses');

  const orderedTurns = useMemo(
    () => (newestFirst ? [...turns].reverse() : turns),
    [turns, newestFirst],
  );

  const visibleTurns = orderedTurns.slice(0, visibleCount);
  const hasMore = visibleCount < orderedTurns.length;

  const turnsWithChanges = turns.filter((t) => t.promptChange && t.promptChange.filesChanged.length > 0).length;
  const totalFiles = new Set(promptChanges.flatMap((pc) => pc.filesChanged)).size;

  const toggleTurn = useCallback((index: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const toggleFile = useCallback((key: string) => {
    setExpandedFiles((prev) => ({
      ...prev,
      [key]: prev[key] === undefined ? false : !prev[key],
    }));
  }, []);

  const expandAll = useCallback(() => {
    setExpandedTurns(new Set(visibleTurns.map((t) => t.turnIndex)));
  }, [visibleTurns]);

  const collapseAll = useCallback(() => {
    setExpandedTurns(new Set());
    setExpandedFiles({});
  }, []);

  // Empty state
  if (turns.length === 0 && !sessionDiff?.diff) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <div className="text-3xl mb-2">{'\u{1F4AC}'}</div>
          <p>No session data available</p>
          <p className="text-xs mt-1 text-gray-600">
            Transcript and code changes will appear here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="px-5 py-2 border-b border-gray-800/60 flex-shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-4 text-[11px] text-gray-600">
          <span>{turns.length} turn{turns.length !== 1 ? 's' : ''}</span>
          {turnsWithChanges > 0 && (
            <span className="text-indigo-400/70">{turnsWithChanges} with changes</span>
          )}
          {totalFiles > 0 && (
            <span>{totalFiles} file{totalFiles !== 1 ? 's' : ''} modified</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <button
            onClick={() => { setNewestFirst((prev) => !prev); setVisibleCount(50); }}
            className="text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
          >
            {newestFirst ? '↓ Newest first' : '↑ Oldest first'}
          </button>
          <span className="text-gray-800">|</span>
          <button
            onClick={expandAll}
            className="text-gray-600 hover:text-gray-400 transition-colors"
          >
            Expand all
          </button>
          <button
            onClick={collapseAll}
            className="text-gray-600 hover:text-gray-400 transition-colors"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* Body: filter rail + timeline */}
      <div className="flex-1 overflow-hidden flex">
        {/* Filter rail */}
        <aside className="hidden lg:block w-48 flex-shrink-0 border-r border-gray-800/60 px-3 py-4 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2 px-1">Filters</div>
          <FilterRow
            label="Prompts"
            count={counts.prompts}
            checked={showPrompts}
            onToggle={() => toggleFilter('prompts')}
            iconColor="text-indigo-400"
          />
          <FilterRow
            label="Responses"
            count={counts.responses}
            checked={showResponses}
            onToggle={() => toggleFilter('responses')}
            iconColor="text-gray-400"
          />
          <FilterRow
            label="Tool calls"
            count={counts.tools}
            checked={showTools}
            onToggle={() => toggleFilter('tools')}
            iconColor="text-emerald-400"
          />
          {/* Tool sub-counts — read-only breakdown so users can see what's
              happening even when they don't toggle them individually. */}
          {counts.tools > 0 && showTools && (
            <div className="mt-1 ml-3 mb-2 space-y-0.5">
              {(['exec', 'read', 'write', 'search', 'web', 'agent', 'mcp', 'meta'] as ToolCategory[])
                .filter((cat) => counts.toolsByCategory[cat] > 0)
                .map((cat) => (
                  <div key={cat} className="flex items-center justify-between text-[10px] text-gray-500 px-1">
                    <span className={TOOL_CATEGORY_STYLE[cat].label}>
                      {cat === 'exec' ? 'Bash' : cat === 'read' ? 'Read' : cat === 'write' ? 'Edit' : cat[0].toUpperCase() + cat.slice(1)}
                    </span>
                    <span className="font-mono">{counts.toolsByCategory[cat]}</span>
                  </div>
                ))}
            </div>
          )}
          {counts.commits > 0 && (
            <FilterRow
              label="Commits"
              count={counts.commits}
              checked={showCommits}
              onToggle={() => toggleFilter('commits')}
              iconColor="text-amber-400"
            />
          )}
        </aside>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-2 max-w-5xl mx-auto">
          {visibleTurns.map((turn) => {
            const turnCommits = showCommits ? (commitsByPromptIndex.get(turn.turnIndex) || []) : [];
            // Hide turn entirely when both prompts and responses are filtered out
            // and there's nothing else (no tool calls visible, no commits).
            const turnHasResponse = turn.assistantMessages.some((m) =>
              m.content.split('\n').some((ln) => !/^\[Tool:\s*[^\]]+\]$/.test(ln) && ln.trim()),
            );
            const turnHasPrompt = !!(turn.humanMessage || turn.promptChange?.promptText);
            const visibleByPrompt = showPrompts ? turnHasPrompt : false;
            const visibleByResponse = showResponses ? turnHasResponse : false;
            const visibleByTools = showTools && turn.assistantMessages.some((m) => /\[Tool:/.test(m.content));
            const visibleByCommit = turnCommits.length > 0;
            if (!visibleByPrompt && !visibleByResponse && !visibleByTools && !visibleByCommit) return null;

            return (
              <div key={turn.turnIndex}>
                <TurnCard
                  turn={turn}
                  isExpanded={expandedTurns.has(turn.turnIndex)}
                  onToggle={() => toggleTurn(turn.turnIndex)}
                  expandedFiles={expandedFiles}
                  onToggleFile={toggleFile}
                  diffCache={diffCache}
                  hideToolCalls={!showTools}
                  snapshots={snapshotsByPromptIndex.get(turn.turnIndex) || []}
                />
                {turnCommits.map((c) => (
                  <CommitRow key={c.sha} commit={c} repoId={repoId} />
                ))}
              </div>
            );
          })}

          {/* Orphaned commits — couldn't be matched to a prompt via commitSha
              (legacy data, or commit made outside any tracked prompt window).
              Show at the end of the timeline so they're still visible. */}
          {showCommits && orphanedCommits.length > 0 && (
            <div className="pt-2 mt-2 border-t border-gray-800/40">
              <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1.5 px-1">
                Other commits in this session
              </div>
              {orphanedCommits.map((c) => (
                <CommitRow key={c.sha} commit={c} repoId={repoId} />
              ))}
            </div>
          )}
        </div>

        {/* Load more */}
        {hasMore && (
          <div className="text-center py-4">
            <button
              onClick={() => setVisibleCount((prev) => prev + 50)}
              className="text-[11px] text-indigo-400/70 hover:text-indigo-400 bg-indigo-600/10 hover:bg-indigo-600/20 px-4 py-2 rounded-lg transition-colors"
            >
              Load more ({orderedTurns.length - visibleCount} remaining)
            </button>
          </div>
        )}

        {/* Full session git diff footer */}
        {sessionDiff?.diff && (
          <div className="max-w-5xl mx-auto">
            <SessionDiffFooter
              sessionDiff={sessionDiff}
              isExpanded={showSessionDiff}
              onToggle={() => setShowSessionDiff((prev) => !prev)}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

// ── Filter rail row ─────────────────────────────────────────────────────────
function FilterRow({
  label,
  count,
  checked,
  onToggle,
  iconColor,
}: {
  label: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
  iconColor: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center justify-between text-[12px] py-1.5 px-1 rounded hover:bg-gray-800/50 transition-colors ${
        checked ? 'text-gray-200' : 'text-gray-600'
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
            checked ? `border-current ${iconColor}` : 'border-gray-700'
          }`}
        >
          {checked && (
            <svg className="w-2 h-2" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-6" />
            </svg>
          )}
        </span>
        <span>{label}</span>
      </span>
      <span className="font-mono text-[11px] text-gray-500">{count}</span>
    </button>
  );
}

// ── Commit row (inline in timeline) ────────────────────────────────────────
// Mirrors Entire's compact commit pill: SHA, subject, branch, +/- counts.
function CommitRow({ commit, repoId }: { commit: SessionCommit; repoId?: string | null }) {
  const subject = (commit.message || '').split('\n')[0] || '(no message)';
  const inner = (
    <div className="flex items-center gap-3 py-1.5 px-3 my-1 rounded border border-amber-500/15 bg-amber-500/5 hover:bg-amber-500/10 transition-colors">
      <svg className="w-3.5 h-3.5 text-amber-400/80 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 7h14M5 12h14M5 17h14" /></svg>
      <code className="text-[11px] font-mono text-amber-300/90">{commit.sha.slice(0, 8)}</code>
      <span className="text-[12px] text-gray-300 truncate flex-1" title={commit.message}>
        {subject}
      </span>
      {commit.branch && (
        <span className="text-[10px] font-mono text-gray-500 hidden sm:inline">
          {commit.branch}
        </span>
      )}
      <span className="text-[10px] text-gray-500 font-mono whitespace-nowrap">
        {commit.filesChanged.length} file{commit.filesChanged.length !== 1 ? 's' : ''}
      </span>
    </div>
  );
  return repoId ? (
    <Link to={`/repos/${repoId}/commits/${commit.sha}`} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
