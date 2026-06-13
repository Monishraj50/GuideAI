import { EventFeed } from './EventFeed';
import { BriefPane } from './BriefPane';
import { PendingTray } from './PendingTray';

const WORKSPACE_ID = 'demo';

export default function OpsPage() {
  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-line/70 px-5 py-3 flex items-center justify-between glass">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-ink font-medium">#ops</span>
              <span className="text-dim2 text-xs">·</span>
              <span className="text-dim text-xs">live event feed</span>
            </div>
            <div className="text-dim text-[11px] mt-0.5">events streamed via SSE from <span className="text-ink2 font-mono">{WORKSPACE_ID}</span></div>
          </div>
        </header>
        <EventFeed workspaceId={WORKSPACE_ID} />
      </div>
      <aside className="w-[360px] border-l border-line/70 flex flex-col glass">
        <div className="p-4 border-b border-line/70">
          <BriefPane workspaceId={WORKSPACE_ID} />
        </div>
        <div className="p-4 flex-1 min-h-0 overflow-y-auto">
          <PendingTray workspaceId={WORKSPACE_ID} />
        </div>
      </aside>
    </div>
  );
}
