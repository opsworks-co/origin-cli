import { useState, useMemo } from 'react';
import type { SessionDiff, PromptChange } from '../api';

interface DiffFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  hunks: string[];
}

function parseDiff(raw: string): DiffFile[] {
  if (!raw) return [];

  const files: DiffFile[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');

    // Extract file path from "a/path b/path" header
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const path = headerMatch ? headerMatch[2] : lines[0] || 'unknown';

    let linesAdded = 0;
    let linesRemoved = 0;

    // Collect all lines after the header
    const hunkLines: string[] = [];
    let inHunk = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('@@')) {
        inHunk = true;
        hunkLines.push(line);
      } else if (inHunk) {
        hunkLines.push(line);

        if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
        if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
      }
    }

    files.push({
      path,
      linesAdded,
      linesRemoved,
      hunks: hunkLines,
    });
  }

  return files;
}

// Shorten long file paths
function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

interface DiffViewerProps {
  sessionDiff?: SessionDiff | null;
  promptChanges?: PromptChange[];
}

export default function DiffViewer({ sessionDiff, promptChanges }: DiffViewerProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedPrompt, setSelectedPrompt] = useState<number | 'all' | 'git'>('all');

  // Prompts with actual diffs
  const promptsWithDiffs = useMemo(
    () => (promptChanges || []).filter((pc) => pc.diff && pc.diff.length > 0),
    [promptChanges],
  );

  const hasPromptDiffs = promptsWithDiffs.length > 0;
  const hasGitDiff = !!(sessionDiff?.diff);

  // Current diff to display
  const currentDiff = useMemo(() => {
    if (selectedPrompt === 'git' && hasGitDiff) {
      return sessionDiff!.diff;
    }
    if (selectedPrompt === 'all') {
      // Combine all prompt diffs
      return promptsWithDiffs.map((pc) => pc.diff).join('\n');
    }
    if (typeof selectedPrompt === 'number') {
      const pc = promptsWithDiffs.find((p) => p.promptIndex === selectedPrompt);
      return pc?.diff || '';
    }
    return '';
  }, [selectedPrompt, promptsWithDiffs, sessionDiff, hasGitDiff]);

  const files = useMemo(() => parseDiff(currentDiff), [currentDiff]);

  // Total stats
  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);

  // Empty state
  if (!hasPromptDiffs && !hasGitDiff) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <div className="text-3xl mb-2">📄</div>
          <p>No code changes detected in this session</p>
          <p className="text-xs mt-1 text-gray-600">
            Diffs are captured from Edit/Write tool calls in the transcript
          </p>
        </div>
      </div>
    );
  }

  const toggleFile = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Prompt selector bar */}
      <div className="px-4 py-2 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {hasPromptDiffs && (
            <button
              onClick={() => { setSelectedPrompt('all'); setCollapsed({}); }}
              className={`px-2.5 py-1 text-xs rounded-lg whitespace-nowrap transition-colors ${
                selectedPrompt === 'all'
                  ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >
              All prompts
            </button>
          )}
          {hasGitDiff && (
            <button
              onClick={() => { setSelectedPrompt('git'); setCollapsed({}); }}
              className={`px-2.5 py-1 text-xs rounded-lg whitespace-nowrap transition-colors ${
                selectedPrompt === 'git'
                  ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >
              Git diff
            </button>
          )}
          {hasPromptDiffs && (
            <div className="w-px h-4 bg-gray-800 mx-1" />
          )}
          {promptsWithDiffs.map((pc) => (
            <button
              key={pc.promptIndex}
              onClick={() => { setSelectedPrompt(pc.promptIndex); setCollapsed({}); }}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg whitespace-nowrap transition-colors ${
                selectedPrompt === pc.promptIndex
                  ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
              title={pc.promptText}
            >
              <span className="bg-gray-800 text-gray-400 px-1 py-0.5 rounded font-mono text-[10px]">
                {pc.promptIndex + 1}
              </span>
              <span className="max-w-[120px] truncate">
                {pc.promptText || `Prompt ${pc.promptIndex + 1}`}
              </span>
              <span className="text-gray-600">
                {pc.filesChanged.length}f
              </span>
            </button>
          ))}
        </div>

        {/* Show selected prompt text */}
        {typeof selectedPrompt === 'number' && (() => {
          const pc = promptsWithDiffs.find((p) => p.promptIndex === selectedPrompt);
          if (!pc) return null;
          return (
            <div className="mt-2 bg-gray-800/50 rounded-lg px-3 py-2 text-sm text-gray-300 line-clamp-2">
              <span className="text-indigo-400 font-mono text-xs mr-2">#{pc.promptIndex + 1}</span>
              {pc.promptText || '(empty prompt)'}
            </div>
          );
        })()}
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {/* Summary bar */}
        <div className="flex items-center gap-4 text-sm text-gray-400 pb-2 border-b border-gray-800">
          <span>{files.length} file{files.length !== 1 ? 's' : ''} changed</span>
          <span className="text-green-400">+{totalAdded}</span>
          <span className="text-red-400">-{totalRemoved}</span>
          {selectedPrompt === 'git' && sessionDiff?.commitShas && sessionDiff.commitShas.length > 0 && (
            <span className="text-gray-500">
              {sessionDiff.commitShas.length} commit{sessionDiff.commitShas.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Truncation warning */}
        {selectedPrompt === 'git' && sessionDiff?.diffTruncated && (
          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded px-3 py-2 text-yellow-300 text-xs">
            Diff was truncated (showing first 500KB).
          </div>
        )}

        {files.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            No diff available for this selection
          </div>
        ) : (
          files.map((file, fileIdx) => (
            <div key={`${file.path}-${fileIdx}`} className="border border-gray-800 rounded overflow-hidden">
              {/* File header */}
              <button
                onClick={() => toggleFile(`${file.path}-${fileIdx}`)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-800 text-left text-sm transition-colors"
              >
                <span className="text-gray-500">{collapsed[`${file.path}-${fileIdx}`] ? '▶' : '▼'}</span>
                <span className="font-mono text-gray-300 flex-1 truncate">{shortenPath(file.path)}</span>
                <span className="text-green-400 text-xs">+{file.linesAdded}</span>
                <span className="text-red-400 text-xs">-{file.linesRemoved}</span>
              </button>

              {/* Diff content */}
              {!collapsed[`${file.path}-${fileIdx}`] && (
                <div className="overflow-x-auto">
                  <pre className="text-xs leading-5">
                    {file.hunks.map((line, i) => {
                      let className = 'px-3 ';

                      if (line.startsWith('@@')) {
                        className += 'bg-blue-900/20 text-blue-400';
                      } else if (line.startsWith('+')) {
                        className += 'bg-green-900/20 text-green-300';
                      } else if (line.startsWith('-')) {
                        className += 'bg-red-900/20 text-red-300';
                      } else {
                        className += 'text-gray-500';
                      }

                      return (
                        <div key={i} className={className}>
                          {line}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
