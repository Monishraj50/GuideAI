'use client';

import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { BriefList } from './BriefList';

export default function LogsPage() {
  const workspaceId = useWorkspaceId();
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Logs / Replay</div>
        <div className="text-dim text-[11px] mt-0.5">project <span className="font-mono text-ink2">{workspaceId}</span></div>
      </header>
      <BriefList workspaceId={workspaceId} />
    </div>
  );
}
