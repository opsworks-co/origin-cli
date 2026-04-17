import { useState, useEffect, useRef } from 'react';
import { X, Plus } from 'lucide-react';

// ── Tag input component ─────────────────────────────────────────────────────

export function TagEditor({
  tags,
  onSave,
}: {
  tags: string[];
  onSave: (tags: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [localTags, setLocalTags] = useState(tags);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setLocalTags(tags), [tags]);

  const addTag = () => {
    const t = draft.trim().toLowerCase();
    if (t && !localTags.includes(t)) {
      const next = [...localTags, t];
      setLocalTags(next);
      onSave(next);
    }
    setDraft('');
  };

  const removeTag = (tag: string) => {
    const next = localTags.filter((t) => t !== tag);
    setLocalTags(next);
    onSave(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {localTags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20"
        >
          {t}
          <button onClick={() => removeTag(t)} className="hover:text-red-400 ml-0.5">
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { addTag(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(''); }
          }}
          onBlur={() => { if (draft.trim()) addTag(); setEditing(false); }}
          className="w-16 bg-transparent text-[10px] text-gray-300 outline-none border-b border-gray-600 px-0.5 py-0.5"
          placeholder="tag..."
          autoFocus
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="p-0.5 rounded hover:bg-gray-700 text-gray-600 hover:text-gray-400 transition-colors"
          title="Add tag"
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
