'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, UserPlus, UserMinus, Sparkles, Skull, FileText, Filter } from 'lucide-react';
import { cn } from '../../lib/cn';

interface AuditEntry {
  ts: number;
  kind: 'approval' | 'hire' | 'retire' | 'skill' | 'killswitch' | 'digest';
  text: string;
  ruleId?: string;
  decidedBy?: string;
}

const KIND_META: Record<AuditEntry['kind'], { color: string; icon: React.ComponentType<{ size?: number }> }> = {
  approval:   { color: 'text-accent', icon: ShieldCheck },
  hire:       { color: 'text-info',   icon: UserPlus },
  retire:     { color: 'text-dim',    icon: UserMinus },
  skill:      { color: 'text-warn',   icon: Sparkles },
  killswitch: { color: 'text-err',    icon: Skull },
  digest:     { color: 'text-sonnet', icon: FileText },
};

export function AuditLog({ workspaceId }: { workspaceId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<string>('all');

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/audit?limit=200`);
    if (r.ok) setEntries((await r.json()).entries ?? []);
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [workspaceId]);

  const visible = filter === 'all' ? entries : entries.filter((e) => e.kind === filter);
  const kinds = Array.from(new Set(entries.map((e) => e.kind)));

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-accent" />
          <span className="text-ink font-medium text-sm">Audit log</span>
          <span className="text-dim2 text-[11px] font-mono">{entries.length}</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-dim">
          <Filter size={12} className="text-dim2" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-ink text-xs outline-none focus:border-accent/60"
          >
            <option value="all">all</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      <div className="border border-line/70 rounded-lg divide-y divide-line/40 bg-surface2/50 overflow-hidden">
        {visible.length === 0 && <div className="p-4 text-dim2 text-sm italic">No audit entries.</div>}
        {visible.map((e, i) => {
          const meta = KIND_META[e.kind];
          const Icon = meta.icon;
          return (
            <div key={i} className="px-3 py-2 flex items-center gap-3 text-xs hover:bg-line/20 transition-colors">
              <span className="text-dim2 font-mono w-20">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={cn('flex items-center gap-1 uppercase font-mono text-[10px] w-24', meta.color)}>
                <Icon size={10} /> {e.kind}
              </span>
              <span className="text-ink font-mono truncate flex-1" title={e.text}>{e.text}</span>
              {e.decidedBy && <span className="text-dim2 text-[10px] truncate max-w-[120px]">{e.decidedBy}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
