'use client';

import { useEffect, useState } from 'react';

interface Pending {
  id: string;
  tool: string;
  argsJson: string;
  decision: string;
  decidedAt: number;
}

export function PendingTray({ workspaceId }: { workspaceId: string }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [acting, setActing] = useState<string | null>(null);

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

  async function decide(id: string, decision: 'approved' | 'denied') {
    setActing(id);
    try {
      await fetch(`/api/approvals/${id}?workspace=${workspaceId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      await refresh();
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
                onClick={() => decide(p.id, 'approved')}
                className="px-2 py-1 rounded bg-accent text-bg font-medium disabled:opacity-40 hover:brightness-110"
              >
                approve
              </button>
              <button
                disabled={acting === p.id}
                onClick={() => decide(p.id, 'denied')}
                className="px-2 py-1 rounded border border-err text-err disabled:opacity-40 hover:bg-err hover:text-bg"
              >
                deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
