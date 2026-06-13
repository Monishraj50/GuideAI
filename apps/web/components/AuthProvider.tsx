'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface PublicUser {
  username: string;
  displayName: string;
  isGuest: boolean;
}

export interface AuthState {
  authed: boolean;
  user?: PublicUser;
}

interface Ctx {
  state: AuthState | null;
  initialLoading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  signUp: (username: string, password: string, displayName?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  signInAsGuest: (displayName?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  signOut: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  upgradeGuest: (username: string, password: string, displayName?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const AuthContext = createContext<Ctx | null>(null);

async function postJson(url: string, body: object): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error ?? `http ${r.status}` };
  return { ok: true, data: j };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/auth/status', { credentials: 'include' });
      if (r.ok) setState(await r.json());
    } finally {
      setRefreshing(false);
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const r = await postJson('/api/auth/signin', { username, password });
    if (r.ok) { setState(r.data); return { ok: true as const }; }
    return { ok: false as const, error: r.error };
  }, []);

  const signUp = useCallback(async (username: string, password: string, displayName?: string) => {
    const r = await postJson('/api/auth/signup', { username, password, displayName });
    if (r.ok) { setState(r.data); return { ok: true as const }; }
    return { ok: false as const, error: r.error };
  }, []);

  const signInAsGuest = useCallback(async (displayName?: string) => {
    const r = await postJson('/api/auth/guest', { displayName });
    if (r.ok) { setState(r.data); return { ok: true as const }; }
    return { ok: false as const, error: r.error };
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' });
    setState({ authed: false });
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const r = await postJson('/api/auth/password', { currentPassword, newPassword });
    if (r.ok) return { ok: true as const };
    return { ok: false as const, error: r.error };
  }, []);

  const upgradeGuest = useCallback(async (username: string, password: string, displayName?: string) => {
    const r = await postJson('/api/auth/upgrade-guest', { username, password, displayName });
    if (r.ok) { setState(r.data); return { ok: true as const }; }
    return { ok: false as const, error: r.error };
  }, []);

  return (
    <AuthContext.Provider value={{
      state, initialLoading, refreshing, refresh,
      signIn, signUp, signInAsGuest, signOut, changePassword, upgradeGuest,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
