import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { User } from '../api';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, orgName: string, orgSlug: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restore session on mount
  useEffect(() => {
    const token = localStorage.getItem('origin_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .getMe()
      .then((u) => setUser(u))
      .catch(() => {
        localStorage.removeItem('origin_token');
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const res = await api.login(email, password);
      localStorage.setItem('origin_token', res.token);
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
        localStorage.setItem('origin_token', res.token);
        setUser(res.user);
      } catch (err: any) {
        setError(err.message ?? 'Registration failed');
        throw err;
      }
    },
    [],
  );

  const logout = useCallback(() => {
    localStorage.removeItem('origin_token');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
