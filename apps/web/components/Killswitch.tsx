'use client';

import { useEffect, useState } from 'react';

interface Running { pid: number; agentId: string; workspaceId: string; uptimeMs: number }

export function Killswitch({ workspaceId }: { workspaceId: string }) {
  const [running, setRunning] = useState<Running[]>([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch('/api/killswitch/status');
      if (r.ok) setRunning((await r.json()).running ?? []);
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);

  async function kill() {
    if (!confirm(`Kill ${running.length} running agent(s) right now?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/killswitch?workspace=${workspaceId}`, { method: 'POST' });
      const j = await r.json();
      setLast(`killed ${j.killed} in ${j.durationMs}ms`);
      await refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="px-2 py-2 border-t border-line">
      <div className="text-dim text-[10px] uppercase tracking-wide mb-1">Killswitch</div>
      <button
        onClick={kill}
        disabled={busy}
        className={`w-full px-2 py-1 rounded text-xs font-medium ${running.length > 0 ? 'bg-err text-bg hover:brightness-110' : 'bg-line text-dim'} disabled:opacity-40`}
      >
        {busy ? 'stopping…' : running.length > 0 ? `STOP ALL (${running.length})` : 'no agents running'}
      </button>
      {last && <div className="text-dim text-[10px] mt-1">{last}</div>}
    </div>
  );
}
