// 📂 Features view (S13) — the "map" of a project.
//
// Every feature in PROJECT.md becomes a row; expanding shows the sessions
// that worked on it. Feature-level status dot is derived from session
// outcomes (any shipped → ✓; else any partial → ⚠; else all abandoned → ✗).
//
// Data source: GET /api/workspaces/:id/sessions/features (same endpoint S7
// added). Feature status is a client-side rollup so we don't need a new
// server-side FEATURE.md parser here.

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

type FeatureStatus = 'shipped' | 'partial' | 'abandoned' | 'planned';

function featureStatus(sessions: Array<{ outcome: string }>): FeatureStatus {
  if (sessions.length === 0) return 'planned';
  if (sessions.some((s) => s.outcome === 'shipped')) return 'shipped';
  if (sessions.some((s) => s.outcome === 'partial')) return 'partial';
  return 'abandoned';
}

const STATUS_ICON: Record<FeatureStatus, string> = {
  shipped: 'pass-filled',
  partial: 'warning',
  abandoned: 'circle-slash',
  planned: 'circle-outline',
};

const OUTCOME_ICON: Record<string, string> = {
  shipped: 'check', partial: 'warning', abandoned: 'circle-slash',
};

export class FeaturesProvider implements vscode.TreeDataProvider<Node> {
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
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    if (node.description)  item.description = node.description;
    if (node.tooltip)      item.tooltip = node.tooltip;
    if (node.iconId)       item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.contextValue) item.contextValue = node.contextValue;
    if (node.command)      item.command = node.command;
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (parent) return parent.children ?? [];
    const wsId = this.activeWorkspaceId();
    if (!wsId) return [{ label: 'No active project', iconId: 'info' }];
    const j = await this.api.listSessionsByFeature(wsId);
    if (j.count === 0) return [{ label: 'No features yet', description: 'dispatch a brief to start', iconId: 'info' }];

    return j.features.map((g): Node => {
      const st = featureStatus(g.sessions);
      const totalTokIn  = g.sessions.reduce((s, x) => s + x.tokensIn, 0);
      const totalTokOut = g.sessions.reduce((s, x) => s + x.tokensOut, 0);
      const totalCost   = g.sessions.reduce((s, x) => s + x.costUsd, 0);
      return {
        label: g.featureSlug,
        description: `${st} · ${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'} · $${totalCost.toFixed(4)}`,
        tooltip: `Status: ${st}\nSessions: ${g.sessions.length}\nTokens: ${totalTokIn}↓ / ${totalTokOut}↑`,
        iconId: STATUS_ICON[st],
        contextValue: 'feature',
        children: g.sessions.map((s): Node => ({
          label: s.id.slice(0, 8) + '…',
          description: `${s.outcome} · ${s.tokensIn}↓/${s.tokensOut}↑ · $${s.costUsd.toFixed(4)}`,
          tooltip: `${s.id}\n\nrole: ${s.role ?? '—'}\nbrief: ${s.briefSnippet ?? ''}\nended: ${s.endedAt ? new Date(s.endedAt).toLocaleString() : '—'}`,
          iconId: OUTCOME_ICON[s.outcome] ?? 'debug-alt',
          contextValue: 'sessionRow',
          command: {
            command: 'atrune.resumeSessionById',
            title: 'Resume session',
            arguments: [{ sessionId: s.id, jsonlPath: s.jsonlPath }],
          },
        })),
      };
    });
  }
}
