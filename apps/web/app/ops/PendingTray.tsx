'use client';

import { useEffect, useState } from 'react';
import { Check, X, Wrench, ShieldAlert } from 'lucide-react';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface Pending {
  id: string;
  tool: string;
  argsJson: string;
  decision: string;
  decidedAt: number;
}
interface LastDecision {
  approvalId: string;
  tool: string;
  args: unknown;
  decision: 'approved' | 'denied';
}

export function PendingTray({ workspaceId }: { workspaceId: string }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<LastDecision | null>(null);

  async function refresh() {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/approvals/pending`);
      const j = await res.json();
      setPending(j.pending ?? []);
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 1500); return () => clearInterval(t); }, [workspaceId]);

  async function decide(p: Pending, decision: 'approved' | 'denied') {
    setActing(p.id);
    try {
      await fetch(`/api/approvals/${p.id}?workspace=${workspaceId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      let parsedArgs: unknown = {};
      try { parsedArgs = JSON.parse(p.argsJson); } catch {}
      setLastDecision({ approvalId: p.id, tool: p.tool, args: parsedArgs, decision });
      toast({
        title: `${decision === 'approved' ? 'Approved' : 'Denied'} ${p.tool}`,
        description: typeof (parsedArgs as any)?.cmd === 'string' ? (parsedArgs as any).cmd : undefined,
        variant: decision === 'approved' ? 'success' : 'warn',
      });
      await refresh();
    } finally { setActing(null); }
  }

  async function dontAskAgain() {
    if (!lastDecision) return;
    setActing('rule');
    try {
      const synthResp = await fetch('/api/policies/rules/synthesize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: lastDecision.tool, args: lastDecision.args, decision: lastDecision.decision }),
      });
      const draft = await synthResp.json();
      await fetch('/api/policies/rules', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      toast({ title: 'Rule saved', description: draft.id, variant: 'success' });
      setLastDecision(null);
    } finally { setActing(null); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={14} className={pending.length > 0 ? 'text-warn' : 'text-dim2'} />
          <span className="text-ink text-sm font-medium">Pending approvals</span>
        </div>
        <span className={cn(
          'text-[10px] font-mono px-1.5 py-0.5 rounded-full border',
          pending.length > 0 ? 'border-warn/40 text-warn bg-warn/10' : 'border-line/70 text-dim',
        )}>
          {pending.length}
        </span>
      </div>
      {pending.length === 0 && (
        <div className="text-dim2 text-xs italic px-1">Nothing waiting for you.</div>
      )}
      {pending.map((p) => {
        let args: any = {};
        try { args = JSON.parse(p.argsJson); } catch {}
        const summary = `${p.tool}(${typeof args.cmd === 'string' ? args.cmd : JSON.stringify(args)})`;
        return (
          <div
            key={p.id}
            className="border border-warn/30 bg-warn/[0.04] rounded-lg p-3 text-xs animate-slideUp"
          >
            <div className="flex items-center gap-2 mb-2">
              <Wrench size={12} className="text-warn" />
              <span className="font-mono text-ink truncate">{summary}</span>
            </div>
            <div className="text-dim2 text-[10px] font-mono mb-2">{p.id}</div>
            <div className="flex gap-2">
              <button
                disabled={acting === p.id}
                onClick={() => decide(p, 'approved')}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-accent text-bg font-medium text-xs disabled:opacity-40 hover:brightness-110"
              >
                <Check size={12} /> approve
              </button>
              <button
                disabled={acting === p.id}
                onClick={() => decide(p, 'denied')}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border border-err/40 text-err text-xs disabled:opacity-40 hover:bg-err/10"
              >
                <X size={12} /> deny
              </button>
            </div>
          </div>
        );
      })}
      {lastDecision && (
        <div className="border border-accent/30 bg-accent/[0.04] rounded-lg p-3 text-xs flex flex-col gap-2 animate-fadeIn">
          <div className="text-dim">
            You just <span className={lastDecision.decision === 'approved' ? 'text-accent' : 'text-err'}>{lastDecision.decision}</span> <span className="font-mono text-ink">{lastDecision.tool}</span>
          </div>
          <button
            disabled={acting === 'rule'}
            onClick={dontAskAgain}
            className="self-start px-2 py-1 rounded-md bg-accent text-bg font-medium text-xs disabled:opacity-40 hover:brightness-110"
          >
            don&apos;t ask me about this again
          </button>
        </div>
      )}
    </div>
  );
}
