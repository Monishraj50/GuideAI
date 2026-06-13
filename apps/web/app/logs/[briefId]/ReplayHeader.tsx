'use client';

import { ArrowLeft } from 'lucide-react';

export function ReplayHeader({ briefId }: { briefId: string }) {
  return (
    <header className="border-b border-line/70 px-5 py-3 flex items-center gap-4 glass">
      <a href="/logs" className="flex items-center gap-1 text-dim text-xs hover:text-ink transition-colors">
        <ArrowLeft size={12} /> all briefs
      </a>
      <div>
        <div className="text-ink font-medium">Replay <span className="font-mono text-dim text-sm ml-1">{briefId}</span></div>
        <div className="text-dim text-[11px] mt-0.5">scrub the trace · expand artifacts · toggle raw drawer</div>
      </div>
    </header>
  );
}
