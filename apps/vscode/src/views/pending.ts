// ✅ Pending — tool approvals + queued hires. Interrupt-driven.

import * as vscode from 'vscode';
import { AtruneApi } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  approvalId?: string;
  children?: Node[];
}

export class PendingProvider implements vscode.TreeDataProvider<Node> {
  private _emit = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._emit.event;
  refresh() { this._emit.fire(); }

  constructor(
    private api: AtruneApi,
    private activeWorkspaceId: () => string | null,
  ) {}

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children?.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    if (node.description) item.description = node.description;
    if (node.tooltip)     item.tooltip = node.tooltip;
    if (node.iconId)      item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.contextValue) item.contextValue = node.contextValue;
    if (node.approvalId) {
      // Persist the approval id so the right-click menu can act on it.
      (item as any).approvalId = node.approvalId;
    }
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (parent) return parent.children ?? [];
    const wsId = this.activeWorkspaceId();
    if (!wsId) return [{ label: 'No active project', iconId: 'info' }];

    const plan = await this.api.getPlan(wsId);
    if (!plan) return [{ label: 'Server not reachable', iconId: 'warning' }];

    if (plan.pendingApprovals.length === 0) {
      return [{ label: 'No pending items', description: 'all clear', iconId: 'check' }];
    }

    return plan.pendingApprovals.map((p): Node => {
      let args: any = {};
      try { args = JSON.parse(p.argsJson); } catch {}
      const summary = `${p.tool}(${typeof args.cmd === 'string' ? args.cmd.slice(0, 60) : JSON.stringify(args).slice(0, 60)})`;
      return {
        label: summary,
        description: p.id.slice(-6),
        tooltip: summary + '\n\n' + p.argsJson,
        iconId: 'warning',
        contextValue: 'pendingApproval',
        approvalId: p.id,
      };
    });
  }
}
