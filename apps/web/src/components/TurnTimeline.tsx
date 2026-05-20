import { useEffect, useRef, useState } from 'react';
import type { SessionAnnotation } from '../api';

const PROMPT_COLORS = [
  { dot: 'bg-blue-400', text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  { dot: 'bg-green-400', text: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30' },
  { dot: 'bg-purple-400', text: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30' },
  { dot: 'bg-amber-400', text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
  { dot: 'bg-pink-400', text: 'text-pink-400', bg: 'bg-pink-500/10', border: 'border-pink-500/30' },
  { dot: 'bg-cyan-400', text: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/30' },
  { dot: 'bg-orange-400', text: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  { dot: 'bg-teal-400', text: 'text-teal-400', bg: 'bg-teal-500/10', border: 'border-teal-500/30' },
  { dot: 'bg-rose-400', text: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30' },
  { dot: 'bg-indigo-400', text: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/30' },
];

const CHECKPOINT_TYPE_BADGES: Record<string, { label: string; color: string }> = {
  'auto': { label: 'AI Turn', color: 'bg-blue-500/20 text-blue-400' },
  'manual': { label: 'Manual', color: 'bg-gray-500/20 text-gray-400' },
  'pre-prompt': { label: 'Pre-prompt', color: 'bg-amber-500/20 text-amber-400' },
  'session-start': { label: 'Session Start', color: 'bg-green-500/20 text-green-400' },
  'session-end': { label: 'Session End', color: 'bg-red-500/20 text-red-400' },
};

interface PromptChange {
  promptIndex: number;
  promptText: string;
  filesChanged: string[] | string;
  diff: string;
  linesAdded?: number;
  linesRemoved?: number;
  aiPercentage?: number;
  checkpointType?: string | null;
  commitSha?: string | null;
  treeSha?: string | null;
  createdAt?: string;
}

interface TurnTimelineProps {
  promptChanges: PromptChange[];
  model: string;
  annotations?: SessionAnnotation[];
  canAnnotate?: boolean;
  onAddAnnotation?: (turnIndex: number, text: string) => Promise<void>;
  onDeleteAnnotation?: (annotationId: string) => Promise<void>;
  currentUserId?: string;
  /**
   * When set, the timeline auto-expands the matching turn and scrolls it into
   * view. Used for the commit-detail "View snapshot →" deep-link.
   */
  focusPromptIndex?: number | null;
}

export default function TurnTimeline({
  promptChanges,
  model,
  annotations = [],
  canAnnotate = false,
  onAddAnnotation,
  onDeleteAnnotation,
  currentUserId,
  focusPromptIndex = null,
}: TurnTimelineProps) {
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);
  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (focusPromptIndex == null) return;
    setExpandedTurn(focusPromptIndex);
    // Give the expand render a tick, then scroll to the card.
    const t = setTimeout(() => {
      const el = turnRefs.current.get(focusPromptIndex);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return () => clearTimeout(t);
  }, [focusPromptIndex]);
  const [addingToTurn, setAddingToTurn] = useState<number | null>(null);
  const [draftText, setDraftText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ sha: string; turn: number } | null>(null);
  const [restoreCopied, setRestoreCopied] = useState(false);

  const handleSubmitAnnotation = async (turnIndex: number) => {
    if (!draftText.trim() || !onAddAnnotation) return;
    setSubmitting(true);
    try {
      await onAddAnnotation(turnIndex, draftText.trim());
      setDraftText('');
      setAddingToTurn(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (!promptChanges || promptChanges.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500 text-sm">
        No prompt/turn data available for this session.
      </div>
    );
  }

  // Snapshot timeline only shows turns that actually changed code.
  // A chat-only turn (agent responded with text but didn't edit files)
  // already gets blanked by the session-detail mapper's dedup pre-pass:
  // its filesChanged is empty and both diff and uncommittedDiff are ''.
  // Rendering those rows produces noise like "Turn 3 · 0 files +10 -2"
  // where the line counts are stale leftovers from the original capture.
  const hasRealChange = (pc: PromptChange): boolean => {
    let files: string[] = [];
    try {
      files = Array.isArray(pc.filesChanged) ? pc.filesChanged : JSON.parse(pc.filesChanged || '[]');
    } catch { /* malformed — treat as no files */ }
    if (files.length > 0) return true;
    if ((pc.diff || '').trim().length > 0) return true;
    return false;
  };
  const sorted = [...promptChanges]
    .filter(hasRealChange)
    .sort((a, b) => a.promptIndex - b.promptIndex);

  // Compute cumulative stats
  let cumulativeAdded = 0;
  let cumulativeRemoved = 0;
  let totalAiLines = 0;
  let totalLines = 0;
  for (const pc of sorted) {
    const added = pc.linesAdded ?? (pc.diff || '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = pc.linesRemoved ?? (pc.diff || '').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    totalLines += added + removed;
    totalAiLines += (added + removed) * ((pc.aiPercentage ?? 100) / 100);
  }
  const overallAiPct = totalLines > 0 ? Math.round((totalAiLines / totalLines) * 100) : 100;

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-300">Snapshot Timeline</h3>
        <span className="text-xs text-gray-600">
          {sorted.length} turn{sorted.length !== 1 ? 's' : ''} · {model}
        </span>
        {/* Overall AI attribution badge */}
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
          overallAiPct >= 90 ? 'bg-blue-500/20 text-blue-400' :
          overallAiPct >= 50 ? 'bg-purple-500/20 text-purple-400' :
          'bg-green-500/20 text-green-400'
        }`}>
          {overallAiPct}% AI-generated
        </span>
      </div>

      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[11px] top-3 bottom-3 w-px bg-gray-800" />

        {sorted.map((pc, idx) => {
          const color = PROMPT_COLORS[pc.promptIndex % PROMPT_COLORS.length];
          const isExpanded = expandedTurn === pc.promptIndex;
          const isAddingNote = addingToTurn === pc.promptIndex;
          let files: string[] = [];
          try {
            files = Array.isArray(pc.filesChanged) ? pc.filesChanged : JSON.parse(pc.filesChanged || '[]');
          } catch {}

          // Use stored line counts or compute from diff
          const addedLines = pc.linesAdded ?? (pc.diff || '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
          const removedLines = pc.linesRemoved ?? (pc.diff || '').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;

          cumulativeAdded += addedLines;
          cumulativeRemoved += removedLines;

          const aiPct = pc.aiPercentage ?? 100;
          const cpType = pc.checkpointType || null;
          const cpBadge = cpType ? CHECKPOINT_TYPE_BADGES[cpType] : null;

          const turnAnnotations = annotations.filter(a => a.turnIndex === pc.promptIndex);

          return (
            <div
              key={pc.promptIndex}
              ref={(el) => {
                if (el) turnRefs.current.set(pc.promptIndex, el);
                else turnRefs.current.delete(pc.promptIndex);
              }}
              className="relative pl-8 pb-4 last:pb-0"
            >
              {/* Dot — colored by snapshot type */}
              <div className={`absolute left-1.5 top-1.5 w-[14px] h-[14px] rounded-full ${
                cpType === 'session-start' ? 'bg-green-400' :
                cpType === 'session-end' ? 'bg-red-400' :
                cpType === 'pre-prompt' ? 'bg-amber-400' :
                color.dot
              } ring-2 ring-gray-900 z-10`} />

              <div
                className={`rounded-lg border ${isExpanded ? color.border : 'border-gray-800'} ${isExpanded ? color.bg : 'hover:bg-gray-800/30'} transition-all cursor-pointer`}
                onClick={() => setExpandedTurn(isExpanded ? null : pc.promptIndex)}
              >
                <div className="px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-semibold ${color.text}`}>
                      Turn {pc.promptIndex + 1}
                    </span>

                    {/* Snapshot type badge */}
                    {cpBadge && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cpBadge.color}`}>
                        {cpBadge.label}
                      </span>
                    )}

                    {/* Lines changed */}
                    <span className="text-[10px] text-gray-600">
                      {files.length} file{files.length !== 1 ? 's' : ''}
                      {addedLines > 0 && <span className="text-green-500 ml-1">+{addedLines}</span>}
                      {removedLines > 0 && <span className="text-red-500 ml-1">-{removedLines}</span>}
                    </span>

                    {/* AI attribution percentage */}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                      aiPct >= 90 ? 'bg-blue-500/15 text-blue-400' :
                      aiPct >= 50 ? 'bg-purple-500/15 text-purple-400' :
                      aiPct > 0 ? 'bg-teal-500/15 text-teal-400' :
                      'bg-gray-500/15 text-gray-400'
                    }`}>
                      {Math.round(aiPct)}% AI
                    </span>

                    {/* Cumulative progress */}
                    <span className="text-[10px] text-gray-600 ml-auto">
                      cumul: <span className="text-green-500">+{cumulativeAdded}</span>/<span className="text-red-500">-{cumulativeRemoved}</span>
                    </span>

                    {turnAnnotations.length > 0 && (
                      <span className="text-[10px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full">
                        {turnAnnotations.length} note{turnAnnotations.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {canAnnotate && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setAddingToTurn(isAddingNote ? null : pc.promptIndex);
                          setDraftText('');
                        }}
                        className="text-[10px] text-gray-500 hover:text-indigo-400 transition-colors px-1.5 py-0.5 rounded hover:bg-indigo-500/10"
                        title="Add annotation"
                      >
                        + note
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                    {isExpanded ? pc.promptText : (pc.promptText.length > 120 ? pc.promptText.slice(0, 120) + '...' : pc.promptText)}
                  </p>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-800/50 px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {/* Header row — git refs (when captured) + Restore.
                        Restore is rendered for every expanded turn now,
                        not just the rare case where a commit/tree sha was
                        captured. When neither is present the button is
                        disabled with an explainer tooltip; otherwise the
                        modal shows the appropriate `origin rewind` cmd. */}
                    <div className="mb-2 flex items-center gap-3 flex-wrap">
                      {pc.commitSha && (
                        <span className="text-[10px] text-gray-500">
                          commit: <code className="text-gray-400 font-mono">{pc.commitSha.slice(0, 8)}</code>
                        </span>
                      )}
                      {pc.treeSha && (
                        <span className="text-[10px] text-gray-500">
                          tree: <code className="text-gray-400 font-mono">{pc.treeSha.slice(0, 8)}</code>
                        </span>
                      )}
                      {pc.createdAt && (
                        <span className="text-[10px] text-gray-500">
                          {new Date(pc.createdAt).toLocaleString()}
                        </span>
                      )}
                      {(() => {
                        const sha = (pc.commitSha || pc.treeSha) as string | undefined;
                        const enabled = !!sha;
                        return (
                          <button
                            onClick={() => {
                              if (!enabled || !sha) return;
                              setRestoreTarget({ sha, turn: pc.promptIndex + 1 });
                              setRestoreCopied(false);
                            }}
                            disabled={!enabled}
                            className={`ml-auto text-[10px] px-2 py-0.5 rounded border transition-colors ${
                              enabled
                                ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25 hover:bg-indigo-500/25'
                                : 'bg-gray-800/40 text-gray-600 border-gray-800 cursor-not-allowed'
                            }`}
                            title={enabled
                              ? 'Restore working tree to this snapshot (runs locally)'
                              : "No commit/tree ref captured for this snapshot — `origin rewind` can't target it. Take a new snapshot or use a sibling turn that has a ref."
                            }
                          >
                            Restore
                          </button>
                        );
                      })()}
                    </div>

                    {/* AI Attribution bar */}
                    <div className="mb-2">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-gray-600 uppercase tracking-wider">AI Attribution</span>
                        <span className={`text-[10px] font-medium ${
                          aiPct >= 90 ? 'text-blue-400' : aiPct >= 50 ? 'text-purple-400' : 'text-green-400'
                        }`}>{Math.round(aiPct)}% AI · {100 - Math.round(aiPct)}% Human</span>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-1.5 flex overflow-hidden">
                        <div
                          className="h-1.5 bg-blue-500/70 transition-all"
                          style={{ width: `${aiPct}%` }}
                        />
                        <div
                          className="h-1.5 bg-green-500/70 transition-all"
                          style={{ width: `${100 - aiPct}%` }}
                        />
                      </div>
                    </div>

                    {files.length > 0 && (
                      <div className="mb-2">
                        <span className="text-[10px] text-gray-600 uppercase tracking-wider">Files</span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {files.map(f => (
                            <span key={f} className="text-[10px] px-1.5 py-0.5 bg-gray-800 rounded text-gray-400">
                              {f.split('/').pop()}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {pc.diff && (
                      <div className="mt-2">
                        <span className="text-[10px] text-gray-600 uppercase tracking-wider">Diff preview</span>
                        <pre className="mt-1 text-[10px] text-gray-500 max-h-40 overflow-auto font-mono bg-gray-900/50 rounded p-2">
                          {pc.diff.slice(0, 2000)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Annotations */}
              {(turnAnnotations.length > 0 || isAddingNote) && (
                <div className="mt-1.5 space-y-1.5 pl-1">
                  {turnAnnotations.map(ann => (
                    <div key={ann.id} className="flex gap-2 rounded-md border border-indigo-500/20 bg-indigo-500/5 px-3 py-2">
                      <div className="flex-shrink-0 mt-0.5 text-indigo-400">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-200">{ann.text}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {ann.authorName} &middot; {new Date(ann.createdAt).toLocaleString()}
                        </p>
                      </div>
                      {canAnnotate && currentUserId && ann.authorId === currentUserId && onDeleteAnnotation && (
                        <button
                          onClick={() => onDeleteAnnotation(ann.id)}
                          className="flex-shrink-0 text-gray-600 hover:text-red-400 transition-colors text-[10px] self-start mt-0.5"
                          title="Delete annotation"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                  ))}
                  {isAddingNote && (
                    <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 px-3 py-2 space-y-2">
                      <textarea
                        autoFocus
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        placeholder="Add a note about this turn..."
                        className="w-full bg-transparent text-xs text-gray-200 placeholder-gray-600 resize-none outline-none min-h-[56px]"
                        maxLength={2000}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setAddingToTurn(null); setDraftText(''); }
                        }}
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-gray-600">{draftText.length}/2000</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setAddingToTurn(null); setDraftText(''); }}
                            className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleSubmitAnnotation(pc.promptIndex)}
                            disabled={submitting || !draftText.trim()}
                            className="text-[10px] px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                          >
                            {submitting ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {restoreTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setRestoreTarget(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-gray-800 bg-gray-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-100">
                Restore to Turn {restoreTarget.turn}
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                Rewinds your working tree to the snapshot captured after this prompt. Run on the
                machine that holds the repo — Origin won't touch your files from the cloud.
              </p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Run locally</p>
                <div className="flex items-stretch gap-2">
                  <code className="flex-1 px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-xs font-mono text-gray-200 break-all">
                    origin rewind --to {restoreTarget.sha}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`origin rewind --to ${restoreTarget.sha}`);
                      setRestoreCopied(true);
                      setTimeout(() => setRestoreCopied(false), 1500);
                    }}
                    className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
                  >
                    {restoreCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="text-[11px] text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
                Uncommitted changes will be stashed before rewinding. Use{' '}
                <code className="font-mono text-amber-300">git stash pop</code> to recover them.
              </div>
            </div>
            <div className="px-5 py-3 border-t border-gray-800 flex justify-end">
              <button
                onClick={() => setRestoreTarget(null)}
                className="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
