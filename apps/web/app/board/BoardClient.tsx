'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KanbanSquare, GripVertical, Trash2, Search, Filter, X,
  RefreshCw, Activity, Gauge, CheckCircle2, AlertTriangle,
  FolderTree, ExternalLink, ChevronDown, ArrowRight,
} from 'lucide-react';
import { toast } from '../../components/Toast';
import { useWorkspace, useWorkspaceId } from '../../components/WorkspaceProvider';
import { cn } from '../../lib/cn';

type Status = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
type Phase = 'research' | 'plan' | 'implement' | 'review' | 'verify' | 'other';
type Priority = 'low' | 'normal' | 'high' | 'critical';

interface WorkItem {
  id: string;
  workspaceId: string;
  workspaceName: string;
  briefId: string | null;
  title: string;
  description: string | null;
  assignedRole: string | null;
  phase: Phase | null;
  status: Status;
  priority: Priority;
  source: 'auto' | 'manual';
  position: number;
  updatedAt: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface Facets {
  workspaces: { id: string; name: string }[];
  phases: string[];
  priorities: string[];
  roles: string[];
}

const COLUMNS: { id: Status; label: string; tint: string }[] = [
  { id: 'todo',        label: 'To do',       tint: 'border-line/70 text-dim' },
  { id: 'in_progress', label: 'In progress', tint: 'border-warn/40 text-warn bg-warn/[0.04]' },
  { id: 'blocked',     label: 'Blocked',     tint: 'border-err/40 text-err bg-err/[0.04]' },
  { id: 'done',        label: 'Done',        tint: 'border-accent/40 text-accent bg-accent/[0.04]' },
];

const PRIORITY_TINT: Record<Priority, string> = {
  low:      'border-line/60 text-dim',
  normal:   'border-line/70 text-ink2',
  high:     'border-warn/40 text-warn bg-warn/10',
  critical: 'border-err/40 text-err bg-err/10',
};

const PHASE_TINT: Record<Phase, string> = {
  research:  'border-info/40 text-info',
  plan:      'border-sonnet/40 text-sonnet',
  implement: 'border-accent/40 text-accent',
  review:    'border-warn/40 text-warn',
  verify:    'border-info/40 text-info',
  other:     'border-line/70 text-dim',
};

interface Filters {
  phase: string;
  priority: string;
  assignedRole: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { phase: '', priority: '', assignedRole: '', q: '' };

export function BoardClient() {
  const workspaceId = useWorkspaceId();
  const { workspaces } = useWorkspace();
  const currentWs = workspaces.find((w) => w.id === workspaceId);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const dragRef = useRef<{ id: string; from: Status } | null>(null);

  function buildQs(f: Filters): string {
    const sp = new URLSearchParams();
    sp.set('workspaceId', workspaceId);
    if (f.phase)         sp.set('phase', f.phase);
    if (f.priority)      sp.set('priority', f.priority);
    if (f.assignedRole)  sp.set('assignedRole', f.assignedRole);
    if (f.q)             sp.set('q', f.q);
    return sp.toString();
  }

  async function refresh() {
    if (!workspaceId) return;
    try {
      const r = await fetch(`/api/work-items?${buildQs(filters)}`);
      if (r.ok) {
        const j = await r.json();
        setItems(j.items ?? []);
        setFacets(j.facets ?? null);
      }
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); },
    [workspaceId, filters.phase, filters.priority, filters.assignedRole, filters.q]);

  const byStatus = useMemo(() => {
    const out: Record<Status, WorkItem[]> = { todo: [], in_progress: [], blocked: [], done: [], cancelled: [] };
    for (const it of items) out[it.status]?.push(it);
    return out;
  }, [items]);

  const stats = useMemo(() => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return {
      total: items.length,
      open: items.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length,
      inFlight: items.filter((i) => i.status === 'in_progress').length,
      blocked: items.filter((i) => i.status === 'blocked').length,
      doneToday: items.filter((i) => i.status === 'done' && i.completedAt && i.completedAt >= dayAgo).length,
      doneWeek: items.filter((i) => i.status === 'done' && i.completedAt && i.completedAt >= weekAgo).length,
    };
  }, [items]);

  async function moveTo(id: string, status: Status) {
    setItems((cur) => cur.map((x) => x.id === id ? { ...x, status } : x));
    try {
      const r = await fetch(`/api/work-items/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error('move failed');
      await refresh();
    } catch (e: any) {
      toast({ title: 'Move failed', description: e?.message, variant: 'error' });
      refresh();
    }
  }

  async function destroy(id: string) {
    if (!confirm('Delete this work item?')) return;
    setItems((cur) => cur.filter((x) => x.id !== id));
    try { await fetch(`/api/work-items/${id}`, { method: 'DELETE' }); } catch { refresh(); }
  }

  const activeFilterCount = Number(!!filters.phase) +
    Number(!!filters.priority) + Number(!!filters.assignedRole) + Number(!!filters.q);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Project-scoped header */}
      <header className="border-b border-line/70 px-5 py-3 glass flex items-center gap-3">
        <KanbanSquare size={16} className="text-accent" />
        <div className="min-w-0">
          <div className="text-ink font-medium flex items-center gap-2">
            Board
            <span className="text-dim2 text-[11px]">·</span>
            <span className="text-ink2 text-sm font-medium truncate">{currentWs?.name ?? workspaceId ?? '—'}</span>
          </div>
          <div className="text-dim text-[11px] mt-0.5 font-mono">{workspaceId} · drag to move</div>
        </div>
        {currentWs && (
          <Link
            href={`/projects/${workspaceId}`}
            className="ml-auto flex items-center gap-1 text-dim2 hover:text-ink text-xs"
            title="Open this project's full plan"
          >
            open project <ArrowRight size={11} />
          </Link>
        )}
      </header>

      <div className="p-4 space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
        <Kpi icon={<Activity size={11} />}      label="open"        value={stats.open} sub={`of ${stats.total} total`} />
        <Kpi icon={<Gauge size={11} />}          label="in flight"   value={stats.inFlight} sub={stats.blocked > 0 ? `${stats.blocked} blocked` : 'no blockers'} />
        <Kpi icon={<AlertTriangle size={11} />} label="blocked"     value={stats.blocked} tint={stats.blocked > 0 ? 'text-err' : undefined} />
        <Kpi icon={<CheckCircle2 size={11} />}  label="done · 24h"  value={stats.doneToday} />
        <Kpi icon={<CheckCircle2 size={11} />}  label="done · 7d"   value={stats.doneWeek} />
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-1 min-w-[200px] bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 focus-within:border-accent/60">
          <Search size={12} className="text-dim2" />
          <input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="search title or description…"
            className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-dim2"
          />
          {filters.q && (
            <button onClick={() => setFilters((f) => ({ ...f, q: '' }))} className="text-dim2 hover:text-ink">
              <X size={11} />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowFilters((x) => !x)}
          className={cn(
            'flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-xs',
            activeFilterCount > 0 || showFilters ? 'border-accent/40 text-accent bg-accent/[0.05]' : 'border-line/70 text-ink2 hover:border-line2',
          )}
        >
          <Filter size={11} /> filters {activeFilterCount > 0 && <span className="font-mono">({activeFilterCount})</span>}
          <ChevronDown size={10} className={cn('transition-transform', showFilters && 'rotate-180')} />
        </button>
        {activeFilterCount > 0 && (
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="text-dim2 hover:text-ink text-xs flex items-center gap-1"
          >
            <X size={11} /> clear all
          </button>
        )}
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
          <RefreshCw size={11} /> refresh
        </button>
      </div>

      {showFilters && facets && (
        <div className="border border-line/70 rounded-lg bg-surface2/40 p-3 grid md:grid-cols-3 gap-3">
          <FilterSelect
            label="Phase"
            value={filters.phase}
            onChange={(v) => setFilters((f) => ({ ...f, phase: v }))}
            options={[{ value: '', label: 'any phase' }, ...['research','plan','implement','review','verify','other'].map((p) => ({ value: p, label: p }))]}
          />
          <FilterSelect
            label="Priority"
            value={filters.priority}
            onChange={(v) => setFilters((f) => ({ ...f, priority: v }))}
            options={[{ value: '', label: 'any priority' }, ...['low','normal','high','critical'].map((p) => ({ value: p, label: p }))]}
          />
          <FilterSelect
            label="Role"
            value={filters.assignedRole}
            onChange={(v) => setFilters((f) => ({ ...f, assignedRole: v }))}
            options={[{ value: '', label: 'any role' }, ...facets.roles.map((r) => ({ value: r, label: r }))]}
          />
        </div>
      )}

      {/* Kanban */}
      {items.length === 0 ? (
        <div className="border border-dashed border-line/70 rounded-lg p-6 text-center">
          <KanbanSquare size={20} className="mx-auto text-dim2 mb-2" />
          <div className="text-ink text-sm">
            {activeFilterCount > 0 ? 'No work items match these filters' : `No work items in ${currentWs?.name ?? 'this project'} yet`}
          </div>
          <div className="text-dim text-xs mt-1">
            {activeFilterCount > 0 ? 'Try clearing some filters' : (
              <>Dispatch a brief in <Link href={`/projects/${workspaceId}`} className="text-accent hover:underline">this project</Link> to populate the board, or pick a different project from the top bar.</>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {COLUMNS.map((col) => {
            const xs = byStatus[col.id] ?? [];
            return (
              <div
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const data = dragRef.current;
                  if (data && data.from !== col.id) moveTo(data.id, col.id);
                  dragRef.current = null;
                }}
                className={cn('rounded-lg border p-2 min-h-[280px] flex flex-col', col.tint)}
              >
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-[10px] uppercase tracking-wider font-medium">{col.label}</span>
                  <span className="font-mono text-[10px]">{xs.length}</span>
                </div>
                <div className="space-y-1.5 flex-1">
                  {xs.length === 0 && (
                    <div className="text-dim2 text-[11px] italic px-1 py-2">empty</div>
                  )}
                  {xs.map((it) => (
                    <BoardCard
                      key={it.id} item={it}
                      onDragStart={() => { dragRef.current = { id: it.id, from: col.id }; }}
                      onMove={(s) => moveTo(it.id, s)}
                      onDelete={() => destroy(it.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

function BoardCard({ item, onDragStart, onMove, onDelete }: {
  item: WorkItem; onDragStart: () => void; onMove: (s: Status) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group bg-bg/60 border border-line/70 rounded-md p-2 hover:border-line2 cursor-grab active:cursor-grabbing transition-colors"
    >
      <div className="flex items-start gap-1.5">
        <GripVertical size={11} className="text-dim2 mt-0.5 shrink-0 opacity-60 group-hover:opacity-100" />
        <div className="flex-1 min-w-0">
          <div className="text-ink text-[12.5px] font-medium leading-snug">{item.title}</div>
          {item.description && (
            <div className="text-dim text-[11px] mt-0.5 line-clamp-2">{item.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            {item.phase && (
              <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', PHASE_TINT[item.phase])}>
                {item.phase}
              </span>
            )}
            <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', PRIORITY_TINT[item.priority])}>
              {item.priority}
            </span>
            {item.assignedRole && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-line/70 text-dim2 truncate max-w-[110px]">
                {item.assignedRole}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button onClick={() => setOpen((x) => !x)} className="text-dim2 hover:text-ink text-[10px] flex items-center gap-0.5">
          <ChevronDown size={10} className={cn('transition-transform', open && 'rotate-180')} /> move
        </button>
        <button onClick={onDelete} className="text-dim2 hover:text-err text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
          <Trash2 size={10} />
        </button>
      </div>
      {open && (
        <div className="mt-1 grid grid-cols-4 gap-1">
          {(['todo','in_progress','blocked','done'] as Status[]).map((s) => (
            <button
              key={s}
              onClick={() => { onMove(s); setOpen(false); }}
              disabled={s === item.status}
              className={cn(
                'text-[10px] px-1 py-0.5 rounded border',
                s === item.status ? 'border-line/40 text-dim2 cursor-default' : 'border-line/70 text-ink2 hover:border-line2 hover:text-ink',
              )}
            >
              {s.replace('_', '·')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, sub, tint }: {
  icon: React.ReactNode; label: string; value: number; sub?: string; tint?: string;
}) {
  return (
    <div className="border border-line/70 rounded-md px-3 py-2 bg-surface2/40">
      <div className="flex items-center gap-1 text-dim2 text-[10px] uppercase tracking-wider">{icon}{label}</div>
      <div className={cn('font-mono mt-1 text-base', tint ?? 'text-ink')}>{value}</div>
      {sub && <div className="text-dim2 text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div>
      <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
