'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, HomeIcon, RadioTower, Hash, Network, Store, ScrollText,
  Settings as SettingsIcon, Skull, Sparkles, ArrowRight, FolderTree,
} from 'lucide-react';
import { useWorkspace, useWorkspaceId } from './WorkspaceProvider';

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number }>;
  perform: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const workspaceId = useWorkspaceId();
  const { workspaces, setActive } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions: PaletteAction[] = useMemo(() => {
    const base: PaletteAction[] = [
      { id: 'go-home',     label: 'Go to Home',      hint: 'digest',     icon: HomeIcon,     perform: () => router.push('/') },
      { id: 'go-projects', label: 'Go to Projects',  hint: 'all',        icon: FolderTree,   perform: () => router.push('/projects') },
      { id: 'go-ops',      label: 'Go to Ops',       hint: 'live feed',  icon: RadioTower,   perform: () => router.push('/ops') },
      { id: 'go-channels', label: 'Go to Channels',  hint: 'team rooms', icon: Hash,         perform: () => router.push('/channels') },
      { id: 'go-org',      label: 'Go to Org',       hint: 'roster',     icon: Network,      perform: () => router.push('/org') },
      { id: 'go-hire',     label: 'Go to Hire',      hint: 'catalog',    icon: Store,        perform: () => router.push('/hire') },
      { id: 'go-logs',     label: 'Go to Logs',      hint: 'replay',     icon: ScrollText,   perform: () => router.push('/logs') },
      { id: 'go-settings', label: 'Go to Settings',  hint: 'rules',      icon: SettingsIcon, perform: () => router.push('/settings') },
      { id: 'run-digest',  label: 'Run digest now',  hint: workspaceId,  icon: Sparkles,     perform: () => fetch(`/api/workspaces/${workspaceId}/digest`, { method: 'POST' }) },
      { id: 'killswitch',  label: 'STOP ALL agents', hint: 'killswitch', icon: Skull,        perform: () => fetch(`/api/killswitch?workspace=${workspaceId}`, { method: 'POST' }) },
    ];
    const projectSwitches = workspaces
      .filter((w) => w.id !== workspaceId)
      .map<PaletteAction>((w) => ({
        id: `switch-${w.id}`,
        label: `Switch to "${w.name}"`,
        hint: 'project',
        icon: FolderTree,
        perform: () => { setActive(w.id); router.push('/projects/' + w.id); },
      }));
    return [...base, ...projectSwitches];
  }, [router, workspaceId, workspaces, setActive]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(needle) || (a.hint?.toLowerCase().includes(needle)));
  }, [actions, q]);

  useEffect(() => {
    const openHandler = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('guideai:open-palette', openHandler);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('guideai:open-palette', openHandler);
      window.removeEventListener('keydown', key);
    };
  }, []);

  useEffect(() => { setCursor(0); }, [q, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 10); }, [open]);

  function selectAt(i: number) {
    const a = filtered[i]; if (!a) return;
    a.perform(); setOpen(false); setQ('');
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); selectAt(cursor); }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center pt-[12vh] animate-fadeIn">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-[560px] max-w-[92vw] rounded-xl border border-line2 bg-surface2 shadow-soft overflow-hidden animate-slideUp">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line/70">
          <Search size={14} className="text-dim" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command, search, or jump…"
            className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-dim2"
          />
          <kbd className="text-[10px] text-dim font-mono px-1.5 py-0.5 rounded border border-line/70">ESC</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.map((a, i) => {
            const Icon = a.icon;
            const active = i === cursor;
            return (
              <li key={a.id}>
                <button
                  onClick={() => selectAt(i)}
                  onMouseEnter={() => setCursor(i)}
                  className={`w-full px-3 py-2 flex items-center gap-3 text-sm ${active ? 'bg-line2 text-ink' : 'text-ink2 hover:bg-line/40'}`}
                >
                  <Icon size={14} />
                  <span className="flex-1 text-left">{a.label}</span>
                  {a.hint && <span className="text-dim2 text-xs">{a.hint}</span>}
                  <ArrowRight size={12} className={active ? 'text-accent' : 'text-dim2'} />
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-dim text-sm italic">No matches.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
