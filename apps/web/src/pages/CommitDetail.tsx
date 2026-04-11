import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { CommitDetail } from '../api';
import { timeAgo } from '../utils';

// ─── Diff line renderer (GitHub-style) ───────────────────────────────
function DiffLineRow({ line }: { line: string }) {
  let bg = '';
  let text = 'text-gray-400';
  let prefix = ' ';
  if (line.startsWith('@@')) {
    return (
      <div className="bg-indigo-950/40 text-indigo-300 px-4 py-0.5 font-mono text-[11px] border-y border-indigo-900/40 whitespace-pre">
        {line}
      </div>
    );
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    bg = 'bg-emerald-950/40 border-l-2 border-emerald-700/60';
    text = 'text-emerald-200';
    prefix = '+';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bg = 'bg-red-950/40 border-l-2 border-red-800/60';
    text = 'text-red-200';
    prefix = '-';
  } else if (line.startsWith('+++') || line.startsWith('---')) {
    return null;
  }
  return (
    <div className={`${bg} flex items-start px-0 font-mono text-[11px] leading-[1.55] whitespace-pre`}>
      <span className="inline-block w-6 text-center text-gray-600 select-none flex-shrink-0">{prefix}</span>
      <span className={`flex-1 ${text} pr-4`}>
        {line.slice(1) || ' '}
      </span>
    </div>
  );
}

function FileStatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    added: 'bg-emerald-500',
    modified: 'bg-yellow-500',
    removed: 'bg-red-500',
    renamed: 'bg-blue-500',
  };
  return <span className={`w-1.5 h-1.5 rounded-full ${map[status] || 'bg-gray-500'} flex-shrink-0`} />;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function CommitDetailPage() {
  const { id: repoId, sha } = useParams<{ id: string; sha: string }>();
  const navigate = useNavigate();
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId || !sha) return;
    setLoading(true);
    api
      .getCommitDetail(repoId, sha)
      .then((data) => {
        setCommit(data);
        if (data.files && data.files.length > 0) {
          setSelectedFile(data.files[0].filename);
        }
      })
      .catch((err) => setError(err.message || 'Failed to load commit'))
      .finally(() => setLoading(false));
  }, [repoId, sha]);

  // Build a file tree from flat file list
  const fileTree = useMemo(() => {
    if (!commit) return null;
    type Node = {
      name: string;
      path: string;
      isFile: boolean;
      file?: CommitDetail['files'][number];
      children: Map<string, Node>;
    };
    const root: Node = { name: '', path: '', isFile: false, children: new Map() };
    for (const f of commit.files || []) {
      const parts = f.filename.split('/');
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        if (!cur.children.has(part)) {
          cur.children.set(part, {
            name: part,
            path: parts.slice(0, i + 1).join('/'),
            isFile: isLast,
            file: isLast ? f : undefined,
            children: new Map(),
          });
        }
        cur = cur.children.get(part)!;
      }
    }
    return root;
  }, [commit]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load commit</p>
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={() => navigate(`/repos/${repoId}`)} className="btn-secondary mt-4 text-sm">
          Back to repository
        </button>
      </div>
    );
  }

  const selected = commit.files.find((f) => f.filename === selectedFile) || commit.files[0];
  const isAI = !!commit.session || !!commit.aiToolDetected;
  const activePrompts =
    selected && selected.promptIndexes.length > 0
      ? commit.promptChanges.filter((pc) => selected.promptIndexes.includes(pc.promptIndex))
      : commit.promptChanges;

  return (
    <div className="space-y-5">
      {/* Breadcrumb / header */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Link to="/repos" className="hover:text-gray-300 transition-colors">Repos</Link>
        <span className="text-gray-700">/</span>
        <Link to={`/repos/${repoId}`} className="hover:text-gray-300 transition-colors">
          {commit.repo.name}
        </Link>
        <span className="text-gray-700">/</span>
        <Link to={`/repos/${repoId}`} className="hover:text-gray-300 transition-colors">Commits</Link>
        <span className="text-gray-700">/</span>
        <code className="text-indigo-400 font-mono">{commit.sha.slice(0, 7)}</code>
      </div>

      {/* Commit header card */}
      <div className="card">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-gray-100 mb-2">{commit.message.split('\n')[0]}</h1>
            <div className="flex items-center gap-3 flex-wrap text-xs text-gray-500">
              <code className="text-indigo-400 bg-indigo-950/30 px-2 py-0.5 rounded font-mono">
                {commit.sha.slice(0, 9)}
              </code>
              <span>
                <span className="text-gray-300">{commit.author}</span> committed {timeAgo(commit.committedAt)}
              </span>
              {commit.branch && (
                <span className="text-gray-500">
                  on <span className="text-gray-300 font-mono">{commit.branch}</span>
                </span>
              )}
              {isAI ? (
                commit.session ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
                    {commit.session.model}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/10 text-purple-400 border border-dashed border-purple-500/40">
                    {commit.aiToolDetected} <span className="opacity-60">detected</span>
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-800 text-gray-400 border border-gray-700">
                  Human
                </span>
              )}
            </div>
            {commit.message.split('\n').slice(1).join('\n').trim() && (
              <pre className="mt-3 text-xs text-gray-400 font-mono whitespace-pre-wrap leading-relaxed max-w-3xl">
                {commit.message.split('\n').slice(1).join('\n').trim()}
              </pre>
            )}
          </div>

          {/* Stats */}
          <div className="flex items-center gap-4 text-xs">
            <div className="text-center">
              <div className="text-gray-200 font-bold text-lg">{commit.files.length}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">files</div>
            </div>
            <div className="text-center">
              <div className="text-emerald-400 font-bold text-lg">+{commit.stats.additions}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">added</div>
            </div>
            <div className="text-center">
              <div className="text-red-400 font-bold text-lg">−{commit.stats.deletions}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">removed</div>
            </div>
          </div>
        </div>

        {/* Session summary strip */}
        {commit.session && (
          <div className="mt-4 pt-4 border-t border-gray-800 flex items-center gap-5 flex-wrap text-xs">
            {commit.session.agent && (
              <div className="flex items-center gap-2">
                {commit.session.agent.icon && (
                  <span className="text-base leading-none">{commit.session.agent.icon}</span>
                )}
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/40">
                  {commit.session.agent.name}
                </span>
              </div>
            )}
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono bg-gray-800/60 text-gray-300 border border-gray-700/60">
              {commit.session.model}
            </span>
            <Link
              to={`/sessions/${commit.session.id}`}
              className="flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 font-medium"
            >
              <span className="font-mono">session {commit.session.id.slice(0, 8)}</span>
              <span>&rarr;</span>
            </Link>
            {commit.session.user && (
              <span className="text-gray-500">
                by <span className="text-gray-300">{commit.session.user.name || commit.session.user.email}</span>
              </span>
            )}
            <span className="text-gray-500">
              <span className="text-gray-300">{commit.promptChanges.length}</span>{' '}
              prompt{commit.promptChanges.length === 1 ? '' : 's'}
            </span>
            <span className="text-gray-500">
              <span className="text-gray-300">${commit.session.costUsd.toFixed(4)}</span> cost
            </span>
            <span className="text-gray-500">
              <span className="text-gray-300">{(commit.session.tokensUsed / 1000).toFixed(1)}k</span> tokens
            </span>
            <span className="text-gray-500">
              <span className="text-gray-300">{formatDuration(commit.session.durationMs)}</span>
            </span>
          </div>
        )}
      </div>

      {/* Main 3-pane layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr_320px] gap-5">
        {/* Left: file tree */}
        <div className="card p-0 overflow-hidden h-fit lg:sticky lg:top-4">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium">Files</p>
            <span className="text-[10px] text-gray-600">{commit.files.length}</span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto py-1">
            {fileTree && <TreeNode node={fileTree} depth={0} selected={selectedFile} onSelect={setSelectedFile} />}
          </div>
        </div>

        {/* Middle: diff viewer */}
        <div className="card p-0 overflow-hidden min-w-0">
          {selected ? (
            <>
              <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3 bg-gray-900/60">
                <FileStatusDot status={selected.status} />
                <span className="text-sm text-gray-200 font-mono truncate flex-1">
                  {selected.filename}
                  {selected.previousFilename && (
                    <span className="text-gray-600"> &larr; {selected.previousFilename}</span>
                  )}
                </span>
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">{selected.status}</span>
                <span className="text-xs flex-shrink-0">
                  {selected.additions > 0 && <span className="text-emerald-400">+{selected.additions}</span>}
                  {selected.additions > 0 && selected.deletions > 0 && ' '}
                  {selected.deletions > 0 && <span className="text-red-400">−{selected.deletions}</span>}
                </span>
              </div>
              <div className="bg-[#0a0b14] overflow-x-auto max-h-[75vh] overflow-y-auto">
                {selected.patch ? (
                  selected.patch.split('\n').map((line, i) => <DiffLineRow key={i} line={line} />)
                ) : (
                  <div className="px-6 py-12 text-center text-sm text-gray-600">
                    No patch content available for this file.
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="px-6 py-24 text-center text-sm text-gray-600">No files in this commit.</div>
          )}
        </div>

        {/* Right: prompt sidebar */}
        <div className="card p-0 overflow-hidden h-fit lg:sticky lg:top-4">
          <div className="px-4 py-3 border-b border-gray-800">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium">
              {selected && selected.promptIndexes.length > 0 ? 'Prompts for this file' : 'Prompts in this commit'}
            </p>
            {commit.promptChanges.length === 0 && (
              <p className="text-[11px] text-gray-600 mt-1">No linked prompts</p>
            )}
          </div>
          <div className="max-h-[75vh] overflow-y-auto divide-y divide-gray-800/70">
            {activePrompts.length > 0 ? (
              activePrompts.map((pc, i) => (
                <div key={pc.promptIndex} className="px-4 py-3 hover:bg-gray-900/40 transition-colors">
                  <div className="flex items-start gap-2.5">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 flex items-center justify-center text-[10px] font-bold">
                      {pc.promptIndex + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-200 leading-relaxed whitespace-pre-wrap">
                        {pc.promptText || '(empty prompt)'}
                      </p>
                      {pc.filesChanged.length > 0 && (
                        <p className="text-[10px] text-gray-600 mt-2">
                          {pc.filesChanged.length} file{pc.filesChanged.length === 1 ? '' : 's'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))
            ) : commit.session ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-gray-600">
                  Session found but no per-prompt diffs captured yet.
                </p>
                <Link
                  to={`/sessions/${commit.session.id}`}
                  className="inline-block mt-2 text-[11px] text-indigo-400 hover:text-indigo-300"
                >
                  View full session &rarr;
                </Link>
              </div>
            ) : (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-gray-600">
                  {commit.aiToolDetected
                    ? `Detected as ${commit.aiToolDetected} but no Origin session was captured.`
                    : 'Committed by a human — no AI prompts.'}
                </p>
              </div>
            )}
          </div>
          {commit.session && activePrompts.length > 0 && (
            <div className="px-4 py-2.5 border-t border-gray-800">
              <Link
                to={`/sessions/${commit.session.id}`}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
              >
                Full session details &rarr;
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tree node component ────────────────────────────────────────────
type NodeShape = {
  name: string;
  path: string;
  isFile: boolean;
  file?: CommitDetail['files'][number];
  children: Map<string, NodeShape>;
};

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: NodeShape;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  // Collapse single-child folder chains (like VS Code compact folders)
  let current = node;
  let compacted = node.name;
  while (!current.isFile && current.children.size === 1) {
    const only = [...current.children.values()][0];
    if (only.isFile) break;
    compacted = compacted ? `${compacted}/${only.name}` : only.name;
    current = only;
  }

  const children = [...current.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      {depth > 0 && !node.isFile && (
        <div
          className="px-3 py-1 text-[11px] text-gray-500 font-medium flex items-center gap-1.5"
          style={{ paddingLeft: `${depth * 10 + 8}px` }}
        >
          <span className="text-gray-700">▾</span>
          <span className="truncate">{compacted}</span>
        </div>
      )}
      {node.isFile && node.file && (
        <button
          onClick={() => onSelect(node.file!.filename)}
          className={`w-full text-left px-3 py-1 text-[11px] flex items-center gap-2 hover:bg-gray-800/40 transition-colors ${
            selected === node.file.filename ? 'bg-indigo-950/40 border-l-2 border-indigo-500' : 'border-l-2 border-transparent'
          }`}
          style={{ paddingLeft: `${depth * 10 + 8}px` }}
          title={node.file.filename}
        >
          <FileStatusDot status={node.file.status} />
          <span
            className={`truncate flex-1 font-mono ${
              selected === node.file.filename ? 'text-gray-100' : 'text-gray-400'
            }`}
          >
            {node.name}
          </span>
          <span className="text-[9px] flex-shrink-0">
            {node.file.additions > 0 && <span className="text-emerald-400">+{node.file.additions}</span>}
            {node.file.additions > 0 && node.file.deletions > 0 && ' '}
            {node.file.deletions > 0 && <span className="text-red-400">−{node.file.deletions}</span>}
          </span>
        </button>
      )}
      {!node.isFile &&
        children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
