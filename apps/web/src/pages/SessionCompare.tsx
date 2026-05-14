import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getSession, Session } from '../api';
import { formatCost, formatDuration, displayAgentName } from '../utils';
import { ArrowLeft, GitBranch, Clock, DollarSign, Zap, FileCode, MessageSquare, TrendingUp, TrendingDown, Minus } from 'lucide-react';

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function DiffArrow({ a, b, inverse }: { a: number; b: number; inverse?: boolean }) {
  if (a === b) return <Minus className="w-3.5 h-3.5 text-gray-500" />;
  const better = inverse ? b < a : b > a;
  return better ? (
    <TrendingUp className="w-3.5 h-3.5 text-green-400" />
  ) : (
    <TrendingDown className="w-3.5 h-3.5 text-red-400" />
  );
}

function StatRow({ label, aVal, bVal, format, inverse }: {
  label: string;
  aVal: number;
  bVal: number;
  format?: (n: number) => string;
  inverse?: boolean;
}) {
  const f = format || ((n: number) => n.toLocaleString());
  return (
    <tr className="border-b border-gray-800/50">
      <td className="px-4 py-3 text-gray-400 font-medium">{label}</td>
      <td className="px-4 py-3 text-gray-200 text-right font-mono">{f(aVal)}</td>
      <td className="px-4 py-3 text-center">
        <DiffArrow a={aVal} b={bVal} inverse={inverse} />
      </td>
      <td className="px-4 py-3 text-gray-200 text-right font-mono">{f(bVal)}</td>
    </tr>
  );
}

export default function SessionCompare() {
  const { id1, id2 } = useParams<{ id1: string; id2: string }>();
  const navigate = useNavigate();
  const [a, setA] = useState<Session | null>(null);
  const [b, setB] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id1 || !id2) return;
    setLoading(true);
    Promise.all([getSession(id1), getSession(id2)])
      .then(([s1, s2]) => {
        setA(s1);
        setB(s2);
      })
      .catch(() => setError('Failed to load sessions'))
      .finally(() => setLoading(false));
  }, [id1, id2]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-8 w-48 bg-gray-800 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-2 gap-6">
          {[0, 1].map((i) => (
            <div key={i} className="card p-6 space-y-4">
              {Array.from({ length: 6 }).map((_, j) => (
                <div key={j} className="h-4 bg-gray-800 rounded animate-pulse" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !a || !b) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <p className="text-red-400">{error || 'Sessions not found'}</p>
        <button onClick={() => navigate('/me')} className="mt-4 text-indigo-400 hover:underline">
          Back to dashboard
        </button>
      </div>
    );
  }

  const aPrompts = a.promptChanges?.length || 0;
  const bPrompts = b.promptChanges?.length || 0;
  const aFiles = a.filesChanged ? a.filesChanged.split('\n').filter(Boolean).length : 0;
  const bFiles = b.filesChanged ? b.filesChanged.split('\n').filter(Boolean).length : 0;
  const aCostPerLine = a.linesAdded > 0 ? a.costUsd / a.linesAdded : 0;
  const bCostPerLine = b.linesAdded > 0 ? b.costUsd / b.linesAdded : 0;
  const aTokensPerLine = a.linesAdded > 0 ? a.tokensUsed / a.linesAdded : 0;
  const bTokensPerLine = b.linesAdded > 0 ? b.tokensUsed / b.linesAdded : 0;

  function SessionHeader({ s, label }: { s: Session; label: string }) {
    return (
      <div className="text-center">
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <Link to={`/sessions/${s.id}`} className="text-indigo-400 hover:underline font-medium">
          {displayAgentName(s.agentName) || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || s.model}
        </Link>
        <div className="flex items-center justify-center gap-2 mt-1 text-xs text-gray-500">
          {s.repoName && <span>{s.repoName}</span>}
          {s.branch && (
            <span className="flex items-center gap-0.5">
              <GitBranch className="w-3 h-3" />
              {s.branch}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-600 mt-0.5">
          {new Date(s.createdAt).toLocaleDateString()} {new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/me')} className="text-gray-400 hover:text-gray-200">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-xl font-semibold text-gray-100">Compare Sessions</h1>
      </div>

      {/* Session headers */}
      <div className="card overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="px-4 py-3 text-xs text-gray-500 font-medium w-40"></th>
              <th className="px-4 py-3"><SessionHeader s={a} label="Session A" /></th>
              <th className="px-4 py-3 w-10"></th>
              <th className="px-4 py-3"><SessionHeader s={b} label="Session B" /></th>
            </tr>
          </thead>
          <tbody>
            <StatRow label="Duration" aVal={a.durationMs} bVal={b.durationMs} format={formatDuration} inverse />
            <StatRow label="Cost" aVal={a.costUsd} bVal={b.costUsd} format={formatCost} inverse />
            <StatRow label="Tokens" aVal={a.tokensUsed} bVal={b.tokensUsed} format={fmt} inverse />
            <StatRow label="Input Tokens" aVal={a.inputTokens} bVal={b.inputTokens} format={fmt} inverse />
            <StatRow label="Output Tokens" aVal={a.outputTokens} bVal={b.outputTokens} format={fmt} inverse />
            <StatRow label="Lines Added" aVal={a.linesAdded} bVal={b.linesAdded} format={fmt} />
            <StatRow label="Lines Removed" aVal={a.linesRemoved} bVal={b.linesRemoved} format={fmt} />
            <StatRow label="Files Changed" aVal={aFiles} bVal={bFiles} format={fmt} />
            <StatRow label="Prompts" aVal={aPrompts} bVal={bPrompts} format={fmt} />
            <StatRow label="Tool Calls" aVal={a.toolCalls} bVal={b.toolCalls} format={fmt} />
            <StatRow label="Cost / Line" aVal={aCostPerLine} bVal={bCostPerLine} format={(n) => `$${n.toFixed(4)}`} inverse />
            <StatRow label="Tokens / Line" aVal={aTokensPerLine} bVal={bTokensPerLine} format={(n) => n.toFixed(1)} inverse />
          </tbody>
        </table>
      </div>

      {/* Side-by-side prompt comparison */}
      {(aPrompts > 0 || bPrompts > 0) && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
            <MessageSquare className="w-4 h-4" /> Prompts Side by Side
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {/* Session A prompts */}
            <div className="space-y-2">
              {a.promptChanges?.sort((x, y) => x.promptIndex - y.promptIndex).map((p, i) => (
                <div key={i} className="card p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-medium text-indigo-400">Turn {p.promptIndex + 1}</span>
                    <span className="text-[10px] text-gray-600">
                      {p.filesChanged?.length || 0} files
                    </span>
                  </div>
                  <p className="text-xs text-gray-300 line-clamp-3">{p.promptText || '(no prompt text)'}</p>
                </div>
              )) || <p className="text-xs text-gray-600">No prompts recorded</p>}
            </div>
            {/* Session B prompts */}
            <div className="space-y-2">
              {b.promptChanges?.sort((x, y) => x.promptIndex - y.promptIndex).map((p, i) => (
                <div key={i} className="card p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-medium text-indigo-400">Turn {p.promptIndex + 1}</span>
                    <span className="text-[10px] text-gray-600">
                      {p.filesChanged?.length || 0} files
                    </span>
                  </div>
                  <p className="text-xs text-gray-300 line-clamp-3">{p.promptText || '(no prompt text)'}</p>
                </div>
              )) || <p className="text-xs text-gray-600">No prompts recorded</p>}
            </div>
          </div>
        </div>
      )}

      {/* Files comparison */}
      <div>
        <h2 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
          <FileCode className="w-4 h-4" /> Files Changed
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="card p-3">
            <div className="space-y-1">
              {a.filesChanged?.split('\n').filter(Boolean).map((f, i) => (
                <div key={i} className="text-xs font-mono text-gray-400 truncate">{f}</div>
              )) || <p className="text-xs text-gray-600">No files</p>}
            </div>
          </div>
          <div className="card p-3">
            <div className="space-y-1">
              {b.filesChanged?.split('\n').filter(Boolean).map((f, i) => (
                <div key={i} className="text-xs font-mono text-gray-400 truncate">{f}</div>
              )) || <p className="text-xs text-gray-600">No files</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
