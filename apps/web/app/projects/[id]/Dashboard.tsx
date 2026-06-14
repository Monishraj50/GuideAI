'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KanbanSquare, Plus, X, GripVertical, Activity, Coins, Gauge,
  AlertTriangle, RefreshCw, Trash2, ChevronDown,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

type Status = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
type Phase = 'research' | 'plan' | 'implement' | 'review' | 'verify' | 'other';
type Priority = 'low' | 'normal' | 'high' | 'critical';

interface WorkItem {
  id: string;
  workspaceId: string;
  briefId: string | null;
  planId: string | null;
  title: string;
  description: string | null;
  assignedRole: string | null;
  phase: Phase | null;
  status: Status;
  priority: Priority;
  estimateHours: number | null;
  position: number;
  source: 'auto' | 'manual';
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface BurndownSeriesPoint {
  date: string;
  completed: number;
  cumulativeCompleted: number;
  remaining: number;
  usdSpent: number;
  cumulativeUsd: number;
}
interface BurndownResp {
  totals: {
    items: number; done: number; open: number; inProgress: number; blocked: number;
    usd: number; budgetHintUsd: number | null;
  };
  velocity: { last7d: number; today: number };
  series: BurndownSeriesPoint[];
}

const STATUS_COLUMNS: { id: Status; label: string; tint: string }[] = [
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

function fmtUsd(n: number | null | undefined) {
  if (n == null) return '—';
  if (n < 0.01 && n !== 0) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function Dashboard({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [burndown, setBurndown] = useState<BurndownResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ title: string; phase: Phase; priority: Priority; assignedRole: string } | null>(null);
  const dragRef = useRef<{ id: string; from: Status } | null>(null);

  async function refresh() {
    try {
      const [ri, rb] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/work-items`).then((r) => r.json()),
        fetch(`/api/workspaces/${workspaceId}/burndown?days=14`).then((r) => r.json()),
      ]);
      setItems(ri.items ?? []);
      setBurndown(rb);
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [workspaceId]);

  const byStatus = useMemo(() => {
    const out: Record<Status, WorkItem[]> = {
      todo: [], in_progress: [], blocked: [], done: [], cancelled: [],
    };
    for (const it of items) out[it.status]?.push(it);
    return out;
  }, [items]);

  async function moveTo(id: string, status: Status) {
    // Optimistic
    setItems((cur) => cur.map((x) => x.id === id ? { ...x, status } : x));
    try {
      const r = await fetch(`/api/work-items/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error('move failed');
      const j = await r.json();
      setItems((cur) => cur.map((x) => x.id === j.item.id ? j.item : x));
    } catch (e: any) {
      toast({ title: 'Move failed', description: e?.message, variant: 'error' });
      refresh();
    }
  }

  async function destroy(id: string) {
    if (!confirm('Delete this work item?')) return;
    setItems((cur) => cur.filter((x) => x.id !== id));
    try {
      const r = await fetch(`/api/work-items/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed');
    } catch (e: any) {
      toast({ title: 'Delete failed', description: e?.message, variant: 'error' });
      refresh();
    }
  }

  async function createDraft() {
    if (!draft || !draft.title.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/work-items`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          phase: draft.phase,
          priority: draft.priority,
          assignedRole: draft.assignedRole || null,
        }),
      });
      if (!r.ok) throw new Error('create failed');
      setDraft(null);
      await refresh();
    } catch (e: any) {
      toast({ title: 'Create failed', description: e?.message, variant: 'error' });
    } finally { setBusy(false); }
  }

  const t = burndown?.totals;

  return (
    <section className="space-y-4">
      <SectionHeader title="Progress dashboard" icon={<KanbanSquare size={14} className="text-accent" />}
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              className="text-dim2 hover:text-ink text-xs flex items-center gap-1"
            >
              <RefreshCw size={11} /> refresh
            </button>
            <button
              onClick={() => setDraft({ title: '', phase: 'implement', priority: 'normal', assignedRole: '' })}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow hover:brightness-110"
            >
              <Plus size={11} /> add item
            </button>
          </div>
        }
      />

      {/* KPI strip */}
      {t && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <KpiCard icon={<Activity size={11} />} label="open"       value={`${t.open}`}        sub={`${t.items} total`} />
          <KpiCard icon={<Gauge size={11} />}    label="in flight"  value={`${t.inProgress}`}  sub={t.blocked > 0 ? `${t.blocked} blocked` : 'no blockers'} />
          <KpiCard icon={<Activity size={11} />} label="done"       value={`${t.done}`}        sub={burndown ? `${burndown.velocity.last7d}/7d` : ''} />
          <KpiCard icon={<Coins size={11} />}    label="spent"      value={fmtUsd(t.usd)}       sub={t.budgetHintUsd != null ? `of ${fmtUsd(t.budgetHintUsd)}` : 'no budget hint'} />
          <KpiCard icon={<AlertTriangle size={11} />} label="today" value={`${burndown?.velocity.today ?? 0}`} sub="completed" />
        </div>
      )}

      {/* Charts */}
      {burndown && burndown.series.length > 1 && (
        <div className="grid md:grid-cols-2 gap-3">
          <ChartCard
            title="Items burndown · 14d"
            tint="text-accent"
            data={burndown.series}
            map={(p) => p.remaining}
            // ideal line: linear from totalItems → 0
            ideal={(i, n) => Math.max(0, (burndown.totals.items) * (1 - i / Math.max(1, n - 1)))}
            label={(p) => `${p.remaining} remaining`}
          />
          <ChartCard
            title="Cost burndown · 14d"
            tint="text-warn"
            data={burndown.series}
            map={(p) => p.cumulativeUsd}
            budget={t?.budgetHintUsd ?? null}
            label={(p) => fmtUsd(p.cumulativeUsd)}
          />
        </div>
      )}

      {/* Add-item form */}
      {draft && (
        <div className="border border-accent/40 rounded-lg bg-surface2/60 p-3 shadow-glow">
          <div className="flex items-center gap-2 mb-2">
            <Plus size={12} className="text-accent" />
            <span className="text-ink text-xs font-medium">New work item</span>
            <button onClick={() => setDraft(null)} className="ml-auto text-dim2 hover:text-ink"><X size={12} /></button>
          </div>
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') createDraft(); }}
            placeholder="What needs to happen?"
            className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink outline-none focus:border-accent/60 mb-2"
          />
          <div className="grid grid-cols-3 gap-2 mb-2">
            <SelectField label="Phase" value={draft.phase} onChange={(v) => setDraft({ ...draft, phase: v as Phase })}
              options={['research','plan','implement','review','verify','other']} />
            <SelectField label="Priority" value={draft.priority} onChange={(v) => setDraft({ ...draft, priority: v as Priority })}
              options={['low','normal','high','critical']} />
            <div>
              <Label>Role</Label>
              <input
                value={draft.assignedRole}
                onChange={(e) => setDraft({ ...draft, assignedRole: e.target.value })}
                placeholder="optional"
                className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={createDraft}
              disabled={busy || !draft.title.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
            >
              <Plus size={11} /> {busy ? 'adding…' : 'add'}
            </button>
          </div>
        </div>
      )}

      {/* Kanban */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {STATUS_COLUMNS.map((col) => {
          const xs = byStatus[col.id] ?? [];
          return (
            <div
              key={col.id}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                const data = dragRef.current;
                if (data && data.from !== col.id) {
                  moveTo(data.id, col.id);
                }
                dragRef.current = null;
              }}
              className={cn('rounded-lg border p-2 min-h-[180px] flex flex-col', col.tint)}
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
                  <KanbanCard
                    key={it.id}
                    item={it}
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
    </section>
  );
}

function KanbanCard({ item, onDragStart, onMove, onDelete }: {
  item: WorkItem;
  onDragStart: () => void;
  onMove: (s: Status) => void;
  onDelete: () => void;
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
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-line/70 text-dim2 truncate max-w-[100px]">
                {item.assignedRole}
              </span>
            )}
            <span className="text-[9px] uppercase tracking-wider text-dim2 ml-auto">{item.source}</span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button onClick={() => setOpen((x) => !x)} className="text-dim2 hover:text-ink text-[10px] flex items-center gap-0.5">
          <ChevronDown size={10} className={cn('transition-transform', open && 'rotate-180')} /> move
        </button>
        <button onClick={onDelete} className="text-dim2 hover:text-err text-[10px] flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
              {s.replace('_','·')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, tint, data, map, ideal, budget, label }: {
  title: string;
  tint: string;
  data: BurndownSeriesPoint[];
  map: (p: BurndownSeriesPoint) => number;
  ideal?: (i: number, n: number) => number;
  budget?: number | null;
  label: (p: BurndownSeriesPoint) => string;
}) {
  const W = 320, H = 90, PAD = 8;
  const values = data.map(map);
  const ideals = ideal ? data.map((_, i) => ideal(i, data.length)) : [];
  const maxRaw = Math.max(1, ...values, ...(budget ? [budget] : []), ...ideals);
  const max = maxRaw * 1.1;
  const min = 0;
  const range = Math.max(1e-6, max - min);
  const step = data.length > 1 ? (W - PAD * 2) / (data.length - 1) : 0;
  const xy = (i: number, v: number) => {
    const x = PAD + i * step;
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const path = values.map((v, i) => xy(i, v)).join(' L ');
  const idealPath = ideals.length > 0 ? ideals.map((v, i) => xy(i, v)).join(' L ') : '';
  const budgetY = budget != null ? H - PAD - ((budget - min) / range) * (H - PAD * 2) : null;
  const last = data[data.length - 1];
  return (
    <div className="border border-line/70 rounded-lg p-3 bg-surface2/50">
      <div className={cn('text-[10px] uppercase tracking-wider mb-1.5 flex items-center justify-between', tint)}>
        <span>{title}</span>
        {last && <span className="font-mono text-ink">{label(last)}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* baseline */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="currentColor" strokeOpacity="0.15" />
        {/* ideal (burndown only) */}
        {idealPath && (
          <path d={`M ${idealPath}`} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" strokeOpacity="0.4" />
        )}
        {/* budget line */}
        {budgetY != null && (
          <line x1={PAD} y1={budgetY} x2={W - PAD} y2={budgetY} stroke="currentColor" strokeWidth={1} strokeDasharray="2 4" strokeOpacity="0.5" />
        )}
        {/* actual */}
        <path
          d={`M ${path}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={tint}
        />
        {/* head dot */}
        {data.length > 0 && (() => {
          const lastV = values[values.length - 1] ?? 0;
          const [lx, ly] = xy(values.length - 1, lastV).split(',').map(Number);
          return <circle cx={lx} cy={ly} r={2.5} fill="currentColor" className={tint} />;
        })()}
      </svg>
      <div className="text-dim2 text-[10px] mt-1 flex items-center justify-between font-mono">
        <span>{data[0]?.date}</span>
        {budget != null && <span className="text-warn">budget {fmtUsd(budget)}</span>}
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="border border-line/70 rounded-md px-3 py-2 bg-surface2/40">
      <div className="flex items-center gap-1 text-dim2 text-[10px] uppercase tracking-wider">{icon}{label}</div>
      <div className="text-ink font-mono text-base mt-1">{value}</div>
      {sub && <div className="text-dim2 text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}

function SectionHeader({ title, icon, right }: { title: string; icon: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-ink font-medium text-sm">{title}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-dim2 text-[10px] uppercase tracking-wider mb-0.5">{children}</div>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
