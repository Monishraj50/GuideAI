// 🎯 Active work — currently-running brief shown as a phase tree.

import * as vscode from 'vscode';
import { AtruneApi, type PlanResp } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  children?: Node[];
  command?: vscode.Command;
}

const PHASE_ORDER = ['research', 'plan', 'implement', 'review', 'verify'] as const;

export class ActiveWorkProvider implements vscode.TreeDataProvider<Node> {
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
    if (node.command)     item.command = node.command;
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (parent) return parent.children ?? [];

    const wsId = this.activeWorkspaceId();
    if (!wsId) {
      return [{ label: 'No active project', description: 'Open a folder to select one', iconId: 'info' }];
    }

    const plan = await this.api.getPlan(wsId);
    if (!plan) {
      return [{ label: 'Server not reachable', description: 'check the Atrune output channel', iconId: 'warning' }];
    }

    const active = plan.briefs.recent.find((b) => b.status === 'active');
    if (!active) {
      return [
        {
          label: 'No brief running',
          description: 'click + to start one',
          iconId: 'info',
        },
        ...(plan.briefs.recent.length > 0
          ? [{
              label: `View all briefs (${plan.briefs.total}) →`,
              description: 'opens in browser',
              iconId: 'arrow-right',
              contextValue: 'openMissionControl',
              command: {
                command: 'atrune.openMissionControl',
                title: 'Open Mission Control',
                arguments: [{}],
              },
            }]
          : []),
      ];
    }

    // Show the active brief as a phase tree.
    return [
      {
        label: active.body.split('\n')[0]?.slice(0, 60) ?? active.id,
        description: active.id,
        tooltip: active.body,
        iconId: 'rocket',
        children: PHASE_ORDER.map((p, i): Node => ({
          label: p,
          description: i < active.tasks ? '✓ done' : '· pending',
          iconId: i < active.tasks ? 'check' : 'circle-outline',
        })),
      },
    ];
  }
}
