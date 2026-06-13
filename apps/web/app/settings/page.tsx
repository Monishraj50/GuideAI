import { RulesEditor } from './RulesEditor';

export default function SettingsPage() {
  return (
    <div className="p-6 max-w-3xl">
      <div className="text-ink font-medium text-lg mb-1">Settings</div>
      <div className="text-dim text-xs mb-6">Auto-approval rules · model tiers · budgets land here over steps 8–12.</div>
      <RulesEditor />
    </div>
  );
}
