import { useEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Plus, Check, Users, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// GitHub-style account switcher. The button shows the active org context;
// the dropdown opens with "signed in as <user>" at the top, then the list
// of orgs to switch between, then account actions (create/join/sign out).
// Replaces the old separate user row that used to live below the switcher.

export default function OrgSwitcher() {
  const { user, activeOrg, memberships, switchOrg, createOrg, logout } = useAuth();
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

  // Solo developers (no team org, no memberships) still need a place in the
  // sidebar to see who they're signed in as and to sign out — the parent
  // layouts collapsed the user row into this component, so returning null
  // here would leave them with an empty footer.
  if (!user) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createOrg(newName.trim());
      // Brand-new team org → walk the admin through the same wizard a
      // solo signup gets, so they don't land on an empty dashboard.
      // ?from=team flag bypasses the developer-only redirect inside
      // /onboarding (the user just got accountType=org by creating an org).
      window.location.href = '/onboarding?from=team';
    } catch (err: any) {
      setError(err?.message || 'Failed to create org');
      setSubmitting(false);
    }
  }

  const roleBadgeStyle: Record<string, string> = {
    OWNER:  'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30',
    ADMIN:  'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    MEMBER: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
    VIEWER: 'bg-gray-500/15 text-gray-300 ring-gray-500/30',
  };
  const roleStyle = roleBadgeStyle[activeOrg?.role ?? ''] ?? roleBadgeStyle.VIEWER;
  // Fallbacks for solo accounts with no membership: show the user's own
  // identity in the button instead of the org chip.
  const displayName = activeOrg?.name || user.name || user.email;
  const avatarLetter = (activeOrg?.name || user.name || user.email).charAt(0).toUpperCase();

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`group w-full flex items-center gap-2.5 px-2.5 py-2 text-left transition-colors rounded-lg border ${
          open
            ? 'bg-fuchsia-500/[0.06] dark:bg-fuchsia-500/[0.06] border-fuchsia-500/30 dark:border-fuchsia-500/25'
            : 'border-gray-200/60 dark:border-white/[0.06] hover:bg-black/[0.03] dark:hover:bg-white/[0.03] hover:border-gray-300 dark:hover:border-white/[0.10]'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {/* Org avatar with subtle ring on hover/open */}
        <div className={`relative w-7 h-7 rounded-md bg-gradient-to-br from-fuchsia-500/30 to-violet-600/20 ring-1 flex items-center justify-center text-fuchsia-600 dark:text-fuchsia-300 text-[12px] font-semibold flex-shrink-0 transition-all ${
          open ? 'ring-fuchsia-400/60 shadow-[0_0_0_3px_rgba(217,70,239,0.08)]' : 'ring-fuchsia-500/30 group-hover:ring-fuchsia-400/50'
        }`}>
          {avatarLetter}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100 truncate leading-tight">
              {displayName}
            </p>
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            {activeOrg ? (
              <>
                <span className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-px rounded ring-1 ring-inset ${roleStyle}`}>
                  {activeOrg.role.toLowerCase()}
                </span>
                {activeOrg.type === 'personal' && (
                  <span className="text-[9px] uppercase tracking-wider text-gray-500 dark:text-gray-600">· personal</span>
                )}
              </>
            ) : (
              // Solo dev account — no org chip; surface the email under the
              // name so the user still sees who they're signed in as.
              <span className="text-[10px] text-gray-500 dark:text-gray-500 truncate leading-tight">
                {user.email}
              </span>
            )}
          </div>
        </div>

        {/* Up/down chevrons — universal "switcher" affordance (Vercel/Linear/shadcn) */}
        <ChevronsUpDown className={`w-3.5 h-3.5 flex-shrink-0 transition-colors ${
          open ? 'text-fuchsia-400' : 'text-gray-400 group-hover:text-gray-200'
        }`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] shadow-xl overflow-hidden z-50">
          {!creating && (
            <>
              {/* GitHub-style "Signed in as …" header — surfaces the user
                  identity that used to occupy its own sidebar row. */}
              {user && (
                <div className="px-2.5 py-2 border-b border-gray-200 dark:border-white/[0.08]">
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-500">Signed in as</p>
                  <p className="text-[12px] font-medium text-gray-800 dark:text-gray-100 truncate leading-tight mt-0.5">{user.name || user.email}</p>
                  {user.name && (
                    <p className="text-[10px] text-gray-500 dark:text-gray-500 truncate leading-tight">{user.email}</p>
                  )}
                </div>
              )}
              <ul className="max-h-64 overflow-y-auto">
                {memberships.map((m) => {
                  const isActive = m.orgId === activeOrg?.orgId;
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
              <div className="border-t border-gray-200 dark:border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => { setOpen(false); logout(); navigate('/login'); }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-[12px] text-gray-700 dark:text-gray-200 hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5 text-gray-400" />
                  Sign out
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
