import { BriefList } from './BriefList';

export default function LogsPage() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Logs / Replay</div>
        <div className="text-dim text-[11px] mt-0.5">pick a brief to scrub its trace</div>
      </header>
      <BriefList workspaceId="demo" />
    </div>
  );
}
