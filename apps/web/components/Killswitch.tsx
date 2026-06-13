'use client';

import { useEffect, useState } from 'react';
import { Skull, Square } from 'lucide-react';
import { cn } from '../lib/cn';
import { toast } from './Toast';

interface Running { pid: number; agentId: string; workspaceId: string; uptimeMs: number }

export function Killswitch({ workspaceId }: { workspaceId: string }) {
  const [running, setRunning] = useState<Running[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const r = await fetch('/api/killswitch/status');
      if (r.ok) setRunning((await r.json()).running ?? []);
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);

  async function kill() {
    if (running.length === 0) return;
    if (!confirm(`Kill ${running.length} running agent(s) right now?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/killswitch?workspace=${workspaceId}`, { method: 'POST' });
      const j = await r.json();
      toast({
        title: `Killed ${j.killed} agent${j.killed === 1 ? '' : 's'}`,
        description: `in ${j.durationMs}ms`,
        variant: 'warn',
      });
      await refresh();
    } finally { setBusy(false); }
  }

  const armed = running.length > 0;

  return (
    <button
      onClick={kill}
      disabled={busy || !armed}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium border transition-all',
        armed
          ? 'bg-err/[0.08] border-err/40 text-err hover:bg-err/[0.16] shadow-glowR'
          : 'bg-transparent border-line/60 text-dim2 cursor-default',
      )}
    >
      {armed ? <Skull size={14} /> : <Square size={14} />}
      <span className="flex-1 text-left">
        {busy ? 'stopping…' : armed ? `STOP ALL (${running.length})` : 'no agents running'}
      </span>
      {armed && <span className="w-1.5 h-1.5 rounded-full bg-err pulse-dot" />}
    </button>
  );
}
