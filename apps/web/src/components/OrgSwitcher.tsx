import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Check, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Compact org-context picker that lives in the sidebar/header. Lists all of
// the user's memberships, shows which is active, and lets them switch
// (which reloads the page so all data refetches under the new org), create
// a new team org, or jump to the invite-acceptance flow.

export default function OrgSwitcher() {
  const { activeOrg, memberships, switchOrg, createOrg } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  if (!activeOrg) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createOrg(newName.trim());
      // createOrg in AuthContext pins the new org as active; reload to
      // refetch all data under the new context.
      window.location.reload();
    } catch (err: any) {
      setError(err?.message || 'Failed to create org');
      setSubmitting(false);
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-fuchsia-500/30 to-violet-600/20 ring-1 ring-fuchsia-500/30 flex items-center justify-center text-fuchsia-600 dark:text-fuchsia-300 text-[12px] font-semibold flex-shrink-0">
          {activeOrg.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100 truncate leading-tight">
            {activeOrg.name}
          </p>
          <p className="text-[10px] text-gray-500 dark:text-gray-500 truncate leading-tight">
            <span className="capitalize">{activeOrg.role.toLowerCase()}</span>{activeOrg.type === 'personal' ? ' · personal' : ''}
          </p>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] shadow-xl overflow-hidden z-50">
          {!creating && (
            <>
              <ul className="max-h-64 overflow-y-auto">
                {memberships.map((m) => {
                  const isActive = m.orgId === activeOrg.orgId;
                  return (
                    <li key={m.orgId}>
                      <button
                        type="button"
                        onClick={() => {
                          if (!isActive) switchOrg(m.orgId);
                          else setOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors ${isActive ? 'bg-black/[0.03] dark:bg-white/[0.03]' : ''}`}
                      >
                        <div className="w-5 h-5 rounded bg-gradient-to-br from-fuchsia-500/25 to-violet-600/15 ring-1 ring-fuchsia-500/25 flex items-center justify-center text-fuchsia-600 dark:text-fuchsia-300 text-[10px] font-semibold flex-shrink-0">
                          {m.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-medium text-gray-800 dark:text-gray-100 truncate leading-tight">{m.name}</p>
                          <p className="text-[10px] text-gray-500 dark:text-gray-500 truncate leading-tight">
                            {m.role.toLowerCase()}{m.type === 'personal' ? ' · personal' : ''}
                          </p>
                        </div>
                        {isActive && <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t border-gray-200 dark:border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => { setCreating(true); setError(null); }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-[12px] text-gray-700 dark:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-gray-400" />
                  Create new org
                </button>
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate('/accept-invite'); }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-[12px] text-gray-700 dark:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                >
                  <Users className="w-3.5 h-3.5 text-gray-400" />
                  Join with invite link
                </button>
              </div>
            </>
          )}
          {creating && (
            <form onSubmit={handleCreate} className="p-2.5 space-y-2">
              <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400">
                Org name
              </label>
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Acme Co"
                className="w-full text-[12px] px-2 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {error && <p className="text-[11px] text-red-500">{error}</p>}
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  disabled={submitting || !newName.trim()}
                  className="flex-1 text-[12px] font-medium px-2 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(''); setError(null); }}
                  className="flex-1 text-[12px] px-2 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] text-gray-700 dark:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
