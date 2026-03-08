import { useState, useRef, useEffect } from 'react';
import * as api from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface AskAuthorPanelProps {
  sessionId: string;
  onClose: () => void;
  /** Pre-fill a question about a specific file/line (from AI Blame view) */
  initialContext?: {
    file?: string;
    lineNumber?: number;
    lineContent?: string;
    promptIndex?: number;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AskAuthorPanel({
  sessionId,
  onClose,
  initialContext,
}: AskAuthorPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build initial question from context
  useEffect(() => {
    if (initialContext) {
      if (initialContext.file && initialContext.lineNumber) {
        setInput(
          `Why was line ${initialContext.lineNumber} in ${initialContext.file} written this way? The line is: ${initialContext.lineContent}`,
        );
      } else if (initialContext.file) {
        setInput(`What changes were made to ${initialContext.file} and why?`);
      } else if (initialContext.promptIndex !== undefined) {
        setInput(`What was the reasoning behind prompt #${initialContext.promptIndex + 1}?`);
      }
    }
    inputRef.current?.focus();
  }, [initialContext]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const userMessage: Message = { role: 'user', content: question };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError('');

    try {
      // Build context from initialContext if first message
      const context =
        messages.length === 0 && initialContext
          ? {
              file: initialContext.file,
              promptIndex: initialContext.promptIndex,
            }
          : undefined;

      // Send conversation history for multi-turn
      const conversationHistory =
        messages.length > 0
          ? [...messages, userMessage].map((m) => ({
              role: m.role,
              content: m.content,
            }))
          : undefined;

      const result = await api.askSessionAuthor(sessionId, {
        question: conversationHistory ? undefined : question,
        context,
        messages: conversationHistory,
      });

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.answer },
      ]);
    } catch (err: any) {
      setError(err.message || 'Failed to get response');
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 border-l border-gray-800">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3 flex-shrink-0">
        <span className="text-base">&#128172;</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-200">Ask the Author</h3>
          <p className="text-xs text-gray-500 truncate">
            Ask questions about why code was written
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors text-lg"
        >
          &times;
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
        {messages.length === 0 && !loading && (
          <div className="text-center py-8">
            <p className="text-3xl mb-3">&#129302;</p>
            <p className="text-sm text-gray-400">Ask a question about this coding session</p>
            <div className="mt-4 space-y-2">
              <SuggestionChip
                text="Why was this approach chosen?"
                onClick={(t) => setInput(t)}
              />
              <SuggestionChip
                text="What trade-offs were considered?"
                onClick={(t) => setInput(t)}
              />
              <SuggestionChip
                text="Summarize the key decisions made"
                onClick={(t) => setInput(t)}
              />
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-indigo-600/30 text-indigo-100 border border-indigo-700/30'
                  : 'bg-gray-800 text-gray-300 border border-gray-700/30'
              }`}
            >
              {msg.role === 'assistant' ? (
                <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap">
                  {msg.content}
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 rounded-lg px-3 py-2 border border-gray-700/30">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <div className="animate-spin rounded-full h-3 w-3 border-b border-indigo-400" />
                Thinking...
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="px-4 py-3 border-t border-gray-800 flex gap-2 flex-shrink-0"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this session..."
          className="input flex-1 text-sm"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="btn-primary text-sm whitespace-nowrap px-4"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SuggestionChip({
  text,
  onClick,
}: {
  text: string;
  onClick: (text: string) => void;
}) {
  return (
    <button
      onClick={() => onClick(text)}
      className="block w-full text-left text-xs text-gray-400 hover:text-gray-200 bg-gray-800/50 hover:bg-gray-800 rounded-lg px-3 py-2 transition-colors"
    >
      {text}
    </button>
  );
}
