import { useState, useEffect, useMemo, useRef } from 'react';
import * as api from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlameLine {
  lineNumber: number;
  content: string;
  attribution: {
    promptIndex: number;
    promptText: string;
    type: 'added' | 'modified';
  } | null;
  isGap?: boolean;
}

interface BlamePrompt {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
}

interface BlameResult {
  file: string;
  sessionId: string;
  model: string;
  totalAttributedLines: number;
  lines: BlameLine[];
  prompts: BlamePrompt[];
}

// ---------------------------------------------------------------------------
// Build-artifact filter
// ---------------------------------------------------------------------------
// Mirrors packages/cli/src/ignore-patterns.ts so the UI hides the same files
// the CLI ignores. If you change this list, update both — there is no shared
// source yet (see TODO at bottom of file).

const BUILD_ARTIFACT_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)vendor\//,
  /(^|\/)__snapshots__\//,
  /(^|\/)web-dist\//,
  /\.min\.(js|css)$/,
  /\.generated\./,
  /\.map$/,
  /\.snap(\.new)?$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)prisma\/migrations\//,
  /(^|\/)drizzle\/meta\//,
];

function isBuildArtifact(file: string): boolean {
  return BUILD_ARTIFACT_PATTERNS.some((re) => re.test(file));
}

// ---------------------------------------------------------------------------
// Prompt color palette
// ---------------------------------------------------------------------------

const PROMPT_COLORS = [
  { border: 'border-l-blue-400', bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
  { border: 'border-l-green-400', bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  { border: 'border-l-purple-400', bg: 'bg-purple-500/10', text: 'text-purple-400', dot: 'bg-purple-400' },
  { border: 'border-l-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-400', dot: 'bg-amber-400' },
  { border: 'border-l-pink-400', bg: 'bg-pink-500/10', text: 'text-pink-400', dot: 'bg-pink-400' },
  { border: 'border-l-cyan-400', bg: 'bg-cyan-500/10', text: 'text-cyan-400', dot: 'bg-cyan-400' },
  { border: 'border-l-orange-400', bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-400' },
  { border: 'border-l-teal-400', bg: 'bg-teal-500/10', text: 'text-teal-400', dot: 'bg-teal-400' },
  { border: 'border-l-rose-400', bg: 'bg-rose-500/10', text: 'text-rose-400', dot: 'bg-rose-400' },
  { border: 'border-l-indigo-400', bg: 'bg-indigo-500/10', text: 'text-indigo-400', dot: 'bg-indigo-400' },
];

function getPromptColor(index: number) {
  return PROMPT_COLORS[index % PROMPT_COLORS.length];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const shortenPath = (p: string) => {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
};

const getFileName = (p: string) => {
  const parts = p.split('/');
  return parts[parts.length - 1];
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

type ViewMode = 'prompt' | 'file';

interface AiBlameViewProps {
  sessionId: string;
  filesChanged: string[];
  onAskAboutLine?: (file: string, lineNumber: number, content: string) => void;
  /**
   * Deep-link target. When set (e.g. user clicked "Open AI blame →" on a
   * commit detail page), the view auto-switches to "By File", picks a file
   * the prompt touched, expands the prompt's card, and scrolls it into
   * view. Set once at mount; user can navigate freely afterward.
   */
  focusPromptIndex?: number | null;
}

export default function AiBlameView({
  sessionId,
  filesChanged,
  onAskAboutLine,
  focusPromptIndex = null,
}: AiBlameViewProps) {
  // ── All hooks declared up front — no conditional hooks ───────────────────

  // Default tab: "By Prompt" — Origin's actual moat. You can't get this from git.
  // "By File" is the fallback for "what did AI do to *this specific file*."
  // When the parent passes focusPromptIndex (deep-link from commit detail),
  // jump straight to "By File" since that's the line-level view the user
  // expects to land on.
  const [viewMode, setViewMode] = useState<ViewMode>(
    focusPromptIndex != null ? 'file' : 'prompt',
  );

  // Build-artifact toggle (hidden by default — see BUILD_ARTIFACT_PATTERNS).
  const [showBuildArtifacts, setShowBuildArtifacts] = useState(false);

  // One-shot file selection passed from prompt view → file view.
  // Set when user clicks a file in ByPromptView; consumed by ByFileView.
  const [pendingFileSelect, setPendingFileSelect] = useState<string | null>(null);

  const trackableFiles = useMemo(() => {
    return showBuildArtifacts
      ? filesChanged
      : filesChanged.filter((f) => !isBuildArtifact(f));
  }, [filesChanged, showBuildArtifacts]);

  const hiddenArtifactCount = filesChanged.length - trackableFiles.length;

  // ── Render ───────────────────────────────────────────────────────────────

  // Empty session — no files at all
  if (filesChanged.length === 0) {
    return (
      <div className="p-5 text-center py-12">
        <p className="text-gray-500 text-sm">No files changed in this session.</p>
      </div>
    );
  }

  // All files were build artifacts and they're hidden
  if (trackableFiles.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <ToolbarTabs viewMode={viewMode} setViewMode={setViewMode} />
        <div className="p-5 text-center py-12">
          <p className="text-gray-500 text-sm">
            This session only modified build artifacts (
            {filesChanged.length} file{filesChanged.length !== 1 ? 's' : ''}).
          </p>
          <button
            onClick={() => setShowBuildArtifacts(true)}
            className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 underline"
          >
            Show {filesChanged.length} build artifact{filesChanged.length !== 1 ? 's' : ''} anyway
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <ToolbarTabs
        viewMode={viewMode}
        setViewMode={setViewMode}
        rightSlot={
          hiddenArtifactCount > 0 ? (
            <button
              onClick={() => setShowBuildArtifacts((v) => !v)}
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              title={showBuildArtifacts ? 'Hide build artifacts' : 'Show build artifacts'}
            >
              {showBuildArtifacts ? '✓ ' : ''}
              Hide {hiddenArtifactCount} build artifact{hiddenArtifactCount !== 1 ? 's' : ''}
            </button>
          ) : null
        }
      />

      {viewMode === 'prompt' ? (
        <ByPromptView
          sessionId={sessionId}
          trackableFiles={trackableFiles}
          onJumpToFile={(file) => {
            setPendingFileSelect(file);
            setViewMode('file');
          }}
        />
      ) : (
        <ByFileView
          sessionId={sessionId}
          trackableFiles={trackableFiles}
          initialFile={pendingFileSelect}
          onConsumed={() => setPendingFileSelect(null)}
          onAskAboutLine={onAskAboutLine}
          focusPromptIndex={focusPromptIndex}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar — tab switcher + right-side slot for filters
// ---------------------------------------------------------------------------

function ToolbarTabs({
  viewMode,
  setViewMode,
  rightSlot,
}: {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-3 flex-shrink-0">
      <div className="flex items-center gap-1 bg-gray-900/50 rounded-md p-0.5 border border-gray-800">
        <TabButton active={viewMode === 'prompt'} onClick={() => setViewMode('prompt')}>
          By Prompt
        </TabButton>
        <TabButton active={viewMode === 'file'} onClick={() => setViewMode('file')}>
          By File
        </TabButton>
      </div>
      <div className="ml-auto">{rightSlot}</div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
        active
          ? 'bg-gray-800 text-gray-100'
          : 'text-gray-400 hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// By-Prompt View — the default.  Shows every prompt in the session, what
// files it touched, and lets you jump into the file-level blame view for any
// of those files.  This is the answer to "what did each prompt actually do?"
// — a question git can't answer.
// ---------------------------------------------------------------------------

function ByPromptView({
  sessionId,
  trackableFiles,
  onJumpToFile,
}: {
  sessionId: string;
  trackableFiles: string[];
  onJumpToFile: (file: string) => void;
}) {
  const [prompts, setPrompts] = useState<BlamePrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(new Set());

  // Fetch prompts list ONCE — using any file as the lookup key, since the
  // server returns the full session-level prompts array on every blame call.
  useEffect(() => {
    if (trackableFiles.length === 0) return;
    setLoading(true);
    setError('');
    api
      .getSessionBlame(sessionId, trackableFiles[0])
      .then((res) => {
        setPrompts(res.prompts || []);
        // Auto-expand first prompt so the view isn't a wall of collapsed rows
        if (res.prompts && res.prompts.length > 0) {
          setExpandedPrompts(new Set([res.prompts[0].promptIndex]));
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, trackableFiles]);

  const togglePrompt = (idx: number) => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // Build the trackable-file set for filtering each prompt's filesChanged
  const trackableSet = useMemo(() => new Set(trackableFiles), [trackableFiles]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5 text-center py-12">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  // Filter prompts that only touched build artifacts (since those are hidden)
  const visiblePrompts = prompts.filter((p) =>
    p.filesChanged.some((f) => trackableSet.has(f)),
  );

  if (visiblePrompts.length === 0) {
    return (
      <div className="p-5 text-center py-12">
        <p className="text-gray-500 text-sm">No prompts produced source code in this session.</p>
        <p className="text-gray-600 text-xs mt-1">
          (Prompts that only modified build artifacts are hidden by default.)
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-3 text-[11px] text-gray-500 border-b border-gray-800/50">
        {visiblePrompts.length} prompt{visiblePrompts.length !== 1 ? 's' : ''} produced source code.
        Click a file to see line-level attribution.
      </div>

      {visiblePrompts.map((prompt) => {
        const color = getPromptColor(prompt.promptIndex);
        const isExpanded = expandedPrompts.has(prompt.promptIndex);
        const visibleFiles = prompt.filesChanged.filter((f) => trackableSet.has(f));

        return (
          <div
            key={prompt.promptIndex}
            className={`border-b border-gray-800/40 ${isExpanded ? `${color.bg}` : ''}`}
          >
            {/* Prompt header — clickable to expand */}
            <button
              onClick={() => togglePrompt(prompt.promptIndex)}
              className="w-full text-left px-4 py-3 hover:bg-gray-800/30 transition-colors flex items-start gap-3"
            >
              <span className={`${color.dot} w-2 h-2 rounded-full mt-1.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`${color.text} text-xs font-semibold`}>
                    Prompt #{prompt.promptIndex + 1}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {visibleFiles.length} file{visibleFiles.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <p
                  className={`text-[12px] text-gray-300 mt-1 leading-relaxed ${
                    isExpanded ? '' : 'line-clamp-2'
                  }`}
                >
                  {prompt.promptText}
                </p>
              </div>
              <span className="text-gray-600 text-xs mt-1">
                {isExpanded ? '▾' : '▸'}
              </span>
            </button>

            {/* Files — visible when expanded */}
            {isExpanded && (
              <div className="pb-3 px-4 ml-5 border-l border-gray-800/50">
                {visibleFiles.length === 0 ? (
                  <p className="text-[11px] text-gray-600 italic py-2 pl-3">
                    Only build artifacts (hidden).
                  </p>
                ) : (
                  visibleFiles.map((file) => (
                    <button
                      key={file}
                      onClick={() => onJumpToFile(file)}
                      className="w-full text-left flex items-center gap-2 py-1.5 px-3 rounded hover:bg-gray-800/50 transition-colors group"
                    >
                      <span className="text-[12px] text-gray-300 group-hover:text-indigo-400 font-mono">
                        {getFileName(file)}
                      </span>
                      <span className="text-[10px] text-gray-600 truncate">
                        {shortenPath(file)}
                      </span>
                      <span className="ml-auto text-[10px] text-gray-700 group-hover:text-gray-500">
                        view blame →
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// By-File View — secondary tab.  When you already know which file you care
// about, this is the line-by-line blame for it (the original AI Blame UX,
// just with the file list always visible instead of hidden behind a search).
// ---------------------------------------------------------------------------

function ByFileView({
  sessionId,
  trackableFiles,
  initialFile,
  onConsumed,
  onAskAboutLine,
  focusPromptIndex,
}: {
  sessionId: string;
  trackableFiles: string[];
  initialFile: string | null;
  onConsumed: () => void;
  onAskAboutLine?: (file: string, lineNumber: number, content: string) => void;
  focusPromptIndex?: number | null;
}) {
  const [selectedFile, setSelectedFile] = useState<string>(
    initialFile || trackableFiles[0] || '',
  );
  const [blameData, setBlameData] = useState<BlameResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hoveredPrompt, setHoveredPrompt] = useState<number | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<number | null>(null);

  const promptRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Honor a one-shot file selection passed from the prompt view, then clear it.
  // onConsumed is intentionally excluded from deps — it would re-fire this effect
  // every time the parent re-renders.
  useEffect(() => {
    if (initialFile) {
      setSelectedFile(initialFile);
      onConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  useEffect(() => {
    if (!selectedFile || !sessionId) return;
    setLoading(true);
    setError('');
    api
      .getSessionBlame(sessionId, selectedFile)
      .then(setBlameData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, selectedFile]);

  // Deep-link: when focusPromptIndex is set (from CommitDetail "Open AI blame →"),
  // expand that prompt's card and switch to a file the prompt actually touched
  // (so its highlighted lines are visible, not the default "first in list").
  // Re-runs after blame loads so we can scroll the now-rendered card into view.
  useEffect(() => {
    if (focusPromptIndex == null) return;
    setExpandedPrompt(focusPromptIndex);
  }, [focusPromptIndex]);

  useEffect(() => {
    if (focusPromptIndex == null || !blameData) return;
    const target = blameData.prompts.find((p) => p.promptIndex === focusPromptIndex);
    if (target && target.filesChanged.length > 0) {
      const first = target.filesChanged.find((f) => trackableFiles.includes(f));
      if (first && first !== selectedFile) {
        setSelectedFile(first);
        return; // let the effect re-run after blame reloads for the new file
      }
    }
    const el = promptRefs.current.get(focusPromptIndex);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPromptIndex, blameData]);

  const activePrompts = useMemo(() => {
    if (!blameData) return [];
    const promptIndices = new Set(
      blameData.lines
        .filter((l) => l.attribution)
        .map((l) => l.attribution!.promptIndex),
    );
    return blameData.prompts.filter((p) => promptIndices.has(p.promptIndex));
  }, [blameData]);

  const linesPerPrompt = useMemo(() => {
    if (!blameData) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const line of blameData.lines) {
      if (line.attribution) {
        counts.set(
          line.attribution.promptIndex,
          (counts.get(line.attribution.promptIndex) || 0) + 1,
        );
      }
    }
    return counts;
  }, [blameData]);

  const lineCounts = useMemo(() => {
    if (!blameData) return { human: 0, ai: 0, total: 0 };
    let human = 0;
    let ai = 0;
    for (const line of blameData.lines) {
      if (line.isGap) continue;
      if (line.attribution) ai++;
      else human++;
    }
    return { human, ai, total: human + ai };
  }, [blameData]);

  const aiPercentByFile = (file: string): number | null => {
    // Cheap signal — just file === selectedFile gets a real number; others null.
    // Computing real per-file AI% requires fetching every file's blame, which
    // is expensive for large sessions. Skip for the v1.
    if (file !== selectedFile || !blameData) return null;
    if (lineCounts.total === 0) return 0;
    return Math.round((lineCounts.ai / lineCounts.total) * 100);
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left sidebar — file list, always visible */}
      <div className="w-64 border-r border-gray-800 overflow-y-auto flex-shrink-0 bg-gray-950/30">
        <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800">
          Files in session ({trackableFiles.length})
        </div>
        {trackableFiles.map((file) => {
          const isSelected = file === selectedFile;
          const aiPct = aiPercentByFile(file);
          return (
            <button
              key={file}
              onClick={() => setSelectedFile(file)}
              className={`w-full text-left px-3 py-2 border-b border-gray-800/30 transition-colors ${
                isSelected
                  ? 'bg-gray-800/60 text-gray-100'
                  : 'text-gray-400 hover:bg-gray-800/30 hover:text-gray-200'
              }`}
            >
              <div className="text-[12px] font-mono truncate" title={file}>
                {getFileName(file)}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-600 truncate flex-1">
                  {shortenPath(file)}
                </span>
                {aiPct !== null && (
                  <span className="text-[10px] text-indigo-400 shrink-0">
                    {aiPct}% AI
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Right pane — blame view */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Stats bar */}
        {blameData && (
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-3 text-xs text-gray-500 flex-shrink-0">
            <span className="text-gray-300 font-mono truncate">{selectedFile}</span>
            <span className="ml-auto flex items-center gap-3 shrink-0">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-indigo-400 inline-block" />
                {lineCounts.ai} AI
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-gray-600 inline-block" />
                {lineCounts.human} human
              </span>
              <span className="text-gray-600">
                {activePrompts.length} prompt{activePrompts.length !== 1 ? 's' : ''}
              </span>
            </span>
          </div>
        )}

        {/* Prompt legend */}
        {activePrompts.length > 0 && (
          <div className="border-b border-gray-800 flex-shrink-0 max-h-[30vh] overflow-y-auto">
            {activePrompts.map((p) => {
              const color = getPromptColor(p.promptIndex);
              const lineCount = linesPerPrompt.get(p.promptIndex) || 0;
              const isHovered = hoveredPrompt === p.promptIndex;
              const isExpanded = expandedPrompt === p.promptIndex;
              const promptPreview = p.promptText.length > 120 ? p.promptText.slice(0, 120) + '...' : p.promptText;

              return (
                <div
                  key={p.promptIndex}
                  ref={(el) => { if (el) promptRefs.current.set(p.promptIndex, el); }}
                  className={`px-4 py-2 border-b border-gray-800/40 last:border-b-0 transition-all cursor-pointer ${
                    isHovered ? `${color.bg}` : 'hover:bg-gray-800/30'
                  }`}
                  onMouseEnter={() => setHoveredPrompt(p.promptIndex)}
                  onMouseLeave={() => setHoveredPrompt(null)}
                  onClick={() =>
                    setExpandedPrompt(isExpanded ? null : p.promptIndex)
                  }
                >
                  <div className="flex items-start gap-2.5">
                    <span className={`${color.dot} w-2 h-2 rounded-full mt-1.5 shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`${color.text} text-xs font-semibold`}>
                          Prompt #{p.promptIndex + 1}
                        </span>
                        <span className="text-[10px] text-gray-600">
                          {lineCount} line{lineCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <p className="text-[12px] text-gray-300 mt-0.5 leading-relaxed">
                        {isExpanded ? p.promptText : promptPreview}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Blame body */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
            </div>
          )}

          {error && (
            <div className="p-5 text-center py-12">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {!loading && !error && blameData && blameData.lines.length === 0 && (
            <div className="p-5 text-center py-12">
              <p className="text-gray-500 text-sm">
                No AI-attributed lines in this file.
              </p>
              <p className="text-gray-600 text-xs mt-1">
                Other files in this session may still have AI activity — pick one from the left.
              </p>
            </div>
          )}

          {!loading && !error && blameData && blameData.lines.length > 0 && (
            <div className="font-mono text-xs">
              {blameData.lines.map((line, idx) => {
                if (line.isGap) {
                  return (
                    <div
                      key={`gap-${idx}`}
                      className="flex items-center border-l-2 border-l-transparent bg-gray-900/50 text-gray-600"
                    >
                      <span className="w-12 px-2 py-1 shrink-0 border-r border-gray-800/50 text-center">⋯</span>
                      <span className="w-20 px-2 py-1 shrink-0 text-right text-[10px]" />
                      <span className="flex-1 px-3 py-1 text-[10px] italic">{line.content}</span>
                    </div>
                  );
                }

                const attr = line.attribution;
                const color = attr ? getPromptColor(attr.promptIndex) : null;
                const isHighlighted =
                  hoveredPrompt !== null && attr?.promptIndex === hoveredPrompt;
                const isHumanLine = !attr;

                return (
                  <div
                    key={`${line.lineNumber}-${idx}`}
                    className={`flex items-stretch border-l-2 ${
                      color ? color.border : 'border-l-gray-800/30'
                    } ${
                      isHighlighted
                        ? 'bg-gray-800/80'
                        : isHumanLine
                          ? 'bg-transparent'
                          : 'hover:bg-gray-800/30'
                    } transition-colors group ${attr ? 'cursor-pointer' : ''}`}
                    onMouseEnter={() => attr && setHoveredPrompt(attr.promptIndex)}
                    onMouseLeave={() => setHoveredPrompt(null)}
                    onClick={() => {
                      if (attr) {
                        setExpandedPrompt(expandedPrompt === attr.promptIndex ? null : attr.promptIndex);
                        const el = promptRefs.current.get(attr.promptIndex);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      }
                    }}
                  >
                    <span
                      className={`w-12 text-right px-2 py-0.5 select-none shrink-0 border-r border-gray-800/50 ${
                        isHumanLine ? 'text-gray-700' : 'text-gray-600'
                      }`}
                    >
                      {line.lineNumber}
                    </span>

                    <button
                      className={`w-20 text-right px-2 py-0.5 shrink-0 truncate ${
                        attr
                          ? `${color!.text} ${color!.bg} hover:brightness-125 cursor-pointer`
                          : 'text-gray-700 cursor-default'
                      }`}
                      title={
                        attr
                          ? `Prompt #${attr.promptIndex + 1}: ${attr.promptText}`
                          : 'Human-written / unchanged'
                      }
                      onClick={(e) => {
                        if (attr) {
                          e.stopPropagation();
                          setExpandedPrompt(
                            expandedPrompt === attr.promptIndex ? null : attr.promptIndex,
                          );
                        }
                      }}
                    >
                      {attr ? `P${attr.promptIndex + 1}` : ''}
                    </button>

                    <pre
                      className={`flex-1 px-3 py-0.5 whitespace-pre overflow-x-auto ${
                        isHumanLine ? 'text-gray-500' : 'text-gray-300'
                      }`}
                    >
                      {line.content}
                    </pre>

                    {onAskAboutLine && attr && (
                      <button
                        className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-indigo-400 px-2 py-0.5 text-[10px] transition-opacity shrink-0"
                        onClick={() =>
                          onAskAboutLine(blameData.file, line.lineNumber, line.content)
                        }
                        title="Ask about this line"
                      >
                        Ask
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TODO(consolidation): the BUILD_ARTIFACT_PATTERNS regex array above mirrors
// packages/cli/src/ignore-patterns.ts but is duplicated here because the CLI
// package isn't reachable from the web app. When the shared types/utils
// package lands, move both to a shared module.
// ---------------------------------------------------------------------------
