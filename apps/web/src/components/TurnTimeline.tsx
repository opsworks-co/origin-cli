import { useState } from 'react';

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
}

export default function TurnTimeline({ promptChanges, model }: TurnTimelineProps) {
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);

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
          let files: string[] = [];
          try {
            files = Array.isArray(pc.filesChanged) ? pc.filesChanged : JSON.parse(pc.filesChanged || '[]');
          } catch {}

          // Count lines from diff
          const addedLines = (pc.diff || '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
          const removedLines = (pc.diff || '').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;

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
                  </div>
                  <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                    {isExpanded ? pc.promptText : (pc.promptText.length > 120 ? pc.promptText.slice(0, 120) + '...' : pc.promptText)}
                  </p>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-800/50 px-3 py-2">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
