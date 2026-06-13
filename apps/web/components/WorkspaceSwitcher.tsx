'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Plus, Check, FolderTree, Archive } from 'lucide-react';
import { useWorkspace } from './WorkspaceProvider';
import { toast } from './Toast';
import { cn } from '../lib/cn';

export function WorkspaceSwitcher() {
  const { activeId, setActive, workspaces, create, refresh, archive } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false); setCreating(false);
      }
    }
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const active = workspaces.find((w) => w.id === activeId);

  async function submitNew() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await create(name.trim());
      if (created) {
        toast({ title: `Created "${created.name}"`, variant: 'success' });
        setName('');
        setCreating(false);
        setOpen(false);
      } else {
        toast({ title: 'Create failed', description: 'name may already exist', variant: 'error' });
      }
    } finally { setBusy(false); }
  }

  async function onArchive(id: string, name: string) {
    if (!confirm(`Archive "${name}"? Data stays on disk.`)) return;
    await archive(id);
    toast({ title: `Archived "${name}"`, variant: 'warn' });
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => { setOpen((o) => !o); refresh(); }}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-line/40 hover:bg-line text-ink transition-colors text-xs"
      >
        <FolderTree size={12} className="text-accent" />
        <span className="font-mono">{active?.name ?? activeId}</span>
        <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 rounded-lg border border-line2 bg-surface2 shadow-soft overflow-hidden z-30 animate-slideUp">
          <div className="px-3 py-2 border-b border-line/70 flex items-center justify-between">
            <span className="text-dim2 text-[10px] uppercase tracking-wider">Projects</span>
            <span className="text-dim2 text-[10px] font-mono">{workspaces.length}</span>
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {workspaces.length === 0 && (
              <li className="px-3 py-3 text-dim2 text-xs italic">No projects yet.</li>
            )}
            {workspaces.map((w) => {
              const isActive = w.id === activeId;
              return (
                <li key={w.id} className="group">
                  <div
                    onClick={() => { setActive(w.id); setOpen(false); }}
                    className={cn(
                      'px-3 py-2 flex items-center gap-2 text-xs cursor-pointer transition-colors',
                      isActive ? 'bg-line2/60 text-ink' : 'text-ink2 hover:bg-line/40',
                    )}
                  >
                    <span className={cn('w-1.5 h-1.5 rounded-full', isActive ? 'bg-accent' : 'bg-dim2')} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{w.name}</div>
                      <div className="text-dim2 text-[10px] font-mono">
                        {w.agents} agent{w.agents === 1 ? '' : 's'} · {w.totalBriefs} brief{w.totalBriefs === 1 ? '' : 's'}
                        {w.pendingApprovals > 0 && <span className="text-warn ml-1">· {w.pendingApprovals} pending</span>}
                      </div>
                    </div>
                    {isActive && <Check size={12} className="text-accent" />}
                    {!isActive && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onArchive(w.id, w.name); }}
                        className="opacity-0 group-hover:opacity-100 text-dim2 hover:text-err transition-opacity"
                        title="archive"
                      >
                        <Archive size={11} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line/70">
            {!creating ? (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink2 hover:bg-line/40"
              >
                <Plus size={12} /> New project
              </button>
            ) : (
              <div className="p-2 flex gap-2">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); if (e.key === 'Escape') setCreating(false); }}
                  placeholder="project name…"
                  className="flex-1 bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
                />
                <button
                  onClick={submitNew}
                  disabled={busy || !name.trim()}
                  className="px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40"
                >
                  create
                </button>
              </div>
            )}
            <button
              onClick={() => { router.push('/projects'); setOpen(false); }}
              className="w-full flex items-center justify-between px-3 py-2 text-xs text-dim2 hover:text-ink hover:bg-line/40 border-t border-line/70"
            >
              <span>Open all projects</span>
              <span className="text-accent">→</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
