import { Replay } from './Replay';
import { ReplayHeader } from './ReplayHeader';

export default async function ReplayPage({ params }: { params: Promise<{ briefId: string }> }) {
  const { briefId } = await params;
  return (
    <div className="flex flex-col h-full min-h-0">
      <ReplayHeader briefId={briefId} />
      <ReplayClient briefId={briefId} />
    </div>
  );
}

import { ReplayClient } from './ReplayClient';
