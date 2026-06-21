'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface WorkspaceSummary {
  id: string;
  name: string;
  autonomyMode: string;
  createdAt: number;
  agents: number;
  pendingApprovals: number;
  activeBriefs: number;
  totalBriefs: number;
  lastBrief: { id: string; body: string; createdAt: number; status: string } | null;
  tokens: number;
  usd: number;
  lastActivity: number | null;
  digestDate: string | null;
}

interface Ctx {
  activeId: string;
  setActive: (id: string) => void;
  workspaces: WorkspaceSummary[];
  refresh: () => Promise<void>;
  create: (name: string, targetFolder?: string) => Promise<WorkspaceSummary | null>;
  archive: (id: string) => Promise<void>;
  loading: boolean;
}

const WorkspaceContext = createContext<Ctx | null>(null);
const STORAGE_KEY = 'guideai.activeWorkspace';
const DEFAULT_ID = 'demo';

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_ID);
  const [loading, setLoading] = useState(true);

  // Boot: read localStorage + fetch list.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setActiveId(saved);
    } catch {}
    void refresh();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/workspaces');
      if (r.ok) {
        const j = await r.json();
        setWorkspaces(j.workspaces ?? []);
        // If saved active doesn't exist, fall back to first or 'demo'.
        setActiveId((cur) => {
          const found = (j.workspaces as WorkspaceSummary[]).find((w) => w.id === cur);
          if (found) return cur;
          return (j.workspaces as WorkspaceSummary[])[0]?.id ?? DEFAULT_ID;
        });
      }
    } finally { setLoading(false); }
  }, []);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
    try { window.localStorage.setItem(STORAGE_KEY, id); } catch {}
  }, []);

  const create = useCallback(async (name: string, targetFolder?: string): Promise<WorkspaceSummary | null> => {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, targetFolder: targetFolder?.trim() || undefined }),
    });
    if (!r.ok) return null;
    await refresh();
    const r2 = await fetch('/api/workspaces');
    const j = await r2.json();
    const created = (j.workspaces as WorkspaceSummary[]).find((w) => w.name === name);
    if (created) setActive(created.id);
    return created ?? null;
  }, [refresh, setActive]);

  const archive = useCallback(async (id: string) => {
    // Optimistic: drop it from the list immediately so the UI feels responsive.
    setWorkspaces((cur) => cur.filter((w) => w.id !== id));
    // If the archived workspace was active, switch to whatever's left.
    setActiveId((cur) => {
      if (cur !== id) return cur;
      // We need the fresh list — use the state setter to read it inside.
      // Pick the first surviving workspace if any; otherwise fall back.
      // This setter runs after the filter above, so workspaces no longer has `id`.
      let next = cur;
      setWorkspaces((current) => {
        next = current[0]?.id ?? DEFAULT_ID;
        return current;
      });
      try { window.localStorage.setItem(STORAGE_KEY, next); } catch {}
      return next;
    });
    await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  return (
    <WorkspaceContext.Provider value={{ activeId, setActive, workspaces, refresh, create, archive, loading }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}

/** Convenience hook for components that just need the active workspace id. */
export function useWorkspaceId() {
  return useWorkspace().activeId;
}
