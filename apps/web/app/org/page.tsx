import { OrgChart } from './OrgChart';

export default function OrgPage() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Org Chart</div>
        <div className="text-dim text-[11px] mt-0.5">your roster · heat-tinted by win-rate · sparkline = 7-day trend</div>
      </header>
      <OrgChart workspaceId="demo" />
    </div>
  );
}
