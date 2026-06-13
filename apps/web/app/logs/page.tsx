import { BriefList } from './BriefList';

export default function LogsPage() {
  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-line px-4 py-2">
        <div className="text-ink font-medium">Logs / Replay</div>
        <div className="text-dim text-xs">pick a brief to scrub its trace · workspace <span className="text-ink">demo</span></div>
      </header>
      <BriefList workspaceId="demo" />
    </div>
  );
}
