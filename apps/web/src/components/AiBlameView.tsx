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
// Component
// ---------------------------------------------------------------------------

interface AiBlameViewProps {
  sessionId: string;
  filesChanged: string[];
  onAskAboutLine?: (file: string, lineNumber: number, content: string) => void;
}

export default function AiBlameView({ sessionId, filesChanged, onAskAboutLine }: AiBlameViewProps) {
  const [selectedFile, setSelectedFile] = useState<string>(filesChanged[0] || '');
  const [blameData, setBlameData] = useState<BlameResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hoveredPrompt, setHoveredPrompt] = useState<number | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<number | null>(null);

  // File search state
  const [fileSearch, setFileSearch] = useState('');
  const [fileDropdownOpen, setFileDropdownOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredFiles = useMemo(() => {
    if (!fileSearch) return filesChanged;
    const lower = fileSearch.toLowerCase();
    return filesChanged.filter((f) => f.toLowerCase().includes(lower));
  }, [filesChanged, fileSearch]);

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

  // Compute which prompts actually contributed to this file
  const activePrompts = useMemo(() => {
    if (!blameData) return [];
    const promptIndices = new Set(
      blameData.lines
        .filter((l) => l.attribution)
        .map((l) => l.attribution!.promptIndex),
    );
    return blameData.prompts.filter((p) => promptIndices.has(p.promptIndex));
  }, [blameData]);

  // Count lines per prompt
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

  // Count human vs AI lines
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

  const shortenPath = (p: string) => {
    const parts = p.split('/');
    if (parts.length <= 3) return p;
    return '.../' + parts.slice(-3).join('/');
  };

  const getFileName = (p: string) => {
    const parts = p.split('/');
    return parts[parts.length - 1];
  };

  const handleSelectFile = (file: string) => {
    setSelectedFile(file);
    setFileDropdownOpen(false);
    setFileSearch('');
  };

  if (filesChanged.length === 0) {
    return (
      <div className="p-5 text-center py-12">
        <p className="text-gray-500 text-sm">No files changed in this session.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3 flex-shrink-0">
        <label className="text-xs text-gray-500 whitespace-nowrap">File:</label>

        {/* Searchable file picker */}
        <div className="relative flex-1 max-w-lg">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={fileDropdownOpen ? fileSearch : shortenPath(selectedFile)}
              onChange={(e) => setFileSearch(e.target.value)}
              onFocus={() => {
                setFileDropdownOpen(true);
                setFileSearch('');
              }}
              onBlur={() => setTimeout(() => setFileDropdownOpen(false), 200)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFileDropdownOpen(false);
                  setFileSearch('');
                  searchInputRef.current?.blur();
                } else if (e.key === 'Enter' && filteredFiles.length > 0) {
                  handleSelectFile(filteredFiles[0]);
                  searchInputRef.current?.blur();
                }
              }}
              placeholder="Search files..."
              className="input text-sm w-full pl-8"
            />
          </div>

          {fileDropdownOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-20 max-h-72 overflow-y-auto">
              {filteredFiles.length === 0 && (
                <p className="px-3 py-3 text-sm text-gray-600 text-center">No files match "{fileSearch}"</p>
              )}
              {filteredFiles.map((f) => (
                <button
                  key={f}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-800 transition-colors border-b border-gray-800/30 last:border-b-0 ${
                    f === selectedFile ? 'text-indigo-400 bg-gray-800/50' : 'text-gray-300'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectFile(f);
                  }}
                >
                  <span className="font-medium">{getFileName(f)}</span>
                  <span className="text-gray-600 text-xs ml-2 block truncate">{shortenPath(f)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {blameData && (
          <div className="flex items-center gap-3 ml-auto text-xs text-gray-500 shrink-0">
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
          </div>
        )}
      </div>

      {/* Prompt legend — always show prompt text */}
      {activePrompts.length > 0 && (
        <div className="border-b border-gray-800 flex-shrink-0 max-h-[40vh] overflow-y-auto">
          {activePrompts.map((p) => {
            const color = getPromptColor(p.promptIndex);
            const lineCount = linesPerPrompt.get(p.promptIndex) || 0;
            const isHovered = hoveredPrompt === p.promptIndex;
            const isCollapsed = expandedPrompt !== null && expandedPrompt !== p.promptIndex;
            const promptPreview = p.promptText.length > 120 ? p.promptText.slice(0, 120) + '...' : p.promptText;

            return (
              <div
                key={p.promptIndex}
                className={`px-4 py-2.5 border-b border-gray-800/40 last:border-b-0 transition-all cursor-pointer ${
                  isHovered ? `${color.bg}` : isCollapsed ? 'opacity-60 hover:opacity-100' : 'hover:bg-gray-800/30'
                }`}
                onMouseEnter={() => setHoveredPrompt(p.promptIndex)}
                onMouseLeave={() => setHoveredPrompt(null)}
                onClick={() =>
                  setExpandedPrompt(expandedPrompt === p.promptIndex ? null : p.promptIndex)
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
                      {expandedPrompt === p.promptIndex ? p.promptText : promptPreview}
                    </p>
                    {expandedPrompt === p.promptIndex && p.filesChanged.length > 0 && (
                      <p className="text-[10px] text-gray-600 mt-1.5">
                        Files: {p.filesChanged.map(shortenPath).join(', ')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Content area */}
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
              No AI-attributed lines found for this file.
            </p>
            <p className="text-gray-600 text-xs mt-1">
              This file may not have been modified by any prompt in this session.
            </p>
          </div>
        )}

        {!loading && !error && blameData && blameData.lines.length > 0 && (
          <div className="font-mono text-xs">
            {blameData.lines.map((line, idx) => {
              // Gap marker row
              if (line.isGap) {
                return (
                  <div
                    key={`gap-${idx}`}
                    className="flex items-center border-l-2 border-l-transparent bg-gray-900/50 text-gray-600"
                  >
                    <span className="w-12 px-2 py-1 shrink-0 border-r border-gray-800/50 text-center">
                      ⋯
                    </span>
                    <span className="w-20 px-2 py-1 shrink-0 text-right text-[10px]" />
                    <span className="flex-1 px-3 py-1 text-[10px] italic">
                      {line.content}
                    </span>
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
                  } transition-colors group`}
                  onMouseEnter={() =>
                    attr && setHoveredPrompt(attr.promptIndex)
                  }
                  onMouseLeave={() => setHoveredPrompt(null)}
                >
                  {/* Line number */}
                  <span
                    className={`w-12 text-right px-2 py-0.5 select-none shrink-0 border-r border-gray-800/50 ${
                      isHumanLine ? 'text-gray-700' : 'text-gray-600'
                    }`}
                  >
                    {line.lineNumber}
                  </span>

                  {/* Attribution badge */}
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

                  {/* Code content */}
                  <pre
                    className={`flex-1 px-3 py-0.5 whitespace-pre overflow-x-auto ${
                      isHumanLine ? 'text-gray-500' : 'text-gray-300'
                    }`}
                  >
                    {line.content}
                  </pre>

                  {/* Ask button (shows on hover) */}
                  {onAskAboutLine && attr && (
                    <button
                      className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-indigo-400 px-2 py-0.5 text-[10px] transition-opacity shrink-0"
                      onClick={() =>
                        onAskAboutLine(
                          blameData.file,
                          line.lineNumber,
                          line.content,
                        )
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
  );
}
