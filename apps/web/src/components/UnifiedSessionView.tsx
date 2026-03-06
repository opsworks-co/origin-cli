import { useState, useMemo, useRef, useCallback } from 'react';
import type { SessionDiff, PromptChange } from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: string;
  content: string;
}

interface DiffFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  hunks: string[];
}

interface TranscriptTurn {
  turnIndex: number;
  humanMessage: Message | null;
  assistantMessages: Message[];
  promptChange: PromptChange | null;
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

function DiffHunkRenderer({ hunks }: { hunks: string[] }) {
  return (
    <pre className="text-[11px] leading-[1.6] font-mono">
      {hunks.map((line, i) => {
        let className = 'px-4 ';
        if (line.startsWith('@@')) {
          className += 'bg-blue-900/15 text-blue-400/80 py-0.5';
        } else if (line.startsWith('+')) {
          className += 'bg-green-900/15 text-green-300';
        } else if (line.startsWith('-')) {
          className += 'bg-red-900/15 text-red-300';
        } else {
          className += 'text-gray-600';
        }
        return (
          <div key={i} className={className}>
            {line}
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
}: {
  turn: TranscriptTurn;
  isExpanded: boolean;
  onToggle: () => void;
  expandedFiles: Record<string, boolean>;
  onToggleFile: (key: string) => void;
  diffCache: React.MutableRefObject<Map<number, DiffFile[]>>;
}) {
  const pc = turn.promptChange;
  const hasChanges = pc && pc.filesChanged.length > 0;
  const hasDiff = pc && pc.diff && pc.diff.length > 0;

  const promptText =
    turn.humanMessage?.content || pc?.promptText || '(empty prompt)';

  // Lazy diff parsing
  const files = useMemo(() => {
    if (!hasDiff) return [];
    if (diffCache.current.has(turn.turnIndex)) {
      return diffCache.current.get(turn.turnIndex)!;
    }
    const parsed = parseDiff(pc!.diff);
    diffCache.current.set(turn.turnIndex, parsed);
    return parsed;
  }, [hasDiff, turn.turnIndex, pc, diffCache]);

  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);

  // Assistant response
  const assistantText = turn.assistantMessages.map((m) => m.content).join('\n\n');
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
          {/* Turn number */}
          <span className={`flex-shrink-0 text-xs font-mono w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${
            hasChanges
              ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
              : 'bg-gray-800 text-gray-500 border border-gray-700'
          }`}>
            {turn.turnIndex + 1}
          </span>

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
            {hasChanges && (
              <span className="text-[11px] text-gray-500 bg-gray-800/60 px-1.5 py-0.5 rounded">
                {pc!.filesChanged.length} file{pc!.filesChanged.length !== 1 ? 's' : ''}
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
          {/* Assistant response */}
          {assistantText && (
            <div className="px-5 py-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center">
                  <span className="text-[10px] text-gray-400">A</span>
                </div>
                <span className="text-[11px] font-medium text-gray-500">Assistant</span>
              </div>
              <div className="text-[13px] leading-[1.7] whitespace-pre-wrap text-gray-400 ml-7">
                {truncatedResponse}
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
          {hasChanges && (
            <div className={`px-5 py-4 space-y-1.5 ${assistantText ? 'border-t border-gray-800/40' : ''}`}>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center">
                  <span className="text-[10px] text-indigo-400">{'\u{2702}'}</span>
                </div>
                <span className="text-[11px] font-medium text-gray-500">
                  {pc!.filesChanged.length} file{pc!.filesChanged.length !== 1 ? 's' : ''} changed
                </span>
                {hasDiff && (
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
                  return (
                    <div
                      key={fileKey}
                      className="border border-gray-800/60 rounded-md overflow-hidden"
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFile(fileKey);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-800/30 hover:bg-gray-800/60 text-left text-[11px] transition-colors"
                      >
                        <span className="text-gray-600 text-[10px]">
                          {isFileCollapsed ? '\u25B6' : '\u25BC'}
                        </span>
                        <span className="font-mono text-gray-300 flex-1 truncate">
                          {shortenPath(file.path)}
                        </span>
                        <span className="text-green-400/70 font-mono">+{file.linesAdded}</span>
                        <span className="text-red-400/70 font-mono">-{file.linesRemoved}</span>
                      </button>
                      {!isFileCollapsed && (
                        <div className="overflow-x-auto border-t border-gray-800/40">
                          <DiffHunkRenderer hunks={file.hunks} />
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
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
              )}
            </div>
          )}

          {/* Empty expanded state */}
          {!hasChanges && !assistantText && (
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
}

export default function UnifiedSessionView({
  transcript,
  promptChanges,
  sessionDiff,
}: UnifiedSessionViewProps) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [visibleCount, setVisibleCount] = useState(50);
  const [showSessionDiff, setShowSessionDiff] = useState(false);
  const diffCache = useRef<Map<number, DiffFile[]>>(new Map());

  const turns = useMemo(
    () => buildUnifiedTurns(transcript, promptChanges),
    [transcript, promptChanges],
  );

  const visibleTurns = turns.slice(0, visibleCount);
  const hasMore = visibleCount < turns.length;

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

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-2 max-w-5xl mx-auto">
          {visibleTurns.map((turn) => (
            <TurnCard
              key={turn.turnIndex}
              turn={turn}
              isExpanded={expandedTurns.has(turn.turnIndex)}
              onToggle={() => toggleTurn(turn.turnIndex)}
              expandedFiles={expandedFiles}
              onToggleFile={toggleFile}
              diffCache={diffCache}
            />
          ))}
        </div>

        {/* Load more */}
        {hasMore && (
          <div className="text-center py-4">
            <button
              onClick={() => setVisibleCount((prev) => prev + 50)}
              className="text-[11px] text-indigo-400/70 hover:text-indigo-400 bg-indigo-600/10 hover:bg-indigo-600/20 px-4 py-2 rounded-lg transition-colors"
            >
              Load more ({turns.length - visibleCount} remaining)
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
  );
}
