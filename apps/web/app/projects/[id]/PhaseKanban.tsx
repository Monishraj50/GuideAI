'use client';

// Task Kanban — work-item-level board.
//
// Replaces the earlier 5-phase Kanban. Operates on the work-items the
// orchestrator seeded from the round-table synthesis: typically one item
// per role per phase, plus review items per risk and verify items per
// success metric.
//
// Dependency rule (the user's spec):
//   - Items within the SAME phase are independent → all draggable in parallel.
//   - Items in phase N wait for ALL items in earlier phases to finish.
//   - An item with an explicit parentId waits for that parent regardless.
//
// Columns: To do · In progress · Done · Failed (renamed from "blocked").
//
// Drag rules:
//   - todo → in_progress: only if dependencies are met. PATCHes the
//     work-item status to 'in_progress' AND releases its phase gate
//     (so the orchestrator dispatches that phase's agent).
//   - in_progress is locked (can't drag out — agent is working).
//   - done → in_progress: triggers verify-and-repair (PATCHes status back).
//   - blocked → in_progress: retry path; same as done → in_progress.

import { useEffect, useState } from 'react';
import { ListChecks, CheckCircle2, AlertTriangle, Pause, Lock, Loader2 } from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

const PHASE_ORDER = ['research', 'plan', 'implement', 'review', 'verify'] as const;
type Phase = typeof PHASE_ORDER[number];

type WorkStatus = 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
type Bucket = 'todo' | 'in_progress' | 'done' | 'blocked';

interface WorkItem {
  id: string;
  workspaceId: string;
  briefId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  assignedRole: string | null;
  phase: Phase | null;
  status: WorkStatus;
  priority: string;
}

interface BriefSummary { id: string; status: string; createdAt: number }

const COL: Record<Bucket, { label: string; tint: string; iconColor: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  todo:        { label: 'To do',       tint: 'border-line/70',                       iconColor: 'text-dim',    Icon: Pause },
  in_progress: { label: 'In progress', tint: 'border-warn/40 bg-warn/[0.04]',        iconColor: 'text-warn',   Icon: Loader2 },
  done:        { label: 'Done',        tint: 'border-accent/40 bg-accent/[0.04]',    iconColor: 'text-accent', Icon: CheckCircle2 },
  blocked:     { label: 'Failed',      tint: 'border-err/40 bg-err/[0.04]',          iconColor: 'text-err',    Icon: AlertTriangle },
};

const ROLE_EMOJI: Record<string, string> = {
  'frontend-developer': '🎨',
  'backend-developer':  '⚙️',
  'qa-expert':          '🧪',
  'risk-officer':       '🛡️',
  'product-strategist': '🎯',
  'tech-lead':          '👷',
  'finance-analyst':    '💰',
  'ux-researcher':      '🔍',
};

export function PhaseKanban({ workspaceId }: { workspaceId: string }) {
  const [briefId, setBriefId] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'manual' | 'pending' | null>(null);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [dragging, setDragging] = useState<{ item: WorkItem; bucket: Bucket } | null>(null);
  const [dropTarget, setDropTarget] = useState<Bucket | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const planResp = await fetch(`/api/workspaces/${workspaceId}/plan`);
        if (!planResp.ok) return;
        const plan = await planResp.json();
        const recent: BriefSummary[] = plan?.briefs?.recent ?? [];
        const candidate = recent
          .filter((b) => b.status === 'active' || b.status === 'done' || b.status === 'failed')
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!candidate) { if (!cancelled) { setBriefId(null); setMode(null); setItems([]); } return; }

        const [gateRes, itemsRes] = await Promise.all([
          fetch(`/api/briefs/${candidate.id}/gates`),
          fetch(`/api/work-items?workspaceId=${workspaceId}&briefId=${candidate.id}`),
        ]);
        if (!gateRes.ok || !itemsRes.ok) return;
        const gates = await gateRes.json() as { mode: 'auto' | 'manual' | 'pending' };
        const itemsJson = await itemsRes.json() as { items: WorkItem[] };
        if (cancelled) return;

        if (gates.mode === 'pending') {
          // Pending briefs belong to the StartImplementation panel.
          setBriefId(null); setMode(null); setItems([]); return;
        }
        setBriefId(candidate.id);
        setMode(gates.mode);
        setItems(itemsJson.items ?? []);
      } catch { /* network blip — next tick retries */ }
    }
    void tick();
    const t = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(t); };
  }, [workspaceId]);

  // ─── Dependency computation ──────────────────────────────────────────
  // For each item:
  //   1. find its phase index in PHASE_ORDER
  //   2. it's "ready" iff every item in EARLIER phases has status === 'done'
  //   3. if it has a parentId, parent must also be 'done'
  function isReady(item: WorkItem): boolean {
    if (item.status !== 'todo') return false;
    if (item.parentId) {
      const parent = items.find((i) => i.id === item.parentId);
      if (!parent || parent.status !== 'done') return false;
    }
    const phaseIdx = item.phase ? PHASE_ORDER.indexOf(item.phase) : -1;
    if (phaseIdx <= 0) return true; // research items (or no-phase items) are always ready
    // every item in earlier phases must be done (or skipped)
    for (const other of items) {
      if (!other.phase) continue;
      const otherIdx = PHASE_ORDER.indexOf(other.phase);
      if (otherIdx >= 0 && otherIdx < phaseIdx) {
        if (other.status !== 'done' && other.status !== 'cancelled') return false;
      }
    }
    return true;
  }

  function bucketOf(s: WorkStatus): Bucket | null {
    if (s === 'cancelled') return null; // hidden — abandoned items don't clutter the board
    return s as Bucket;
  }

  const buckets: Record<Bucket, WorkItem[]> = { todo: [], in_progress: [], done: [], blocked: [] };
  for (const it of items) {
    const b = bucketOf(it.status);
    if (b) buckets[b].push(it);
  }
  // Within each column, order by phase then position then title.
  for (const b of Object.keys(buckets) as Bucket[]) {
    buckets[b].sort((a, b) => {
      const ap = a.phase ? PHASE_ORDER.indexOf(a.phase) : 99;
      const bp = b.phase ? PHASE_ORDER.indexOf(b.phase) : 99;
      if (ap !== bp) return ap - bp;
      return a.title.localeCompare(b.title);
    });
  }

  async function release(item: WorkItem) {
    if (!briefId) return;
    try {
      // 1. PATCH work-item status to in_progress so the UI updates immediately.
      const patchRes = await fetch(`/api/work-items/${item.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      if (!patchRes.ok) throw new Error('work-item update failed');

      // 2. Release the phase gate so the orchestrator dispatches that phase
      //    (idempotent — if already released, returns released:0).
      if (item.phase) {
        await fetch(`/api/briefs/${briefId}/phases/${item.phase}/release`, { method: 'POST' });
      }

      toast({
        title: `Released: ${item.title.slice(0, 50)}`,
        description: `${item.phase ?? 'task'} · ${item.assignedRole ?? 'unassigned'}`,
        variant: 'success',
      });
      setItems((cur) => cur.map((i) => i.id === item.id ? { ...i, status: 'in_progress' } : i));
    } catch (e: any) {
      toast({ title: 'Release failed', description: e?.message ?? String(e), variant: 'error' });
    }
  }

  async function reopen(item: WorkItem) {
    if (!briefId) return;
    try {
      const patchRes = await fetch(`/api/work-items/${item.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      if (!patchRes.ok) throw new Error('work-item update failed');
      if (item.phase) {
        await fetch(`/api/briefs/${briefId}/phases/${item.phase}/reopen`, { method: 'POST' });
      }
      toast({
        title: `Reopened: ${item.title.slice(0, 50)}`,
        description: 'agent will re-verify',
        variant: 'success',
      });
      setItems((cur) => cur.map((i) => i.id === item.id ? { ...i, status: 'in_progress' } : i));
    } catch (e: any) {
      toast({ title: 'Reopen failed', description: e?.message ?? String(e), variant: 'error' });
    }
  }

  function handleDrop(target: Bucket) {
    setDropTarget(null);
    const d = dragging;
    setDragging(null);
    if (!d) return;
    if (target !== 'in_progress') return; // only the in-progress column accepts drops
    if (d.bucket === 'todo') {
      if (!isReady(d.item)) {
        toast({ title: 'Not ready', description: 'this task is waiting on an earlier phase', variant: 'warn' });
        return;
      }
      void release(d.item);
    } else if (d.bucket === 'done' || d.bucket === 'blocked') {
      void reopen(d.item);
    }
  }

  if (!briefId || !mode) return null;
  const totalItems = items.filter((i) => i.status !== 'cancelled').length;

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <ListChecks size={14} className="text-accent" />
        <span className="text-ink font-medium text-sm">Tasks</span>
        <span className="text-dim2 text-[11px] font-mono">{briefId}</span>
        <span
          className={cn(
            'text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border',
            mode === 'auto'
              ? 'border-accent/40 text-accent bg-accent/10'
              : 'border-warn/40 text-warn bg-warn/10',
          )}
        >
          {mode}
        </span>
        <span className="text-dim2 text-[11px]">
          {totalItems} task{totalItems === 1 ? '' : 's'} ·{' '}
          {mode === 'manual'
            ? 'drag any "ready" task to In progress; locked tasks are waiting on a prior phase'
            : 'tasks advance automatically'}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {(['todo', 'in_progress', 'done', 'blocked'] as Bucket[]).map((bucket) => {
          const M = COL[bucket];
          const colItems = buckets[bucket];
          const isDrop = dropTarget === bucket && bucket === 'in_progress';
          return (
            <div
              key={bucket}
              onDragOver={(e) => {
                if (bucket !== 'in_progress') return;
                e.preventDefault();
                setDropTarget(bucket);
              }}
              onDragLeave={() => setDropTarget((cur) => (cur === bucket ? null : cur))}
              onDrop={(e) => { e.preventDefault(); handleDrop(bucket); }}
              className={cn(
                'border rounded-lg p-3 min-h-[260px] flex flex-col gap-2',
                M.tint,
                isDrop && 'ring-2 ring-accent/60 ring-offset-1 ring-offset-bg',
              )}
            >
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-dim2 mb-1">
                <M.Icon size={12} className={cn(M.iconColor, bucket === 'in_progress' && colItems.length > 0 && 'animate-spin')} />
                <span className={M.iconColor}>{M.label}</span>
                <span className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded-full border border-line/40">
                  {colItems.length}
                </span>
              </div>
              {colItems.length === 0 ? (
                <div className="text-dim2 text-[11px] italic py-6 text-center opacity-60">—</div>
              ) : (
                colItems.map((it) => {
                  const ready = bucket === 'todo' ? isReady(it) : true;
                  const isDraggable =
                    bucket === 'done' ||
                    bucket === 'blocked' ||
                    (bucket === 'todo' && ready);
                  // 'in_progress' is intentionally NOT draggable (locked while running).
                  const phaseLabel = it.phase ?? '—';
                  const roleEmoji = it.assignedRole ? (ROLE_EMOJI[it.assignedRole] ?? '👤') : '👤';
                  const blockedHint = !ready
                    ? `🔒 waiting for ${earlierPhaseName(it.phase)} to finish`
                    : '';
                  return (
                    <div
                      key={it.id}
                      draggable={isDraggable}
                      onDragStart={() => setDragging({ item: it, bucket })}
                      onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                      title={blockedHint || it.description || it.title}
                      className={cn(
                        'rounded-md border bg-bg/70 px-2.5 py-2 transition-colors',
                        isDraggable ? 'cursor-grab hover:border-accent/40' : 'cursor-not-allowed',
                        bucket === 'in_progress' && 'border-warn/40',
                        bucket === 'done' && 'border-accent/30',
                        bucket === 'blocked' && 'border-err/40',
                        bucket === 'todo' && !ready && 'opacity-45 border-dashed',
                        bucket === 'todo' && ready && 'border-line/70',
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        <span className="text-[13px] mt-0.5">{roleEmoji}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-ink text-[12.5px] font-medium leading-snug line-clamp-2">
                            {it.title}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-dim2 font-mono">
                            <span className="px-1 py-0.5 rounded-full border border-line/60">{phaseLabel}</span>
                            {it.assignedRole && (
                              <span className="truncate">{it.assignedRole}</span>
                            )}
                          </div>
                          {blockedHint && (
                            <div className="text-[10px] text-dim2 mt-1 flex items-center gap-1">
                              <Lock size={9} />
                              {blockedHint}
                            </div>
                          )}
                          {bucket === 'in_progress' && (
                            <div className="text-[10px] text-warn mt-1">⏳ running · locked</div>
                          )}
                          {bucket === 'done' && (
                            <div className="text-[10px] text-accent mt-1">✓ drag back to re-verify</div>
                          )}
                          {bucket === 'blocked' && (
                            <div className="text-[10px] text-err mt-1">🛑 drag back to retry</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function earlierPhaseName(phase: Phase | null): string {
  if (!phase) return 'prior tasks';
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx <= 0) return 'prior tasks';
  return PHASE_ORDER[idx - 1]!;
}
