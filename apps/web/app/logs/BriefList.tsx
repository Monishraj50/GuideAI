'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, FileText } from 'lucide-react';
import { cn } from '../../lib/cn';

interface BriefRow {
  id: string;
  body: string;
  status: string;
  createdAt: number;
  phaseCount: number;
  tokensIn: number;
  tokensOut: number;
}

const STATUS_BADGE: Record<string, string> = {
  done:    'border-accent/40 text-accent bg-accent/10',
  active:  'border-warn/40 text-warn bg-warn/10',
  failed:  'border-err/40 text-err bg-err/10',
  pending: 'border-line text-dim bg-line/30',
};

export function BriefList({ workspaceId }: { workspaceId: string }) {
  const [briefs, setBriefs] = useState<BriefRow[]>([]);
  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/briefs`).then((r) => r.json()).then((j) => setBriefs(j.briefs ?? []));
  }, [workspaceId]);

  return (
    <ol className="flex-1 min-h-0 overflow-y-auto divide-y divide-line/40">
      {briefs.length === 0 && (
        <li className="px-6 py-12 text-center">
          <FileText size={20} className="text-dim2 mx-auto mb-2" />
          <div className="text-ink text-sm">No briefs yet</div>
          <div className="text-dim text-xs mt-1">Submit one in <a className="text-accent underline" href="/ops">/ops</a></div>
        </li>
      )}
      {briefs.map((b) => (
        <li key={b.id} className="hover:bg-line/20 transition-colors group">
          <a href={`/logs/${b.id}`} className="block px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-dim2">{b.id}</span>
              <span className={cn(
                'text-[10px] uppercase font-mono px-1.5 py-0.5 rounded-full border',
                STATUS_BADGE[b.status] ?? STATUS_BADGE.pending,
              )}>{b.status}</span>
              <span className="text-dim2 text-[11px] ml-auto">{new Date(b.createdAt).toLocaleString()}</span>
              <ArrowRight size={12} className="text-dim2 group-hover:text-accent transition-colors" />
            </div>
            <div className="text-ink text-sm mt-1.5 truncate">{b.body}</div>
            <div className="text-dim2 text-[11px] mt-1 font-mono">
              {b.phaseCount} phases · {b.tokensIn.toLocaleString()}↓ / {b.tokensOut.toLocaleString()}↑
            </div>
          </a>
        </li>
      ))}
    </ol>
  );
}
