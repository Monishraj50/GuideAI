import { HireMarketplace } from './HireMarketplace';

export default function HirePage() {
  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-line px-4 py-2">
        <div className="text-ink font-medium">Hire</div>
        <div className="text-dim text-xs">browse the 154-agent catalog · workspace <span className="text-ink">demo</span></div>
      </header>
      <HireMarketplace workspaceId="demo" />
    </div>
  );
}
