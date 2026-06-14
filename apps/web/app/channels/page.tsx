'use client';

import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { ChannelsView } from './ChannelsView';

export default function ChannelsPage() {
  const workspaceId = useWorkspaceId();
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Channels</div>
        <div className="text-dim text-[11px] mt-0.5">filtered views of the workspace event stream · workspace <span className="font-mono text-ink2">{workspaceId}</span></div>
      </header>
      <ChannelsView workspaceId={workspaceId} />
    </div>
  );
}
