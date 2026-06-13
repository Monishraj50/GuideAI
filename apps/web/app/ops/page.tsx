import { EventFeed } from './EventFeed';
import { BriefPane } from './BriefPane';
import { PendingTray } from './PendingTray';

const WORKSPACE_ID = 'demo';

export default function OpsPage() {
  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-line px-4 py-2 flex items-center justify-between">
          <div>
            <div className="text-ink font-medium">#ops</div>
            <div className="text-dim text-xs">live event feed · workspace <span className="text-ink">{WORKSPACE_ID}</span></div>
          </div>
          <div className="text-dim text-xs">step 5 — brief → agent → approval</div>
        </header>
        <EventFeed workspaceId={WORKSPACE_ID} />
      </div>
      <aside className="w-80 border-l border-line p-3 hidden lg:flex flex-col gap-6 overflow-y-auto">
        <BriefPane workspaceId={WORKSPACE_ID} />
        <div className="border-t border-line -mx-3" />
        <PendingTray workspaceId={WORKSPACE_ID} />
      </aside>
    </div>
  );
}
