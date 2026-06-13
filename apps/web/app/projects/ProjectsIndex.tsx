'use client';

import { useRouter } from 'next/navigation';
import {
  Plus, FolderTree, Users, FileText, ShieldAlert, Coins, Zap, Archive, ArrowRight, Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { useWorkspace, type WorkspaceSummary } from '../../components/WorkspaceProvider';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

function fmtUsd(n: number) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
function fmtRel(ms: number | null): string {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function ProjectsIndex() {
  const { activeId, setActive, workspaces, loading, create, archive, refresh } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submitNew() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await create(name.trim());
      if (created) { toast({ title: `Created "${created.name}"`, variant: 'success' }); setName(''); setCreating(false); }
      else toast({ title: 'Create failed', variant: 'error' });
    } finally { setBusy(false); }
  }

  async function onArchive(w: WorkspaceSummary) {
    if (!confirm(`Archive "${w.name}"?`)) return;
    await archive(w.id);
    toast({ title: `Archived "${w.name}"`, variant: 'warn' });
  }

  function openProject(id: string) {
    setActive(id);
    router.push(`/projects/${id}`);
  }

  const totalAgents = workspaces.reduce((s, w) => s + w.agents, 0);
  const totalPending = workspaces.reduce((s, w) => s + w.pendingApprovals, 0);
  const totalUsd = workspaces.reduce((s, w) => s + w.usd, 0);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5">
      {/* aggregate strip */}
      <div className="mb-5 flex items-center gap-4 text-xs flex-wrap">
        <Stat icon={<FolderTree size={12} />} label="projects" value={workspaces.length.toString()} />
        <Stat icon={<Users size={12} />} label="agents" value={totalAgents.toString()} />
        <Stat icon={<ShieldAlert size={12} />} label="pending" value={totalPending.toString()} variant={totalPending > 0 ? 'warn' : 'idle'} />
        <Stat icon={<Coins size={12} />} label="total spend" value={fmtUsd(totalUsd)} />
        <button
          onClick={() => { refresh(); }}
          className="ml-auto text-dim2 hover:text-ink text-xs"
        >
          refresh
        </button>
        {!creating ? (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium shadow-glow hover:brightness-110"
          >
            <Plus size={12} /> New project
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); if (e.key === 'Escape') setCreating(false); }}
              placeholder="project name…"
              className="bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
            />
            <button
              onClick={submitNew}
              disabled={busy || !name.trim()}
              className="px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40"
            >
              create
            </button>
            <button onClick={() => setCreating(false)} className="text-dim2 text-xs hover:text-ink">cancel</button>
          </div>
        )}
      </div>

      {/* grid */}
      {loading && workspaces.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1,2,3].map((i) => <div key={i} className="h-40 shimmer bg-line/20 rounded-lg" />)}
        </div>
      ) : workspaces.length === 0 ? (
        <div className="border border-dashed border-line/70 rounded-lg p-8 text-center">
          <div className="text-ink text-sm mb-1">No projects yet</div>
          <div className="text-dim text-xs">Click <span className="text-ink">New project</span> above to spin up your first workspace.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {workspaces.map((w) => (
            <ProjectCard
              key={w.id}
              w={w}
              isActive={w.id === activeId}
              onOpen={() => openProject(w.id)}
              onArchive={() => onArchive(w)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  w, isActive, onOpen, onArchive,
}: { w: WorkspaceSummary; isActive: boolean; onOpen: () => void; onArchive: () => void }) {
  const hasPending = w.pendingApprovals > 0;
  return (
    <div
      className={cn(
        'group relative rounded-lg border bg-surface2/60 overflow-hidden transition-all',
        isActive ? 'border-accent/40 shadow-glow' : 'border-line/70 hover:border-line2',
      )}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
      <button onClick={onOpen} className="w-full text-left p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FolderTree size={14} className={isActive ? 'text-accent' : 'text-dim'} />
              <span className="text-ink font-medium truncate">{w.name}</span>
              {isActive && <span className="text-[10px] uppercase tracking-wider text-accent">active</span>}
            </div>
            <div className="text-dim2 text-[11px] font-mono mt-0.5">{w.id}</div>
          </div>
          {hasPending && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-warn/40 text-warn bg-warn/10">
              {w.pendingApprovals} pending
            </span>
          )}
        </div>

        {w.lastBrief ? (
          <div className="text-xs text-ink2 line-clamp-2">{w.lastBrief.body}</div>
        ) : (
          <div className="text-xs text-dim2 italic">No briefs yet.</div>
        )}

        <div className="grid grid-cols-4 gap-2 text-[11px] mt-1">
          <Cell icon={<Users size={10} />}    label="agents"   value={w.agents.toString()} />
          <Cell icon={<FileText size={10} />} label="briefs"   value={w.totalBriefs.toString()} />
          <Cell icon={<Zap size={10} />}      label="tokens"   value={w.tokens.toLocaleString()} />
          <Cell icon={<Coins size={10} />}    label="spend"    value={fmtUsd(w.usd)} />
        </div>

        <div className="flex items-center justify-between text-[10px] text-dim2 mt-1">
          <span className="flex items-center gap-1">
            {w.digestDate ? <><Sparkles size={10} className="text-warn" /> digest {w.digestDate}</> : 'no digest'}
          </span>
          <span>last active {fmtRel(w.lastActivity)}</span>
        </div>
      </button>
      <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
        {!isActive && (
          <button onClick={onArchive} className="p-1 rounded text-dim2 hover:text-err" title="archive">
            <Archive size={11} />
          </button>
        )}
        <button onClick={onOpen} className="p-1 rounded text-dim2 hover:text-accent" title="open">
          <ArrowRight size={11} />
        </button>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, variant = 'idle' }: { icon: React.ReactNode; label: string; value: string; variant?: 'idle' | 'warn' }) {
  return (
    <div className={cn(
      'flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs',
      variant === 'warn' ? 'border-warn/40 text-warn bg-warn/10' : 'border-line/70 text-dim',
    )}>
      {icon}
      <span className="text-dim2 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="text-ink font-mono">{value}</span>
    </div>
  );
}

function Cell({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="border border-line/70 bg-bg/40 rounded-md px-2 py-1.5">
      <div className="flex items-center gap-1 text-dim2 text-[10px] uppercase tracking-wider">{icon}{label}</div>
      <div className="text-ink font-mono mt-0.5 truncate">{value}</div>
    </div>
  );
}
