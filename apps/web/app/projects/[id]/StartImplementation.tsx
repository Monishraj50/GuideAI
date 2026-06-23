'use client';

// Phase D — "Start Implementing" panel.
//
// Surfaces ONLY when there's a dispatched brief still sitting in 'pending'
// mode (waiting for the user to choose Auto vs. Manual). Polls the workspace
// plan to find the latest brief, then queries /api/briefs/:briefId/gates to
// confirm the brief is actually pending. Clicking either card POSTs to
// /api/briefs/:briefId/start and hides the panel.

import { useEffect, useState } from 'react';
import { Play, Hand, Loader2 } from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

interface BriefSummary {
  id: string;
  status: string;
  createdAt: number;
}

interface GateState {
  briefId: string;
  mode: 'auto' | 'manual' | 'pending';
  gates: Array<{ phase: string; released: boolean }>;
}

export function StartImplementation({ workspaceId }: { workspaceId: string }) {
  const [pendingBrief, setPendingBrief] = useState<BriefSummary | null>(null);
  const [gateState, setGateState] = useState<GateState | null>(null);
  const [busy, setBusy] = useState<'auto' | 'manual' | null>(null);

  // Poll the workspace plan for the latest brief, then ask its gate endpoint
  // whether it's still pending. A brief leaves 'pending' as soon as /start is
  // called, so the panel disappears once the user clicks.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const planResp = await fetch(`/api/workspaces/${workspaceId}/plan`);
        if (!planResp.ok) return;
        const plan = await planResp.json();
        const recent: BriefSummary[] = plan?.briefs?.recent ?? [];
        // Newest "active" brief is the candidate. Done/failed briefs were
        // already started (or never will be) so skip them.
        const candidate = recent
          .filter((b) => b.status === 'active' || b.status === 'pending')
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
        if (cancelled) return;
        if (!candidate) {
          setPendingBrief(null);
          setGateState(null);
          return;
        }
        const gateResp = await fetch(`/api/briefs/${candidate.id}/gates`);
        if (!gateResp.ok) return;
        const gates: GateState = await gateResp.json();
        if (cancelled) return;
        if (gates.mode === 'pending') {
          setPendingBrief(candidate);
          setGateState(gates);
        } else {
          setPendingBrief(null);
          setGateState(null);
        }
      } catch { /* network blip; next tick retries */ }
    }
    void check();
    const t = setInterval(check, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [workspaceId]);

  async function start(mode: 'auto' | 'manual') {
    if (!pendingBrief) return;
    setBusy(mode);
    try {
      const r = await fetch(`/api/briefs/${pendingBrief.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `http ${r.status}`);
      toast({
        title: mode === 'auto' ? 'Implementation started · auto' : 'Implementation started · manual',
        description: mode === 'auto'
          ? `${pendingBrief.id} — agents marching end-to-end`
          : `${pendingBrief.id} — drag phase cards in the Kanban to release each step`,
        variant: 'success',
      });
      setPendingBrief(null);
      setGateState(null);
    } catch (e: any) {
      toast({ title: 'Start failed', description: e?.message ?? String(e), variant: 'error' });
    } finally { setBusy(null); }
  }

  // Hide the section entirely when nothing is pending. The user sees a clean
  // page until a plan is approved.
  if (!pendingBrief || !gateState) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Play size={14} className="text-accent" />
        <span className="text-ink font-medium text-sm">Ready to implement</span>
        <span className="text-dim2 text-[11px] font-mono">{pendingBrief.id} · awaiting start</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => start('auto')}
          disabled={!!busy}
          className={cn(
            'flex items-start gap-3 px-4 py-3.5 rounded-lg text-left transition-colors',
            'border bg-bg/70 hover:border-accent/60 hover:bg-accent/[0.04]',
            'border-line/70',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {busy === 'auto'
            ? <Loader2 size={18} className="animate-spin text-accent mt-0.5" />
            : <Play size={18} className="text-accent mt-0.5" />}
          <div className="flex-1">
            <div className="text-ink text-sm font-medium mb-1">▶ Start Auto</div>
            <div className="text-dim text-[11.5px] leading-snug">
              Runs the full pipeline end-to-end. Cards march left → right on the Kanban automatically.
              Best for short briefs you trust the team to execute.
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => start('manual')}
          disabled={!!busy}
          className={cn(
            'flex items-start gap-3 px-4 py-3.5 rounded-lg text-left transition-colors',
            'border bg-bg/70 hover:border-warn/60 hover:bg-warn/[0.04]',
            'border-line/70',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {busy === 'manual'
            ? <Loader2 size={18} className="animate-spin text-warn mt-0.5" />
            : <Hand size={18} className="text-warn mt-0.5" />}
          <div className="flex-1">
            <div className="text-ink text-sm font-medium mb-1">🖐 Start Manual</div>
            <div className="text-dim text-[11.5px] leading-snug">
              Pauses between phases. Drag each card from Inactive → Active on the Kanban to release it.
              Best for high-stakes work where you want to review between phases.
            </div>
          </div>
        </button>
      </div>
    </section>
  );
}
