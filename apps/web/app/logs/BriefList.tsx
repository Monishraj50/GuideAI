'use client';

import { useEffect, useState } from 'react';

interface BriefRow {
  id: string;
  body: string;
  status: string;
  createdAt: number;
  phaseCount: number;
  tokensIn: number;
  tokensOut: number;
}

const STATUS_COLOR: Record<string, string> = {
  done: 'text-accent',
  active: 'text-warn',
  failed: 'text-err',
  pending: 'text-dim',
};

export function BriefList({ workspaceId }: { workspaceId: string }) {
  const [briefs, setBriefs] = useState<BriefRow[]>([]);
  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/briefs`).then((r) => r.json()).then((j) => setBriefs(j.briefs ?? []));
  }, [workspaceId]);

  return (
    <ol className="flex-1 min-h-0 overflow-y-auto divide-y divide-line">
      {briefs.length === 0 && (
        <li className="px-4 py-6 text-dim text-sm italic">No briefs yet. Submit one in <a className="text-accent underline" href="/ops">/ops</a>.</li>
      )}
      {briefs.map((b) => (
        <li key={b.id} className="px-4 py-3 hover:bg-line">
          <a href={`/logs/${b.id}`} className="block">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-dim">{b.id}</span>
              <span className={`text-xs uppercase ${STATUS_COLOR[b.status] ?? 'text-dim'}`}>{b.status}</span>
              <span className="text-dim text-xs ml-auto">{new Date(b.createdAt).toLocaleString()}</span>
            </div>
            <div className="text-ink text-sm mt-1 truncate">{b.body}</div>
            <div className="text-dim text-xs mt-1">
              {b.phaseCount} phases · {b.tokensIn.toLocaleString()}↓ / {b.tokensOut.toLocaleString()}↑
            </div>
          </a>
        </li>
      ))}
    </ol>
  );
}
