import { useState } from 'react';
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

interface PromptChange {
  promptIndex: number;
  promptText: string;
  filesChanged: string[] | string;
  diff: string;
}

interface TurnTimelineProps {
  promptChanges: PromptChange[];
  model: string;
  annotations?: SessionAnnotation[];
  canAnnotate?: boolean;
  onAddAnnotation?: (turnIndex: number, text: string) => Promise<void>;
  onDeleteAnnotation?: (annotationId: string) => Promise<void>;
  currentUserId?: string;
}

export default function TurnTimeline({
  promptChanges,
  model,
  annotations = [],
  canAnnotate = false,
  onAddAnnotation,
  onDeleteAnnotation,
  currentUserId,
}: TurnTimelineProps) {
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);
  const [addingToTurn, setAddingToTurn] = useState<number | null>(null);
  const [draftText, setDraftText] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  const sorted = [...promptChanges].sort((a, b) => a.promptIndex - b.promptIndex);

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-gray-300">Turn Timeline</h3>
        <span className="text-xs text-gray-600">
          {sorted.length} turn{sorted.length !== 1 ? 's' : ''} · {model}
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

          // Count lines from diff
          const addedLines = (pc.diff || '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
          const removedLines = (pc.diff || '').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;

          const turnAnnotations = annotations.filter(a => a.turnIndex === pc.promptIndex);

          return (
            <div key={pc.promptIndex} className="relative pl-8 pb-4 last:pb-0">
              {/* Dot */}
              <div className={`absolute left-1.5 top-1.5 w-[14px] h-[14px] rounded-full ${color.dot} ring-2 ring-gray-900 z-10`} />

              <div
                className={`rounded-lg border ${isExpanded ? color.border : 'border-gray-800'} ${isExpanded ? color.bg : 'hover:bg-gray-800/30'} transition-all cursor-pointer`}
                onClick={() => setExpandedTurn(isExpanded ? null : pc.promptIndex)}
              >
                <div className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${color.text}`}>
                      Turn {pc.promptIndex + 1}
                    </span>
                    <span className="text-[10px] text-gray-600">
                      {files.length} file{files.length !== 1 ? 's' : ''}
                      {addedLines > 0 && <span className="text-green-500 ml-1">+{addedLines}</span>}
                      {removedLines > 0 && <span className="text-red-500 ml-1">-{removedLines}</span>}
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
                        className="ml-auto text-[10px] text-gray-500 hover:text-indigo-400 transition-colors px-1.5 py-0.5 rounded hover:bg-indigo-500/10"
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
    </div>
  );
}
