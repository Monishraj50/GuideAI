import { RulesEditor } from './RulesEditor';
import { AuditLog } from './AuditLog';

export default function SettingsPage() {
  return (
    <div className="overflow-y-auto">
      <div className="p-8 max-w-5xl">
        <div className="mb-6">
          <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1">workspace · demo</div>
          <h1 className="text-ink text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-dim text-sm mt-1">Auto-approval rules + audit log.</p>
        </div>
        <RulesEditor />
        <div className="border-t border-line/70 mt-8 pt-6">
          <AuditLog workspaceId="demo" />
        </div>
      </div>
    </div>
  );
}
