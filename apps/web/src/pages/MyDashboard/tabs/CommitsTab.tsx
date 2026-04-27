import React from 'react';
import { ExternalLink } from 'lucide-react';
import { agentColor, fmt, fmtCost, timeAgo } from '../utils';

export interface CommitEntry {
  id: string;
  sha: string;
  message: string;
  author: string;
  aiToolDetected: string | null;
  aiDetectionMethod: string | null;
  branch: string | null;
  filesChanged: string[];
  committedAt: string;
  repoName: string;
  sessionId: string | null;
  sessionModel: string | null;
  sessionAgent: string | null;
  sessionCost: number;
  sessionTokens: number;
  sessionLinesAdded: number;
  sessionLinesRemoved: number;
  diff: string | null;
  prompts: Array<{
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    createdAt: string;
  }>;
}

export type CommitSort = 'date' | 'repo' | 'cost';

export function CommitsTab({
  commitsTotal,
  commitSort,
  setCommitSort,
  setCommitsOffset,
  commitsLoading,
  commitEntries,
  expandedCommit,
  setExpandedCommit,
  commitsOffset,
  navigate,
}: {
  commitsTotal: number;
  commitSort: CommitSort;
  setCommitSort: (v: CommitSort) => void;
  setCommitsOffset: (v: number) => void;
  commitsLoading: boolean;
  commitEntries: CommitEntry[];
  expandedCommit: string | null;
  setExpandedCommit: (v: string | null) => void;
  commitsOffset: number;
  navigate: (path: string) => void;
}) {
  // Hide commits with no actual file changes — empty/trivial commits add
  // noise and don't tell the user anything about AI code authorship.
  const visibleCommits = commitEntries.filter((c) => c.filesChanged.length > 0);
  const hiddenCount = commitEntries.length - visibleCommits.length;

  return (
        <div className="space-y-4" data-tour="tab-content-commits">
          {/* Sort controls */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {visibleCommits.length} commit{visibleCommits.length !== 1 ? 's' : ''}
              {hiddenCount > 0 && (
                <span className="text-gray-600"> · {hiddenCount} empty hidden</span>
              )}
            </span>
            <select
              value={commitSort}
              onChange={(e) => { setCommitSort(e.target.value as CommitSort); setCommitsOffset(0); }}
              className="select text-sm"
            >
              <option value="date">Sort by date</option>
              <option value="repo">Sort by repo</option>
              <option value="cost">Sort by cost</option>
            </select>
          </div>

          {/* Commits table */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="px-4 py-3 font-medium w-10"></th>
                    <th className="px-4 py-3 font-medium">SHA</th>
                    <th className="px-4 py-3 font-medium">Message</th>
                    <th className="px-4 py-3 font-medium">Repo</th>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Branch</th>
                    <th className="px-4 py-3 font-medium">Agent</th>
                    <th className="px-4 py-3 font-medium">Cost</th>
                    <th className="px-4 py-3 font-medium hidden lg:table-cell">Tokens</th>
                    <th className="px-4 py-3 font-medium hidden lg:table-cell">Changes</th>
                    <th className="px-4 py-3 font-medium text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {commitsLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="border-b border-gray-800/50">
                        <td colSpan={10} className="px-4 py-3">
                          <div className="h-4 bg-gray-800 rounded animate-pulse" />
                        </td>
                      </tr>
                    ))
                  ) : commitEntries.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-gray-600">
                        No commits tracked yet. Make a commit during an AI session to see it here.
                      </td>
                    </tr>
                  ) : (
                    commitEntries.map((c) => {
                      const isAI = !!c.sessionId;
                      const isExpanded = expandedCommit === c.id;
                      return (
                        <React.Fragment key={c.id}>
                          <tr
                            className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer"
                            onClick={() => setExpandedCommit(isExpanded ? null : c.id)}
                          >
                            <td className="px-4 py-3">
                              {isAI ? (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/15 text-indigo-400">
                                  AI
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-700/60 text-gray-400">
                                  HU
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-400">{c.sha.slice(0, 7)}</td>
                            <td className="px-4 py-3 text-gray-300 max-w-xs truncate">{c.message.split('\n')[0]}</td>
                            <td className="px-4 py-3 text-gray-400">{c.repoName}</td>
                            <td className="px-4 py-3 text-gray-500 hidden md:table-cell font-mono text-xs">{c.branch || '—'}</td>
                            <td className="px-4 py-3">
                              {c.sessionAgent ? (
                                <span
                                  className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded border"
                                  style={{
                                    backgroundColor: `${agentColor(c.sessionAgent)}28`,
                                    borderColor: `${agentColor(c.sessionAgent)}55`,
                                    color: agentColor(c.sessionAgent),
                                  }}
                                >
                                  {c.sessionAgent}
                                </span>
                              ) : (
                                <span className="text-gray-600 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-300">{c.sessionCost > 0 ? fmtCost(c.sessionCost) : '—'}</td>
                            <td className="px-4 py-3 text-gray-400 hidden lg:table-cell">{c.sessionTokens > 0 ? fmt(c.sessionTokens) : '—'}</td>
                            <td className="px-4 py-3 hidden lg:table-cell">
                              <span className="text-xs">
                                <span className="text-gray-500">{c.filesChanged.length} file{c.filesChanged.length !== 1 ? 's' : ''}</span>
                                {(c.sessionLinesAdded > 0 || c.sessionLinesRemoved > 0) && (
                                  <>
                                    <span className="text-green-500 ml-1.5">+{c.sessionLinesAdded}</span>
                                    <span className="text-red-400 ml-1">-{c.sessionLinesRemoved}</span>
                                  </>
                                )}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-gray-500 text-xs whitespace-nowrap">
                              {timeAgo(c.committedAt)}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="border-b border-gray-800/50">
                              <td colSpan={10} className="px-4 py-4 bg-gray-900/50">
                                <div className="space-y-3">
                                  {/* Details grid */}
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                    <div>
                                      <span className="text-gray-500">Author</span>
                                      <p className="text-gray-300 mt-0.5">{c.author}</p>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Full SHA</span>
                                      <p className="text-gray-300 font-mono text-[10px] mt-0.5">{c.sha}</p>
                                    </div>
                                    {c.sessionModel && (
                                      <div>
                                        <span className="text-gray-500">Model</span>
                                        <p className="text-gray-300 mt-0.5">{c.sessionModel}</p>
                                      </div>
                                    )}
                                    {c.aiDetectionMethod && (
                                      <div>
                                        <span className="text-gray-500">Detection</span>
                                        <p className="text-gray-300 mt-0.5">{c.aiDetectionMethod.replace(/-/g, ' ')}</p>
                                      </div>
                                    )}
                                  </div>

                                  {/* Full commit message */}
                                  {c.message.includes('\n') && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 mb-1">Commit message</div>
                                      <pre className="text-xs text-gray-400 whitespace-pre-wrap bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2">
                                        {c.message}
                                      </pre>
                                    </div>
                                  )}

                                  {/* Files changed */}
                                  {c.filesChanged.length > 0 && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 mb-1">
                                        {c.filesChanged.length} file{c.filesChanged.length !== 1 ? 's' : ''} changed
                                      </div>
                                      <div className="flex flex-wrap gap-1">
                                        {c.filesChanged.map((f, fi) => (
                                          <span key={fi} className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 font-mono">
                                            {f}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* Prompts that produced this commit */}
                                  {c.prompts && c.prompts.length > 0 && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 mb-1">
                                        Prompts ({c.prompts.length})
                                      </div>
                                      <div className="space-y-1.5">
                                        {c.prompts.slice(0, 5).map((p, pi) => (
                                          <div key={pi} className="flex items-start gap-2 bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2">
                                            <span className="text-[10px] text-indigo-400 font-mono shrink-0 mt-0.5">#{p.promptIndex + 1}</span>
                                            <p className="text-xs text-gray-400 line-clamp-2">{p.promptText}</p>
                                            {p.filesChanged.length > 0 && (
                                              <span className="text-[10px] text-gray-600 shrink-0">{p.filesChanged.length} file{p.filesChanged.length !== 1 ? 's' : ''}</span>
                                            )}
                                          </div>
                                        ))}
                                        {c.prompts.length > 5 && (
                                          <div className="text-[10px] text-gray-600">+{c.prompts.length - 5} more prompts</div>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Inline diff */}
                                  {c.diff && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 mb-1">Diff</div>
                                      <pre className="text-[10px] font-mono leading-relaxed bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2 overflow-x-auto max-h-60">
                                        {c.diff.split('\n').slice(0, 80).map((line, li) => (
                                          <div
                                            key={li}
                                            className={
                                              line.startsWith('+') && !line.startsWith('+++')
                                                ? 'text-green-400'
                                                : line.startsWith('-') && !line.startsWith('---')
                                                ? 'text-red-400'
                                                : line.startsWith('@@')
                                                ? 'text-cyan-400'
                                                : line.startsWith('diff --git')
                                                ? 'text-indigo-400 font-semibold'
                                                : 'text-gray-500'
                                            }
                                          >
                                            {line}
                                          </div>
                                        ))}
                                        {c.diff.split('\n').length > 80 && (
                                          <div className="text-gray-600 mt-1">... {c.diff.split('\n').length - 80} more lines</div>
                                        )}
                                      </pre>
                                    </div>
                                  )}

                                  {/* Session link */}
                                  {c.sessionId && (
                                    <button
                                      onClick={() => navigate(`/sessions/${c.sessionId}`)}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-colors"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                      View linked session
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {commitsTotal > 50 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
                <span className="text-xs text-gray-500">
                  {commitsOffset + 1}–{Math.min(commitsOffset + 50, commitsTotal)} of {commitsTotal}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    disabled={commitsOffset === 0}
                    onClick={() => setCommitsOffset(Math.max(0, commitsOffset - 50))}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                  >
                    Prev
                  </button>
                  <button
                    disabled={commitsOffset + 50 >= commitsTotal}
                    onClick={() => setCommitsOffset(commitsOffset + 50)}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
  );
}
