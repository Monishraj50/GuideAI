'use client';

import { useEffect, useState } from 'react';

interface AuditEntry {
  ts: number;
  kind: 'approval' | 'hire' | 'retire' | 'skill' | 'killswitch' | 'digest';
  text: string;
  ruleId?: string;
  decidedBy?: string;
}

const KIND_COLOR: Record<AuditEntry['kind'], string> = {
  approval:  'text-accent',
  hire:      'text-ink',
  retire:    'text-dim',
  skill:     'text-warn',
  killswitch:'text-err',
  digest:    'text-dim',
};

export function AuditLog({ workspaceId }: { workspaceId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/audit?limit=200`).then((r) => r.json()).then((j) => setEntries(j.entries ?? []));
    const t = setInterval(() => {
      fetch(`/api/workspaces/${workspaceId}/audit?limit=200`).then((r) => r.json()).then((j) => setEntries(j.entries ?? []));
    }, 4000);
    return () => clearInterval(t);
  }, [workspaceId]);

  const visible = filter === 'all' ? entries : entries.filter((e) => e.kind === filter);
  const kinds = Array.from(new Set(entries.map((e) => e.kind)));

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="text-ink font-medium text-sm">Audit log</div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-1 text-xs text-ink"
        >
          <option value="all">all ({entries.length})</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <div className="border border-line rounded divide-y divide-line text-xs">
        {visible.length === 0 && <div className="p-3 text-dim italic">No audit entries.</div>}
        {visible.map((e, i) => (
          <div key={i} className="p-2 flex items-center gap-3">
            <span className="text-dim font-mono w-24">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={`uppercase font-mono text-[10px] w-20 ${KIND_COLOR[e.kind]}`}>{e.kind}</span>
            <span className="text-ink font-mono truncate flex-1" title={e.text}>{e.text}</span>
            {e.decidedBy && <span className="text-dim text-[10px]">{e.decidedBy}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
