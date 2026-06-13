import { HireMarketplace } from './HireMarketplace';

export default function HirePage() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Hire</div>
        <div className="text-dim text-[11px] mt-0.5">browse the 154-agent catalog · 10 departments</div>
      </header>
      <HireMarketplace workspaceId="demo" />
    </div>
  );
}
