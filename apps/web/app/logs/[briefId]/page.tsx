import { Replay } from './Replay';

export default async function ReplayPage({ params }: { params: Promise<{ briefId: string }> }) {
  const { briefId } = await params;
  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-line px-4 py-2 flex items-center gap-3">
        <a href="/logs" className="text-dim text-xs hover:text-ink">← all briefs</a>
        <div>
          <div className="text-ink font-medium">Replay <span className="font-mono text-dim text-sm">{briefId}</span></div>
          <div className="text-dim text-xs">scrub the trace · open the raw drawer · read artifacts</div>
        </div>
      </header>
      <Replay workspaceId="demo" briefId={briefId} />
    </div>
  );
}
