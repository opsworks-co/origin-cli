import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { PromptEntry, PromptPattern, Repo, Agent } from '../api';
import { timeAgo, getStatusBadgeClass } from '../utils';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

type ViewMode = 'search' | 'patterns';

const PATTERN_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6b7280'];

export default function Prompts() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>('search');
  const [prompts, setPrompts] = useState<PromptEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [patterns, setPatterns] = useState<PromptPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');
  const [repoId, setRepoId] = useState('');
  const [file, setFile] = useState('');
  const [offset, setOffset] = useState(0);
  const LIMIT = 20;

  // Filter options
  const [repos, setRepos] = useState<Repo[]>([]);

  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
  }, []);

  const fetchPrompts = useCallback(() => {
    setLoading(true);
    api.searchPrompts({ q: query || undefined, model: model || undefined, repoId: repoId || undefined, file: file || undefined, limit: LIMIT, offset })
      .then((r) => { setPrompts(r.prompts); setTotal(r.total); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [query, model, repoId, file, offset]);

  const fetchPatterns = useCallback(() => {
    setLoading(true);
    api.getPromptPatterns()
      .then((r) => setPatterns(r.patterns))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (viewMode === 'search') fetchPrompts();
    else fetchPatterns();
  }, [viewMode, fetchPrompts, fetchPatterns]);

  useEffect(() => { setOffset(0); }, [query, model, repoId, file]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    fetchPrompts();
  };

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Prompt Library</h1>
          <p className="text-sm text-gray-500 mt-1">Search and analyze prompts across your organization</p>
        </div>
        <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1">
          <button
            onClick={() => setViewMode('search')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'search' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Search
          </button>
          <button
            onClick={() => setViewMode('patterns')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'patterns' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Patterns
          </button>
        </div>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">
          {error}<button onClick={() => setError('')} className="ml-2">&times;</button>
        </div>
      )}

      {viewMode === 'search' ? (
        <>
          {/* Search & Filters */}
          <form onSubmit={handleSearch} className="space-y-3">
            <div className="flex items-center gap-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="input flex-1"
                placeholder="Search prompts by text..."
              />
              <input
                value={file}
                onChange={(e) => setFile(e.target.value)}
                className="input w-56"
                placeholder="Filter by file path..."
              />
              <select value={model} onChange={(e) => setModel(e.target.value)} className="select w-40">
                <option value="">All Models</option>
                <option value="claude-sonnet-4-20250514">Sonnet 4</option>
                <option value="claude-opus-4-20250514">Opus 4</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
              </select>
              <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className="select w-40">
                <option value="">All Repos</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button type="submit" className="btn-primary">Search</button>
            </div>
          </form>

          {/* Results */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
            </div>
          ) : prompts.length === 0 ? (
            <div className="card text-center py-12 text-gray-500">
              {query ? 'No prompts match your search.' : 'No prompts recorded yet.'}
            </div>
          ) : (
            <>
              <div className="text-xs text-gray-500 mb-2">{total} prompt{total !== 1 ? 's' : ''} found</div>
              <div className="space-y-2">
                {prompts.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => navigate(`/sessions/${p.sessionId}`)}
                    className="card hover:border-gray-600 transition-colors cursor-pointer"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="text-sm text-gray-200 flex-1 mr-4">
                        {p.promptText.slice(0, 200)}{p.promptText.length > 200 ? '...' : ''}
                      </p>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="badge-blue text-xs">{p.model}</span>
                        {p.reviewStatus && <span className={getStatusBadgeClass(p.reviewStatus.toLowerCase())}>{p.reviewStatus}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      {p.repoName && <span>{p.repoName}</span>}
                      {p.userName && <span>{p.userName}</span>}
                      <span>{p.filesChanged.length} file{p.filesChanged.length !== 1 ? 's' : ''}</span>
                      <span>${p.costUsd.toFixed(2)}</span>
                      <span>{timeAgo(p.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-2 py-3">
                  <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} className="btn-secondary text-xs">Previous</button>
                  <span className="text-sm text-gray-500">Page {currentPage} of {totalPages}</span>
                  <button onClick={() => setOffset(offset + LIMIT)} disabled={currentPage >= totalPages} className="btn-secondary text-xs">Next</button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        /* Patterns View */
        loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
          </div>
        ) : patterns.length === 0 ? (
          <div className="card text-center py-12 text-gray-500">No prompt data available for pattern analysis.</div>
        ) : (
          <div className="grid lg:grid-cols-2 gap-4">
            {/* Bar Chart */}
            <div className="card">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">Prompt Categories</p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={patterns} layout="vertical">
                    <XAxis type="number" tick={{ fontSize: 10, fill: '#6b7280' }} />
                    <YAxis type="category" dataKey="category" tick={{ fontSize: 11, fill: '#9ca3af' }} width={100} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                      formatter={(v: number) => [v, 'Prompts']}
                    />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {patterns.map((_, i) => (
                        <Cell key={i} fill={PATTERN_COLORS[i % PATTERN_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Approval Rates Table */}
            <div className="card">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">Approval Rate by Pattern</p>
              <div className="space-y-3">
                {patterns.map((p, i) => (
                  <div key={p.category}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: PATTERN_COLORS[i % PATTERN_COLORS.length] }} />
                        <span className="text-gray-300">{p.category}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-gray-500">{p.count} prompts</span>
                        <span className={p.approvalRate >= 80 ? 'text-green-400' : p.approvalRate >= 50 ? 'text-amber-400' : 'text-red-400'}>
                          {p.approvalRate.toFixed(0)}% approved
                        </span>
                      </div>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full transition-all"
                        style={{
                          width: `${p.approvalRate}%`,
                          backgroundColor: p.approvalRate >= 80 ? '#22c55e' : p.approvalRate >= 50 ? '#f59e0b' : '#ef4444',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
