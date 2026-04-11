import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { User } from '../api';
import { safeRemoveItem } from '../utils/safe-storage';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, orgName: string, orgSlug: string) => Promise<void>;
  registerDeveloper: (email: string, password: string, name: string) => Promise<void>;
  setSession: (token: string, user: User) => void;
  updateUser: (u: User) => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restore session on mount. Auth is now carried by the httpOnly
  // `origin_auth` cookie (set by the server on login/register) — we always
  // try `getMe()` unconditionally, and the browser attaches the cookie for
  // us. Any legacy `origin_token` still in localStorage is also sent via
  // the Bearer header fallback in _client.ts and cleared on 401.
  useEffect(() => {
    api
      .getMe()
      .then((u) => setUser(u))
      .catch(() => {
        // Not authenticated — clear any stale legacy token so the fallback
        // header stops being sent on subsequent requests.
        safeRemoveItem('origin_token');
      })
      .finally(() => setLoading(false));
  }, []);

  // Login / register / setSession no longer touch localStorage — the server
  // sets the `origin_auth` httpOnly cookie on the same response, which the
  // browser attaches automatically on future requests. Keeping the token out
  // of JS land defends against XSS token theft.
  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const res = await api.login(email, password);
      setUser(res.user);
    } catch (err: any) {
      setError(err.message ?? 'Login failed');
      throw err;
    }
  }, []);

  const register = useCallback(
    async (email: string, password: string, name: string, orgName: string, orgSlug: string) => {
      setError(null);
      try {
        const res = await api.register(email, password, name, orgName, orgSlug);
        setUser(res.user);
      } catch (err: any) {
        setError(err.message ?? 'Registration failed');
        throw err;
      }
    },
    [],
  );

  const registerDeveloper = useCallback(
    async (email: string, password: string, name: string): Promise<void> => {
      setError(null);
      try {
        const res = await api.registerDeveloper(email, password, name);
        setUser(res.user);
      } catch (err: any) {
        setError(err.message ?? 'Registration failed');
        throw err;
      }
    },
    [],
  );

  const setSession = useCallback((_token: string, userData: User) => {
    setUser(userData);
  }, []);

  const updateUser = useCallback((u: User) => {
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    safeRemoveItem('origin_token');
    // Fire-and-forget: clear the httpOnly session cookie server-side.
    // We don't await because logout should feel instant; if the request
    // fails the cookie will still expire on its own.
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => { /* noop */ });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, login, register, registerDeveloper, setSession, updateUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
