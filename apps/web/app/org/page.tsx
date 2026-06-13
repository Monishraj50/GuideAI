import { OrgChart } from './OrgChart';

export default function OrgPage() {
  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-line px-4 py-2">
        <div className="text-ink font-medium">Org Chart</div>
        <div className="text-dim text-xs">your roster · heat-tinted by win-rate · workspace <span className="text-ink">demo</span></div>
      </header>
      <OrgChart workspaceId="demo" />
    </div>
  );
}
