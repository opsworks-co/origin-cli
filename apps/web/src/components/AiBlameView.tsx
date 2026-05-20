import { useState, useEffect, useMemo, useRef } from 'react';
import * as api from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlameAttributionLite {
  promptIndex: number;
  promptText: string;
  type: 'added' | 'modified';
  // PRIMARY attribution always names a session. When `isCurrentSession` is
  // true, the promptIndex refers to this session's own prompt list. When
  // false, the line was first written in another session — render the
  // agent/session label instead of looking the promptIndex up in `prompts[]`.
  sessionId?: string;
  isCurrentSession?: boolean;
  sessionAiTitle?: string;
  sessionModel?: string;
  agentName?: string;
  authorName?: string;
  authorEmail?: string;
}

interface BlameLine {
  lineNumber: number;
  content: string;
  attribution: (BlameAttributionLite & {
    // Secondary annotation: the prior agent who first wrote this line
    // content, when the current session merely modified or re-added it.
    originalAuthor?: BlameAttributionLite;
  }) | null;
  isGap?: boolean;
  // True when the attributing prompt's uncommittedDiff still covers this
  // file — the change hasn't been committed to the repo yet.
  isUncommitted?: boolean;
}

interface BlamePrompt {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
}

interface CrossSessionPrompt extends BlamePrompt {
  sessionId: string;
  sessionAiTitle?: string;
  sessionModel?: string;
  agentName?: string;
  createdAt: string;
}

interface BlameResult {
  file: string;
  sessionId: string;
  model: string;
  totalAttributedLines: number;
  lines: BlameLine[];
  prompts: BlamePrompt[];
  crossSessionPrompts?: CrossSessionPrompt[];
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

// Exported for direct unit testing — the regex array is the entire surface
// that decides whether a file disappears from AI Blame, so it must be tested
// in isolation. See src/components/__tests__/AiBlameView.test.ts.
export function isBuildArtifact(file: string): boolean {
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

  // Always show every prompt. Previously prompts whose filesChanged were
  // ALL build artifacts got filtered out, which silently hid Codex prompts
  // when the per-prompt attribution was incomplete (Codex doesn't fire
  // user-prompt-submit hooks, so post-commit guesses files and can stamp
  // a prompt with only an artifact like package-lock.json). Mark those
  // prompts visually but keep them in the list so the user can verify.
  const visiblePrompts = prompts;
  const artifactOnlyCount = prompts.filter(
    (p) => p.filesChanged.length > 0 && !p.filesChanged.some((f) => trackableSet.has(f)),
  ).length;

  if (visiblePrompts.length === 0) {
    return (
      <div className="p-5 text-center py-12">
        <p className="text-gray-500 text-sm">No prompts found in this session.</p>
      </div>
    );
  }

  const hiddenByArtifactFilter = artifactOnlyCount;

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-3 text-[11px] text-gray-500 border-b border-gray-800/50">
        {hiddenByArtifactFilter > 0 ? (
          <>
            {visiblePrompts.length} of {prompts.length} prompt{prompts.length !== 1 ? 's' : ''} produced source code
            <span className="text-gray-600">
              {' '}— {hiddenByArtifactFilter} only modified build artifacts (hidden).
            </span>
          </>
        ) : (
          <>
            {visiblePrompts.length} prompt{visiblePrompts.length !== 1 ? 's' : ''} produced source code.
          </>
        )}{' '}
        Click a file to see line-level attribution.
      </div>

      {visiblePrompts.map((prompt) => {
        const color = getPromptColor(prompt.promptIndex);
        const isExpanded = expandedPrompts.has(prompt.promptIndex);
        const visibleFiles = prompt.filesChanged.filter((f) => trackableSet.has(f));
        const artifactFiles = prompt.filesChanged.filter((f) => !trackableSet.has(f));
        const isArtifactOnly = visibleFiles.length === 0 && artifactFiles.length > 0;

        return (
          <div
            key={prompt.promptIndex}
            className={`border-b border-gray-800/40 ${isExpanded ? `${color.bg}` : ''} ${isArtifactOnly ? 'opacity-60' : ''}`}
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
                    {artifactFiles.length > 0 && (
                      <> · <span className="text-amber-500/70">{artifactFiles.length} artifact{artifactFiles.length !== 1 ? 's' : ''}</span></>
                    )}
                  </span>
                  {isArtifactOnly && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      build artifacts only
                    </span>
                  )}
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
                {visibleFiles.map((file) => (
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
                ))}
                {/* Artifact files: show greyed out so the user can see what
                    the prompt actually touched. Click is a no-op since
                    the line-level blame view doesn't render artifacts. */}
                {artifactFiles.map((file) => (
                  <div
                    key={file}
                    className="w-full text-left flex items-center gap-2 py-1.5 px-3 rounded text-gray-500 italic"
                    title="Build artifact — not line-blame-able"
                  >
                    <span className="text-[12px] font-mono">{getFileName(file)}</span>
                    <span className="text-[10px] text-gray-700 truncate">{shortenPath(file)}</span>
                    <span className="ml-auto text-[10px] text-amber-500/60">artifact</span>
                  </div>
                ))}
                {visibleFiles.length === 0 && artifactFiles.length === 0 && (
                  <p className="text-[11px] text-gray-600 italic py-2 pl-3">
                    No files attributed to this prompt.
                  </p>
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
  // Legend state is keyed by this session's numeric promptIndex. Cross-session
  // prompts never enter the legend, so there is no need for a composite key.
  const [hoveredPrompt, setHoveredPrompt] = useState<number | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<number | null>(null);
  // Tracks which unattributed (context / human) runs the user has expanded.
  // Keyed by the run's starting index in blameData.lines — stable per file.
  // Cleared when the selected file changes so each file opens collapsed.
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  useEffect(() => {
    setExpandedRuns(new Set());
  }, [selectedFile]);

  const promptRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Per-line refs keyed by `${lineNumber}-${idx}` so we can scroll a
  // prompt's first attributed line into view when the user clicks the
  // legend. Cleared on file change so refs don't leak across files.
  const lineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    lineRefs.current.clear();
  }, [selectedFile]);

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

  // Legend = THIS session's prompts only. Cross-session attribution surfaces
  // per-line via `originalAuthor` and never enters the legend — otherwise a
  // Gemini-session view would show Codex prompts in its prompt list (the bug
  // the user hit before this refactor).
  const activePrompts = useMemo(() => {
    if (!blameData) return [] as BlamePrompt[];
    const activeIndices = new Set<number>();
    for (const l of blameData.lines) {
      if (l.attribution?.isCurrentSession !== false) {
        // null sessionId or explicit isCurrentSession === true → this session.
        // Treat undefined (legacy) as current too so backward-compat works.
        if (l.attribution) activeIndices.add(l.attribution.promptIndex);
      }
    }
    return blameData.prompts.filter((p) => activeIndices.has(p.promptIndex));
  }, [blameData]);

  const linesPerPrompt = useMemo(() => {
    if (!blameData) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const line of blameData.lines) {
      const attr = line.attribution;
      if (attr && attr.isCurrentSession !== false) {
        counts.set(attr.promptIndex, (counts.get(attr.promptIndex) || 0) + 1);
      }
    }
    return counts;
  }, [blameData]);

  // Pull agent + author from the first line attributed to each prompt. The
  // session has one agent + one user, so any line's attribution carries the
  // same metadata as the prompt — read it once and surface in the legend
  // instead of repeating it on every per-line row.
  const promptAuthor = useMemo(() => {
    if (!blameData) return new Map<number, { agentName?: string; authorName?: string; authorEmail?: string }>();
    const m = new Map<number, { agentName?: string; authorName?: string; authorEmail?: string }>();
    for (const line of blameData.lines) {
      const attr = line.attribution;
      if (attr && attr.isCurrentSession !== false && !m.has(attr.promptIndex)) {
        m.set(attr.promptIndex, {
          agentName: attr.agentName,
          authorName: attr.authorName,
          authorEmail: attr.authorEmail,
        });
      }
    }
    return m;
  }, [blameData]);

  const lineCounts = useMemo(() => {
    if (!blameData) return { human: 0, ai: 0, total: 0 };
    let human = 0;
    let ai = 0;
    for (const line of blameData.lines) {
      if (line.isGap) continue;
      // Empty / whitespace-only lines aren't authorship — they're structural
      // padding. Counting them as "human" inflates the human side whenever
      // a prompt added a `key:` line followed by a blank line, dropping the
      // file's AI% below 100% for files that ARE 100% AI.
      if (line.content.trim().length === 0) continue;
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
              {(() => {
                const u = blameData.lines.filter((l) => (l as any).isUncommitted).length;
                return u > 0 ? (
                  <span className="flex items-center gap-1" title="Lines added by a prompt whose change is still in the working tree (not yet committed)">
                    <span className="w-2 h-2 rounded-full bg-violet-400 inline-block" />
                    {u} uncommitted
                  </span>
                ) : null;
              })()}
              <span className="text-gray-600">
                {activePrompts.length} prompt{activePrompts.length !== 1 ? 's' : ''}
              </span>
            </span>
          </div>
        )}

        {/* Prompt legend — this session's prompts only. */}
        {activePrompts.length > 0 && (
          <div className="border-b border-gray-800 flex-shrink-0 max-h-[30vh] overflow-y-auto">
            {activePrompts.map((p) => {
              const color = getPromptColor(p.promptIndex);
              const lineCount = linesPerPrompt.get(p.promptIndex) || 0;
              const isHovered = hoveredPrompt === p.promptIndex;
              // Click toggles a "pinned" prompt that keeps its lines
              // highlighted even after the cursor moves away. Same visual
              // state as hover, but persistent until clicked again.
              const isPinned = expandedPrompt === p.promptIndex;
              const promptPreview = p.promptText.length > 120 ? p.promptText.slice(0, 120) + '...' : p.promptText;
              const author = promptAuthor.get(p.promptIndex);
              const authorLabel = author?.authorName || author?.authorEmail;

              return (
                <div
                  key={p.promptIndex}
                  ref={(el) => { if (el) promptRefs.current.set(p.promptIndex, el); }}
                  className={`px-4 py-2 border-b border-gray-800/40 last:border-b-0 transition-all cursor-pointer ${
                    isPinned || isHovered ? `${color.bg}` : 'hover:bg-gray-800/30'
                  }`}
                  onMouseEnter={() => setHoveredPrompt(p.promptIndex)}
                  onMouseLeave={() => setHoveredPrompt(null)}
                  onClick={() => {
                    const nextPinned = isPinned ? null : p.promptIndex;
                    setExpandedPrompt(nextPinned);
                    // Scroll the file body to the first line attributed to
                    // this prompt. Without this, large files made it
                    // tedious to find which lines a prompt actually touched —
                    // the legend lights up rows in place but the user had
                    // to manually hunt for them.
                    if (nextPinned !== null && blameData) {
                      const firstAttributedIdx = blameData.lines.findIndex(
                        (l) =>
                          !l.isGap &&
                          l.attribution &&
                          l.attribution.isCurrentSession !== false &&
                          l.attribution.promptIndex === nextPinned,
                      );
                      if (firstAttributedIdx >= 0) {
                        // Open any collapsed run that contains the target,
                        // otherwise the row exists in the DOM only when its
                        // hidden parent run is expanded.
                        setExpandedRuns((prev) => {
                          const next = new Set(prev);
                          next.add(firstAttributedIdx);
                          return next;
                        });
                        const target = blameData.lines[firstAttributedIdx];
                        // Defer the scroll one tick so the newly-expanded
                        // run has rendered and the ref is attached.
                        setTimeout(() => {
                          const key = `${target.lineNumber}-${firstAttributedIdx}`;
                          const el = lineRefs.current.get(key);
                          if (el) {
                            el.scrollIntoView({
                              behavior: 'smooth',
                              block: 'center',
                            });
                          }
                        }, 0);
                      }
                    }
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <span className={`${color.dot} w-2 h-2 rounded-full mt-1.5 shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`${color.text} text-xs font-semibold`}>
                          Prompt #{p.promptIndex + 1}
                        </span>
                        {author?.agentName && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                            {author.agentName}
                          </span>
                        )}
                        {authorLabel && (
                          <span
                            className="text-[10px] text-gray-500"
                            title={author?.authorEmail || ''}
                          >
                            {authorLabel}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-600">
                          {lineCount} line{lineCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <p className="text-[12px] text-gray-300 mt-0.5 leading-relaxed">
                        {isPinned ? p.promptText : promptPreview}
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
              {(() => {
                const data = blameData!;
                // GitHub-style condensed view: each attributed cluster gets a
                // few lines of unattributed context above and below so the AI
                // change reads in situ. Larger gaps between clusters collapse
                // to a slim "expand" marker (a couple of arrows + line count),
                // not the full-width banner the previous design used.
                const CONTEXT_LINES = 3;
                const dataLines = data.lines;
                // Pass 1: mark which non-gap indices are attributed.
                const attrIdxSet = new Set<number>();
                dataLines.forEach((l, i) => {
                  if (!l.isGap && l.attribution) attrIdxSet.add(i);
                });
                // Pass 2: expand the attributed set with N lines of context on
                // each side. Indices inside the expanded set are "kept visible
                // by default"; gaps between expanded ranges become collapsible.
                const visibleByDefault = new Set<number>();
                for (const i of attrIdxSet) {
                  for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(dataLines.length - 1, i + CONTEXT_LINES); j++) {
                    if (!dataLines[j]?.isGap) visibleByDefault.add(j);
                  }
                }
                // Pass 3: walk lines and assemble render units. A "hidden run"
                // is a stretch of non-attributed, non-context lines (and
                // non-gap) — those collapse. Diff isGap rows render as-is.
                type Unit =
                  | { kind: 'line'; line: typeof data.lines[number]; idx: number }
                  | { kind: 'hidden'; startIdx: number; endIdx: number; lines: typeof data.lines }
                  | { kind: 'gap'; line: typeof data.lines[number]; idx: number };
                const units: Unit[] = [];
                let hiddenBuf: typeof data.lines = [];
                let hiddenStart = -1;
                const flushHidden = (endIdx: number) => {
                  if (hiddenBuf.length === 0) return;
                  units.push({ kind: 'hidden', startIdx: hiddenStart, endIdx, lines: hiddenBuf });
                  hiddenBuf = [];
                  hiddenStart = -1;
                };
                dataLines.forEach((line, idx) => {
                  if (line.isGap) {
                    if (hiddenBuf.length > 0) flushHidden(idx - 1);
                    units.push({ kind: 'gap', line, idx });
                    return;
                  }
                  if (visibleByDefault.has(idx) || expandedRuns.has(idx)) {
                    if (hiddenBuf.length > 0) flushHidden(idx - 1);
                    units.push({ kind: 'line', line, idx });
                  } else {
                    if (hiddenBuf.length === 0) hiddenStart = idx;
                    hiddenBuf.push(line);
                  }
                });
                if (hiddenBuf.length > 0) flushHidden(dataLines.length - 1);

                // For each hidden run, render a thin centered "expand" strip.
                // For each line unit, render the existing line. The expand
                // marker just resolves to "show all lines in this hidden
                // range" by adding them to expandedRuns (keyed by run start).
                return units.flatMap((u) => {
                  if (u.kind === 'gap') {
                    const line = u.line;
                    return [(
                      <div
                        key={`gap-${u.idx}`}
                        className="flex items-center border-l-2 border-l-transparent bg-gray-900/40 text-gray-600"
                      >
                        <span className="w-12 px-2 py-1 shrink-0 border-r border-gray-800/50 text-center">⋯</span>
                        <span className="w-20 px-2 py-1 shrink-0 text-right text-[10px]" />
                        <span className="flex-1 px-3 py-1 text-[10px] italic">{line.content}</span>
                      </div>
                    )];
                  }
                  if (u.kind === 'line') return [renderBlameLine(u.line, u.idx)];
                  // Hidden run — render a slim expand strip.
                  const N = u.lines.length;
                  const firstLn = u.lines[0]?.lineNumber;
                  const lastLn = u.lines[N - 1]?.lineNumber;
                  const range = firstLn === lastLn ? `${firstLn}` : `${firstLn}–${lastLn}`;
                  return [(
                    <button
                      key={`hidden-${u.startIdx}`}
                      className="w-full flex items-center text-gray-600 hover:text-indigo-300 transition-colors group py-0.5"
                      onClick={() => {
                        setExpandedRuns((prev) => {
                          const next = new Set(prev);
                          for (let k = u.startIdx; k <= u.endIdx; k++) next.add(k);
                          return next;
                        });
                      }}
                      title={`Expand ${N} line${N === 1 ? '' : 's'} (${range})`}
                    >
                      <span className="w-12 shrink-0 text-center text-gray-700 group-hover:text-indigo-400 select-none text-[11px]">↕</span>
                      <span className="w-20 shrink-0" />
                      <span className="flex-1 flex items-center gap-2 text-[10px]">
                        <span className="flex-1 border-t border-dashed border-gray-800/80 group-hover:border-indigo-500/40" />
                        <span className="text-gray-600 group-hover:text-indigo-300 italic">
                          {N} line{N === 1 ? '' : 's'}
                        </span>
                        <span className="flex-1 border-t border-dashed border-gray-800/80 group-hover:border-indigo-500/40" />
                      </span>
                    </button>
                  )];
                });

                function renderBlameLine(line: typeof data.lines[number], idx: number) {
                  const attr = line.attribution;
                const primaryIsCurrentSession =
                  attr && (attr.isCurrentSession ?? true);
                const color = primaryIsCurrentSession
                  ? getPromptColor(attr!.promptIndex)
                  : null;
                // Highlight matches the legend: lines belonging to the
                // hovered prompt OR the pinned (clicked) prompt light up.
                const focusPromptIdx = hoveredPrompt ?? expandedPrompt;
                const isHighlighted =
                  primaryIsCurrentSession &&
                  focusPromptIdx !== null &&
                  attr!.promptIndex === focusPromptIdx;
                const isHumanLine = !attr;
                const isUncommittedLine = !!(line as any).isUncommitted;

                const refKey = `${line.lineNumber}-${idx}`;
                return (
                  <div
                    key={refKey}
                    ref={(el) => {
                      if (el) lineRefs.current.set(refKey, el);
                      else lineRefs.current.delete(refKey);
                    }}
                    className={`flex items-stretch border-l-2 ${
                      isUncommittedLine
                        ? 'border-l-violet-500/70'
                        : color
                          ? color.border
                          : 'border-l-gray-800/30'
                    } ${
                      isHighlighted
                        ? 'bg-gray-800/80'
                        : isUncommittedLine
                          ? 'bg-violet-950/15 hover:bg-violet-950/30'
                          : isHumanLine
                            ? 'bg-transparent'
                            : 'hover:bg-gray-800/30'
                    } transition-colors group ${attr ? 'cursor-pointer' : ''}`}
                    onMouseEnter={() =>
                      primaryIsCurrentSession && setHoveredPrompt(attr!.promptIndex)
                    }
                    onMouseLeave={() => setHoveredPrompt(null)}
                    onClick={() => {
                      if (primaryIsCurrentSession) {
                        setExpandedPrompt(
                          expandedPrompt === attr!.promptIndex ? null : attr!.promptIndex,
                        );
                        const el = promptRefs.current.get(attr!.promptIndex);
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
                      className={`w-12 text-right px-2 py-0.5 shrink-0 truncate ${
                        primaryIsCurrentSession
                          ? `${color!.text} ${color!.bg} hover:brightness-125 cursor-pointer`
                          : attr
                            ? 'text-amber-300/70 cursor-default'
                            : 'text-gray-700 cursor-default'
                      }`}
                      title={
                        attr
                          ? primaryIsCurrentSession
                            ? `Prompt #${attr.promptIndex + 1}${isUncommittedLine ? ' (uncommitted)' : ''}: ${attr.promptText}`
                            : `From prior session (${attr.agentName || attr.sessionModel || 'agent'}${attr.authorName ? ' · ' + attr.authorName : ''}): ${attr.promptText}`
                          : 'Human-written / unchanged'
                      }
                      onClick={(e) => {
                        if (primaryIsCurrentSession) {
                          e.stopPropagation();
                          setExpandedPrompt(
                            expandedPrompt === attr!.promptIndex ? null : attr!.promptIndex,
                          );
                        }
                      }}
                    >
                      {attr
                        ? primaryIsCurrentSession
                          ? `P${attr.promptIndex + 1}`
                          : '·'
                        : ''}
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
                          onAskAboutLine(data.file, line.lineNumber, line.content)
                        }
                        title="Ask about this line"
                      >
                        Ask
                      </button>
                    )}
                  </div>
                );
                }
              })()}
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
