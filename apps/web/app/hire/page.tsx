'use client';

import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { HireMarketplace } from './HireMarketplace';

export default function HirePage() {
  const workspaceId = useWorkspaceId();
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Hire</div>
        <div className="text-dim text-[11px] mt-0.5">browse the 154-agent catalog · hiring into <span className="font-mono text-ink2">{workspaceId}</span></div>
      </header>
      <HireMarketplace workspaceId={workspaceId} />
    </div>
  );
}
