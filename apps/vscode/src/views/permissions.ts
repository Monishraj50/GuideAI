// 🛂 Permissions — pinned to the top of the sidebar. Every tool call in
// manual/custom mode surfaces here for Allow/Deny; Edit/Write show a diff
// preview when clicked.
//
// Layout:
//   🛂 Mode: Manual · switch…
//   🔴 Killswitch — stop everything
//   ── Pending ──
//     ⚠ Edit README.md          appr-3f2e91         [click → open diff]
//     ⚠ Bash: git status        appr-b8c740
//   ── Recent (last 5) ──
//     ✓ Read package.json                          approved · rule-builtin-read
//     ✗ Bash: rm -rf /                             hard-deny
//
// Mode is loaded from GET /api/policies/mode, switched via PUT.
// Session-allow scope is cleared server-side on brief completion (S2.5 spec).

import * as vscode from 'vscode';
import { AtruneApi } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  approvalId?: string;
  command?: vscode.Command;
}

export class PermissionsProvider implements vscode.TreeDataProvider<Node> {
  private _emit = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._emit.event;
  refresh() { this._emit.fire(); }

  constructor(
    private api: AtruneApi,
    private activeWorkspaceId: () => string | null,
  ) {}

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description) item.description = node.description;
    if (node.tooltip)     item.tooltip = node.tooltip;
    if (node.iconId)      item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.contextValue) item.contextValue = node.contextValue;
    if (node.command)      item.command = node.command;
    if (node.approvalId)   (item as any).approvalId = node.approvalId;
    return item;
  }

  async getChildren(): Promise<Node[]> {
    const wsId = this.activeWorkspaceId();
    const mode = await this.api.getPermissionMode();

    const out: Node[] = [
      {
        label: `Mode: ${prettyMode(mode)}`,
        description: 'click to change',
        iconId: modeIcon(mode),
        contextValue: 'permissionMode',
        command: { command: 'atrune.setPermissionMode', title: 'Set mode' },
      },
      {
        label: 'Killswitch — stop every running agent',
        iconId: 'debug-stop',
        contextValue: 'killswitch',
        command: { command: 'atrune.killswitch', title: 'Killswitch' },
      },
    ];

    if (!wsId) return out;

    const plan = await this.api.getPlan(wsId);
    const pending = plan?.pendingApprovals ?? [];
    out.push({ label: `── Pending (${pending.length}) ──`, iconId: 'watch' });

    if (pending.length === 0) {
      out.push({ label: 'No pending items', description: 'all clear', iconId: 'check' });
    } else {
      for (const p of pending) {
        const args = safeParse(p.argsJson);
        const summary = summarize(p.tool, args);
        out.push({
          label: summary,
          description: p.id.slice(-6),
          tooltip: `${summary}\n\n${p.argsJson}`,
          iconId: 'warning',
          contextValue: 'pendingApproval',
          approvalId: p.id,
          command: {
            command: 'atrune.reviewApproval',
            title: 'Review',
            arguments: [{ approvalId: p.id, tool: p.tool, args }],
          },
        });
      }
    }

    return out;
  }
}

function prettyMode(m: string): string {
  return m === 'auto' ? 'Auto' : m === 'custom' ? 'Custom' : 'Manual';
}
function modeIcon(m: string): string {
  return m === 'auto' ? 'rocket' : m === 'custom' ? 'law' : 'shield';
}
function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof args.command === 'string') {
    return `Bash: ${truncate(args.command as string, 60)}`;
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof args.file_path === 'string') {
    return `${tool} ${shortPath(args.file_path as string)}`;
  }
  if (tool === 'WebFetch' && typeof args.url === 'string') {
    return `WebFetch ${truncate(args.url as string, 60)}`;
  }
  return `${tool} ${truncate(JSON.stringify(args), 60)}`;
}
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 3 ? p : '…/' + parts.slice(-3).join('/');
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
