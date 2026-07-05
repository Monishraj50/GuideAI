// 💬 Sessions view — Features → session UUIDs. Click a session to resume
// (opens a terminal with `claude --resume <id>` in the session's original cwd).
//
// Data comes from GET /api/workspaces/:id/sessions/features. Feature slugs
// group; each session leaf shows outcome + tokens for quick triage.

import * as vscode from 'vscode';
import { AtruneApi } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  command?: vscode.Command;
  children?: Node[];
}

export class SessionsProvider implements vscode.TreeDataProvider<Node> {
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
    if (!wsId) return [{ label: 'No active project', iconId: 'info' }];
    const j = await this.api.listSessionsByFeature(wsId);
    if (j.count === 0) return [{ label: 'No saved sessions yet', description: 'dispatch a brief to start', iconId: 'info' }];

    const outcomeIcon: Record<string, string> = {
      shipped: 'check', partial: 'warning', abandoned: 'circle-slash',
    };

    return j.features.map((g): Node => ({
      label: g.featureSlug,
      description: `${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'}`,
      iconId: 'symbol-namespace',
      contextValue: 'sessionFeature',
      children: g.sessions.map((s): Node => ({
        label: s.id.slice(0, 8) + '…',
        description: `${s.outcome} · ${s.tokensIn}↓/${s.tokensOut}↑ · $${s.costUsd.toFixed(4)}`,
        tooltip: `${s.id}\n\nrole: ${s.role ?? '—'}\nbrief: ${s.briefSnippet ?? ''}\nended: ${s.endedAt ? new Date(s.endedAt).toLocaleString() : '—'}`,
        iconId: outcomeIcon[s.outcome] ?? 'debug-alt',
        contextValue: 'sessionRow',
        command: {
          command: 'atrune.resumeSessionById',
          title: 'Resume session',
          arguments: [{ sessionId: s.id, jsonlPath: s.jsonlPath }],
        },
      })),
    }));
  }
}
