import React from 'react';

export function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="rounded-lg overflow-hidden border border-gray-700 my-3">
      {title && (
        <div className="bg-gray-800 px-4 py-2 text-xs text-gray-400 border-b border-gray-700 font-mono">
          {title}
        </div>
      )}
      <pre className="bg-gray-900 px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

export function H2({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h2 id={id} className="text-xl font-bold text-gray-100 mt-8 mb-3">{children}</h2>;
}

export function H3({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h3 id={id} className="text-lg font-semibold text-gray-200 mt-6 mb-2">{children}</h3>;
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
}

export function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-sm text-gray-400 leading-relaxed flex items-start gap-2">
      <span className="text-indigo-400 mt-1 flex-shrink-0">&bull;</span>
      <span>{children}</span>
    </li>
  );
}

export function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 mb-6">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-indigo-400 font-bold text-sm">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-gray-200 mb-1">{title}</h4>
        <div className="text-sm text-gray-400 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export function Callout({ type, children }: { type: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
  const styles = {
    info: 'bg-blue-900/20 border-blue-800 text-blue-300',
    warning: 'bg-amber-900/20 border-amber-800 text-amber-300',
    tip: 'bg-green-900/20 border-green-800 text-green-300',
  };
  const icons = { info: 'i', warning: '!', tip: '*' };
  return (
    <div className={`rounded-lg border px-4 py-3 my-4 text-sm ${styles[type]}`}>
      <span className="font-bold mr-2">{icons[type]}</span>
      {children}
    </div>
  );
}
