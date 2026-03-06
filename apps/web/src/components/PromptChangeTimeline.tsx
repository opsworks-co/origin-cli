import { useState } from 'react';
import type { PromptChange } from '../api';

// File extension → icon mapping
function fileIcon(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return '🟦';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return '🟨';
  if (path.endsWith('.css') || path.endsWith('.scss')) return '🎨';
  if (path.endsWith('.json')) return '📋';
  if (path.endsWith('.md')) return '📝';
  if (path.endsWith('.prisma')) return '🗄️';
  if (path.endsWith('.html')) return '🌐';
  if (path.endsWith('.py')) return '🐍';
  if (path.endsWith('.go')) return '🔷';
  if (path.endsWith('.rs')) return '🦀';
  return '📄';
}

// Shorten long file paths: show last 2-3 segments
function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

interface PromptChangeTimelineProps {
  promptChanges: PromptChange[];
}

export default function PromptChangeTimeline({ promptChanges }: PromptChangeTimelineProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (!promptChanges || promptChanges.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <div className="text-3xl mb-2">🔗</div>
          <p>No prompt-to-change mappings available</p>
          <p className="text-xs mt-1 text-gray-600">
            This data is captured when using the Origin CLI hooks
          </p>
        </div>
      </div>
    );
  }

  const totalFiles = new Set(promptChanges.flatMap((pc) => pc.filesChanged)).size;

  return (
    <div className="px-4 py-3">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm text-gray-400 pb-3 border-b border-gray-800 mb-4">
        <span>{promptChanges.length} prompt{promptChanges.length !== 1 ? 's' : ''}</span>
        <span>{totalFiles} file{totalFiles !== 1 ? 's' : ''} modified</span>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-800" />

        <div className="space-y-4">
          {promptChanges.map((pc) => (
            <div key={pc.promptIndex} className="relative pl-10">
              {/* Timeline dot */}
              <div className="absolute left-2.5 top-1.5 w-3 h-3 rounded-full bg-indigo-500 border-2 border-gray-950" />

              {/* Prompt card */}
              <div className="bg-gray-800/50 rounded-lg border border-gray-800 overflow-hidden">
                {/* Prompt header */}
                <button
                  onClick={() =>
                    setExpanded((prev) => ({
                      ...prev,
                      [pc.promptIndex]: !prev[pc.promptIndex],
                    }))
                  }
                  className="w-full text-left px-3 py-2 hover:bg-gray-800/80 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <span className="flex-shrink-0 bg-indigo-600/20 text-indigo-400 text-xs font-mono px-1.5 py-0.5 rounded mt-0.5">
                      {pc.promptIndex + 1}
                    </span>
                    <p className="text-sm text-gray-300 line-clamp-2 flex-1">
                      {pc.promptText || '(empty prompt)'}
                    </p>
                    <span className="text-gray-600 text-xs flex-shrink-0">
                      {expanded[pc.promptIndex] ? '▼' : '▶'}
                    </span>
                  </div>
                </button>

                {/* Files changed */}
                <div
                  className={`border-t border-gray-800 ${
                    expanded[pc.promptIndex] ? '' : 'max-h-0 overflow-hidden border-t-0'
                  }`}
                >
                  {pc.filesChanged.length > 0 ? (
                    <div className="px-3 py-2 space-y-1">
                      {pc.filesChanged.map((file) => (
                        <div
                          key={file}
                          className="flex items-center gap-2 text-xs font-mono text-gray-400"
                        >
                          <span>{fileIcon(file)}</span>
                          <span className="truncate" title={file}>
                            {shortenPath(file)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-xs text-gray-600">
                      No file modifications
                    </div>
                  )}
                </div>

                {/* Collapsed file count */}
                {!expanded[pc.promptIndex] && pc.filesChanged.length > 0 && (
                  <div className="px-3 py-1.5 border-t border-gray-800 text-xs text-gray-500">
                    {pc.filesChanged.length} file{pc.filesChanged.length !== 1 ? 's' : ''} modified
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
