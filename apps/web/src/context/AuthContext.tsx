import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { User, Membership } from '../api';
import { setActiveOrgId as persistActiveOrg } from '../api/_client';
import { safeRemoveItem } from '../utils/safe-storage';

interface AuthState {
  user: User | null;
  memberships: Membership[];
  activeOrgId: string | null;
  activeOrg: Membership | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, orgName: string, orgSlug: string) => Promise<void>;
  registerDeveloper: (email: string, password: string, name: string) => Promise<void>;
  setSession: (token: string, user: User) => void;
  updateUser: (u: User) => void;
  logout: () => void;
  switchOrg: (orgId: string) => Promise<void>;
  createOrg: (name: string, slug?: string) => Promise<Membership>;
  refreshMemberships: () => Promise<void>;
  // Hand off a server auth response wholesale — used by OAuth callback and
  // invite-accept flows that authenticate outside the login/register hooks.
  applyAuthResponse: (res: api.AuthResponse) => void;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

function pickActiveOrg(memberships: Membership[], activeOrgId: string | null): Membership | null {
  if (!memberships.length) return null;
  if (activeOrgId) {
    const m = memberships.find((x) => x.orgId === activeOrgId);
    if (m) return m;
  }
  return memberships[0];
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Apply a server response: update the user/memberships state and pin the
  // active org both in localStorage (for the request client) and in this
  // provider's state (for the picker). Also handles the case where the
  // server returned a different active org than what we had pinned (e.g.
  // we switched in another tab or the previously-active org was deleted).
  const applyAuth = useCallback((payload: api.AuthResponse | null) => {
    if (!payload) {
      setUser(null);
      setMemberships([]);
      setActiveOrgIdState(null);
      persistActiveOrg(null);
      return;
    }
    setUser(payload.user);
    setMemberships(payload.memberships || []);
    const chosen = payload.activeOrgId
      || (payload.memberships && payload.memberships[0]?.orgId)
      || null;
    setActiveOrgIdState(chosen);
    persistActiveOrg(chosen);
  }, []);

  // On mount, hit /me. The cookie auth carries the JWT; the X-Origin-Org
  // header (set by _client.ts from localStorage) tells the server which
  // org we want active for this session. Server reconciles + returns the
  // membership list.
  //
  // Silent retry: a single transient 401 from /me (deploy window, network
  // blip, request raced ahead of the cookie roundtrip after redirect) used
  // to bounce the user to /login even though their cookie was still valid.
  // We now retry once after a small delay before treating the failure as
  // "not authenticated". Permanent failures still fall through to logout.
  useEffect(() => {
    let cancelled = false;
    const attempt = (retriesLeft: number) =>
      api
        .getMe()
        .then((r) => {
          if (!cancelled) applyAuth(r);
        })
        .catch((err: { status?: number } & Error) => {
          if (cancelled) return;
          const isAuthFailure = err?.status === 401 || /401|unauthor/i.test(err?.message || '');
          if (isAuthFailure && retriesLeft > 0) {
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                attempt(retriesLeft - 1).finally(resolve);
              }, 800);
            });
          }
          // Permanent failure — clear stale legacy token + org pin.
          safeRemoveItem('origin_token');
          persistActiveOrg(null);
        })
        .finally(() => {
          if (!cancelled && retriesLeft === 0) setLoading(false);
        });
    attempt(1).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [applyAuth]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const res = await api.login(email, password);
      applyAuth(res);
    } catch (err: any) {
      setError(err.message ?? 'Login failed');
      throw err;
    }
  }, [applyAuth]);

  const register = useCallback(
    async (email: string, password: string, name: string, orgName: string, orgSlug: string) => {
      setError(null);
      try {
        const res = await api.register(email, password, name, orgName, orgSlug);
        applyAuth(res);
        // Stash the auto-issued CLI token so the onboarding card can render
        // a prefilled `origin login` command without an extra round-trip.
        // sessionStorage clears on tab close — by design, since we never
        // get the plaintext back from the API after this response.
        if (res.apiKey) {
          try { sessionStorage.setItem('origin:onboarding-key', res.apiKey); } catch { /* ignore */ }
        }
      } catch (err: any) {
        setError(err.message ?? 'Registration failed');
        throw err;
      }
    },
    [applyAuth],
  );

  const registerDeveloper = useCallback(
    async (email: string, password: string, name: string): Promise<void> => {
      setError(null);
      try {
        const res = await api.registerDeveloper(email, password, name);
        applyAuth(res);
        if (res.apiKey) {
          try { sessionStorage.setItem('origin:onboarding-key', res.apiKey); } catch { /* ignore */ }
        }
      } catch (err: any) {
        setError(err.message ?? 'Registration failed');
        throw err;
      }
    },
    [applyAuth],
  );

  const setSession = useCallback((_token: string, userData: User) => {
    // Legacy entry point — used by OAuth callbacks before they were updated.
    // Keep them limping until refactored: drop existing memberships.
    setUser(userData);
  }, []);

  const updateUser = useCallback((u: User) => {
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    safeRemoveItem('origin_token');
    persistActiveOrg(null);
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => { /* noop */ });
    setUser(null);
    setMemberships([]);
    setActiveOrgIdState(null);
  }, []);

  // switchOrg: persist locally first so the next API request goes to the
  // new org, then tell the server (so the user's lastOrgId sticks across
  // browsers), then reload `/me` to pick up the freshly active context.
  const switchOrg = useCallback(async (orgId: string) => {
    if (orgId === activeOrgId) return;
    persistActiveOrg(orgId);
    setActiveOrgIdState(orgId);
    try {
      await api.setActiveOrg(orgId);
    } catch { /* non-fatal — header alone is enough for this session */ }
    // Hard reload so all in-flight queries re-run against the new org —
    // simpler and less error-prone than threading invalidation through
    // every consumer. Multi-org switching is a rare interaction.
    window.location.reload();
  }, [activeOrgId]);

  const refreshMemberships = useCallback(async () => {
    try {
      const list = await api.listMemberships();
      setMemberships(list);
      // If our currently-active org was removed (e.g. we just left it),
      // fall back to the first remaining membership.
      if (activeOrgId && !list.some((m) => m.orgId === activeOrgId)) {
        const next = list[0]?.orgId || null;
        setActiveOrgIdState(next);
        persistActiveOrg(next);
      }
    } catch { /* leave state untouched on transient failures */ }
  }, [activeOrgId]);

  const createOrgFn = useCallback(async (name: string, slug?: string): Promise<Membership> => {
    const created = await api.createOrg(name, slug);
    const newMembership: Membership = {
      orgId: created.orgId,
      name: created.name,
      slug: created.slug,
      type: created.type as 'team' | 'personal',
      role: created.role,
    };
    // Optimistically add + switch — server will confirm on next /me.
    setMemberships((prev) => [...prev, newMembership]);
    persistActiveOrg(created.orgId);
    setActiveOrgIdState(created.orgId);
    return newMembership;
  }, []);

  const activeOrg = pickActiveOrg(memberships, activeOrgId);

  return (
    <AuthContext.Provider
      value={{
        user,
        memberships,
        activeOrgId,
        activeOrg,
        loading,
        error,
        login,
        register,
        registerDeveloper,
        setSession,
        updateUser,
        logout,
        switchOrg,
        createOrg: createOrgFn,
        refreshMemberships,
        applyAuthResponse: applyAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
