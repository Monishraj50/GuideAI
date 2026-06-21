// 👥 Team — hired roster for the active project.
//
// Each agent node is clickable. Click → atrune.showAgentWork command, which
// fetches work items assigned to that agent's role and shows them in a
// QuickPick. Picking a work item offers to open Mission Control to the
// relevant project page.

import * as vscode from 'vscode';
import { AtruneApi, type Agent } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  agent?: Agent;
  command?: vscode.Command;
}

export class TeamProvider implements vscode.TreeDataProvider<Node> {
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
    if (node.command)     item.command = node.command;
    return item;
  }

  async getChildren(): Promise<Node[]> {
    const wsId = this.activeWorkspaceId();
    if (!wsId) return [{ label: 'No active project', iconId: 'info' }];

    const agents = await this.api.listAgents(wsId);
    if (agents.length === 0) {
      return [
        { label: 'No agents hired yet', description: 'auto-hires when you brief', iconId: 'info' },
        {
          label: 'Browse marketplace →',
          description: 'opens Hire in your browser',
          iconId: 'arrow-right',
          contextValue: 'openMarketplace',
          command: {
            command: 'atrune.openMissionControl',
            title: 'Open marketplace',
            arguments: [{ route: '/hire' }],
          },
        },
      ];
    }
    return agents.map((a): Node => ({
      label: a.displayName,
      description: a.role,
      tooltip: `${a.displayName} (${a.role}) · status: ${a.status} · click to see assigned work`,
      iconId: a.status === 'working' ? 'sync~spin' : a.status === 'retired' ? 'archive' : 'organization',
      contextValue: 'agent',
      agent: a,
      command: {
        command: 'atrune.showAgentWork',
        title: 'Show agent work',
        arguments: [{ workspaceId: wsId, agentId: a.id, role: a.role, displayName: a.displayName }],
      },
    }));
  }
}
