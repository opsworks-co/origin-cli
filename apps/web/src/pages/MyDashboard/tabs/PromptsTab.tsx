import { Search, MessageSquare, FileText, ArrowRight } from 'lucide-react';
import { PromptEntry, agentColor, timeAgo } from '../utils';

export function PromptsTab({
  promptSearch,
  setPromptSearch,
  promptsTotal,
  promptsLoading,
  promptEntries,
  expandedPrompt,
  setExpandedPrompt,
  promptSearchDebounced,
  promptsOffset,
  setPromptsOffset,
  navigate,
}: {
  promptSearch: string;
  setPromptSearch: (v: string) => void;
  promptsTotal: number;
  promptsLoading: boolean;
  promptEntries: PromptEntry[];
  expandedPrompt: string | null;
  setExpandedPrompt: (v: string | null) => void;
  promptSearchDebounced: string;
  promptsOffset: number;
  setPromptsOffset: (v: number) => void;
  navigate: (path: string) => void;
}) {
  return (
        <div className="space-y-4" data-tour="tab-content-prompts">
          {/* Prompt search bar */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={promptSearch}
                onChange={(e) => setPromptSearch(e.target.value)}
                placeholder="Search across all prompts..."
                className="input pl-10 w-full"
              />
            </div>
            <span className="text-xs text-gray-500 whitespace-nowrap">{promptsTotal} result{promptsTotal !== 1 ? 's' : ''}</span>
          </div>
          {promptsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 w-48 bg-gray-800 rounded mb-2" />
                  <div className="h-3 w-96 bg-gray-800/50 rounded" />
                </div>
              ))}
            </div>
          ) : promptEntries.length === 0 ? (
            <div className="card py-12 text-center text-gray-600">
              No prompts recorded yet. Prompts are captured during AI coding sessions.
            </div>
          ) : (
            <>
              <div className="text-xs text-gray-500">{promptsTotal} total prompts</div>
              <div className="space-y-2">
                {promptEntries.map((p, i) => {
                  const key = `${p.sessionId}-${p.promptIndex}`;
                  const isExpanded = expandedPrompt === key;
                  const color = agentColor(p.agentName);
                  return (
                    <div key={i} className="card hover:border-gray-700 transition-colors">
                      <div
                        className="flex items-start gap-3 cursor-pointer"
                        onClick={() => setExpandedPrompt(isExpanded ? null : key)}
                      >
                        <div className="flex-shrink-0 mt-0.5">
                          <MessageSquare className="w-4 h-4 text-gray-600" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{ backgroundColor: `${color}20`, color }}
                            >
                              {p.agentName || 'Unknown'}
                            </span>
                            <span className="text-[10px] text-gray-600">
                              prompt #{p.promptIndex + 1}
                            </span>
                            <span className="text-[10px] text-gray-600">
                              &middot; {timeAgo(p.createdAt)}
                            </span>
                            {p.filesChanged.length > 0 && (
                              <span className="text-[10px] text-gray-500">
                                <FileText className="w-3 h-3 inline mr-0.5" />
                                {p.filesChanged.length} file{p.filesChanged.length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-300 line-clamp-2">
                            {promptSearchDebounced ? (() => {
                              const idx = p.promptText.toLowerCase().indexOf(promptSearchDebounced.toLowerCase());
                              if (idx === -1) return p.promptText;
                              const before = p.promptText.slice(0, idx);
                              const match = p.promptText.slice(idx, idx + promptSearchDebounced.length);
                              const after = p.promptText.slice(idx + promptSearchDebounced.length);
                              return <>{before}<mark className="bg-indigo-500/30 text-indigo-300 rounded px-0.5">{match}</mark>{after}</>;
                            })() : p.promptText}
                          </p>
                        </div>
                        <button
                          className="text-gray-600 hover:text-gray-400 flex-shrink-0"
                          onClick={(e) => { e.stopPropagation(); navigate(`/sessions/${p.sessionId}`); }}
                          title="View session"
                        >
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
                          {p.filesChanged.length > 0 && (
                            <div>
                              <div className="text-[10px] text-gray-500 mb-1">Files changed:</div>
                              <div className="flex flex-wrap gap-1">
                                {p.filesChanged.map((f, fi) => (
                                  <span key={fi} className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 font-mono">
                                    {f}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {p.diff && (
                            <div>
                              <div className="text-[10px] text-gray-500 mb-1">Diff:</div>
                              <pre className="text-[10px] font-mono leading-relaxed bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2 overflow-x-auto max-h-60">
                                {p.diff.split('\n').slice(0, 50).map((line, li) => (
                                  <div
                                    key={li}
                                    className={
                                      line.startsWith('+') && !line.startsWith('+++')
                                        ? 'text-green-400'
                                        : line.startsWith('-') && !line.startsWith('---')
                                        ? 'text-red-400'
                                        : line.startsWith('@@')
                                        ? 'text-cyan-400'
                                        : 'text-gray-500'
                                    }
                                  >
                                    {line}
                                  </div>
                                ))}
                                {p.diff.split('\n').length > 50 && (
                                  <div className="text-gray-600 mt-1">... {p.diff.split('\n').length - 50} more lines</div>
                                )}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Pagination */}
              {promptsTotal > 30 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    {promptsOffset + 1}–{Math.min(promptsOffset + 30, promptsTotal)} of {promptsTotal}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      disabled={promptsOffset === 0}
                      onClick={() => setPromptsOffset(Math.max(0, promptsOffset - 30))}
                      className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                    >
                      Prev
                    </button>
                    <button
                      disabled={promptsOffset + 30 >= promptsTotal}
                      onClick={() => setPromptsOffset(promptsOffset + 30)}
                      className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
  );
}
