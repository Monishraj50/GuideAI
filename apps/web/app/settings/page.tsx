import { RulesEditor } from './RulesEditor';
import { AuditLog } from './AuditLog';

export default function SettingsPage() {
  return (
    <div className="p-6 max-w-4xl">
      <div className="text-ink font-medium text-lg mb-1">Settings</div>
      <div className="text-dim text-xs mb-6">Auto-approval rules + audit log.</div>
      <RulesEditor />
      <div className="border-t border-line mt-8 pt-6">
        <AuditLog workspaceId="demo" />
      </div>
    </div>
  );
}
