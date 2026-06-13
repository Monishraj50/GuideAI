import { ArrowLeft } from 'lucide-react';
import { Replay } from './Replay';

export default async function ReplayPage({ params }: { params: Promise<{ briefId: string }> }) {
  const { briefId } = await params;
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 flex items-center gap-4 glass">
        <a href="/logs" className="flex items-center gap-1 text-dim text-xs hover:text-ink transition-colors">
          <ArrowLeft size={12} /> all briefs
        </a>
        <div>
          <div className="text-ink font-medium">Replay <span className="font-mono text-dim text-sm ml-1">{briefId}</span></div>
          <div className="text-dim text-[11px] mt-0.5">scrub the trace · expand artifacts · toggle raw drawer</div>
        </div>
      </header>
      <Replay workspaceId="demo" briefId={briefId} />
    </div>
  );
}
