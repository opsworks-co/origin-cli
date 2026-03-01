import React, { useRef, useEffect } from 'react';

interface Message {
  role: string;
  content: string;
}

interface SessionReplayProps {
  transcript: Message[];
}

export default function SessionReplay({ transcript }: SessionReplayProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  if (!transcript || transcript.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        No transcript available
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto h-full">
      {transcript.map((msg, i) => {
        const isHuman = msg.role === 'human' || msg.role === 'user';
        return (
          <div
            key={i}
            className={`flex ${isHuman ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                isHuman
                  ? 'bg-indigo-600 text-white rounded-br-md'
                  : 'bg-gray-800 text-gray-200 rounded-bl-md'
              }`}
            >
              <p className="text-[10px] font-medium uppercase tracking-wider mb-1 opacity-60">
                {isHuman ? 'Human' : 'Assistant'}
              </p>
              {msg.content}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
