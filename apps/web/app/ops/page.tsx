import { EventFeed } from './EventFeed';

export default function OpsPage() {
  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-line px-4 py-2 flex items-center justify-between">
          <div>
            <div className="text-ink font-medium">#ops</div>
            <div className="text-dim text-xs">live event feed · workspace <span className="text-ink">demo</span></div>
          </div>
          <div className="text-dim text-xs">
            step 4 demo — read-only feed
          </div>
        </header>
        <EventFeed workspaceId="demo" />
      </div>
      <aside className="w-80 border-l border-line p-3 hidden lg:flex flex-col gap-2">
        <div className="text-ink font-medium text-sm">Brief the team</div>
        <div className="text-dim text-xs">Brief pane lands in step 5 (single-agent end-to-end).</div>
        <textarea
          className="mt-2 bg-bg border border-line rounded p-2 text-sm text-ink resize-none h-32 opacity-50"
          placeholder="What should the team do?"
          disabled
        />
      </aside>
    </div>
  );
}
