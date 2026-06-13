'use client';

import { useEffect, useState } from 'react';

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
  const [ruleSaved, setRuleSaved] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/approvals/pending`);
      const j = await res.json();
      setPending(j.pending ?? []);
    } catch {}
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [workspaceId]);

  async function decide(p: Pending, decision: 'approved' | 'denied') {
    setActing(p.id);
    setRuleSaved(null);
    try {
      await fetch(`/api/approvals/${p.id}?workspace=${workspaceId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      let parsedArgs: unknown = {};
      try { parsedArgs = JSON.parse(p.argsJson); } catch {}
      setLastDecision({ approvalId: p.id, tool: p.tool, args: parsedArgs, decision });
      await refresh();
    } finally {
      setActing(null);
    }
  }

  async function dontAskAgain() {
    if (!lastDecision) return;
    setActing('rule');
    try {
      const synthResp = await fetch('/api/policies/rules/synthesize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: lastDecision.tool, args: lastDecision.args, decision: lastDecision.decision }),
      });
      const draft = await synthResp.json();
      await fetch('/api/policies/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      setRuleSaved(`saved · ${draft.id}`);
      setLastDecision(null);
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-ink font-medium text-sm">Pending approvals</div>
        <div className="text-dim text-xs">{pending.length}</div>
      </div>
      {pending.length === 0 && (
        <div className="text-dim text-xs italic">No pending approvals.</div>
      )}
      {pending.map((p) => {
        let args: any = {};
        try { args = JSON.parse(p.argsJson); } catch {}
        const summary = `${p.tool}(${typeof args.cmd === 'string' ? args.cmd : JSON.stringify(args)})`;
        return (
          <div key={p.id} className="border border-line bg-bg rounded p-2 text-xs">
            <div className="font-mono text-ink truncate">{summary}</div>
            <div className="text-dim mt-1">{p.id}</div>
            <div className="mt-2 flex gap-2">
              <button
                disabled={acting === p.id}
                onClick={() => decide(p, 'approved')}
                className="px-2 py-1 rounded bg-accent text-bg font-medium disabled:opacity-40 hover:brightness-110"
              >
                approve
              </button>
              <button
                disabled={acting === p.id}
                onClick={() => decide(p, 'denied')}
                className="px-2 py-1 rounded border border-err text-err disabled:opacity-40 hover:bg-err hover:text-bg"
              >
                deny
              </button>
            </div>
          </div>
        );
      })}
      {lastDecision && (
        <div className="border border-accent/40 bg-bg rounded p-2 text-xs flex flex-col gap-1">
          <div className="text-dim">
            you just <span className={lastDecision.decision === 'approved' ? 'text-accent' : 'text-err'}>{lastDecision.decision}</span> {lastDecision.tool}
          </div>
          <button
            disabled={acting === 'rule'}
            onClick={dontAskAgain}
            className="self-start px-2 py-1 rounded bg-accent text-bg font-medium disabled:opacity-40 hover:brightness-110"
          >
            don&apos;t ask me about this again
          </button>
        </div>
      )}
      {ruleSaved && <div className="text-dim text-xs">{ruleSaved}</div>}
    </div>
  );
}
