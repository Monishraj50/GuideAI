// ✓ Progress tracker — all tasks across the active workspace, grouped by
// status. Replaces the old Pending view (which only showed tool approvals;
// those now surface exclusively as native VS Code popups via approvals.ts).
//
// Status mapping (work-item status → user-facing tag):
//   in_progress → Active
//   todo        → Inactive
//   done        → Completed
//   blocked     → Not completed
//   cancelled   → Abandoned

import * as vscode from 'vscode';
import { AtruneApi, type WorkItem } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  children?: Node[];
  command?: vscode.Command;
}

const STATUS_GROUPS = [
  { id: 'in_progress', label: 'Active',         icon: 'sync~spin' },
  { id: 'todo',        label: 'Inactive',       icon: 'circle-outline' },
  { id: 'done',        label: 'Completed',      icon: 'check' },
  { id: 'blocked',     label: 'Not completed',  icon: 'warning' },
  { id: 'cancelled',   label: 'Abandoned',      icon: 'circle-slash' },
] as const;

type Status = typeof STATUS_GROUPS[number]['id'];

const STATUS_ICON: Record<Status, string> = Object.fromEntries(
  STATUS_GROUPS.map((g) => [g.id, g.icon]),
) as Record<Status, string>;

export class ProgressProvider implements vscode.TreeDataProvider<Node> {
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

    const items = await this.api.listWorkItems(wsId);
    if (items.length === 0) {
      return [{ label: 'No tasks yet', description: 'dispatch a brief to start', iconId: 'info' }];
    }

    // Bucket items by status.
    const buckets = new Map<Status, WorkItem[]>();
    for (const g of STATUS_GROUPS) buckets.set(g.id, []);
    for (const it of items) {
      const s = (STATUS_GROUPS.find((g) => g.id === it.status)?.id) as Status | undefined;
      if (s) buckets.get(s)!.push(it);
    }

    // Render only non-empty buckets to keep the tree tight; Active and
    // Inactive are always shown so the user sees there's no work either.
    const ALWAYS_SHOW: Status[] = ['in_progress', 'todo'];

    return STATUS_GROUPS.flatMap((g): Node[] => {
      const list = buckets.get(g.id)!;
      if (list.length === 0 && !ALWAYS_SHOW.includes(g.id)) return [];

      // Empty buckets render as a leaf row (count = 0, no expand arrow).
      // Non-empty buckets render as expandable parents with task children.
      if (list.length === 0) {
        return [{
          label: g.label,
          description: '0',
          iconId: g.icon,
        }];
      }

      return [{
        label: g.label,
        description: `${list.length}`,
        iconId: g.icon,
        children: list.map((t): Node => ({
          label: t.title,
          description: [t.assignedRole, t.phase].filter(Boolean).join(' · '),
          tooltip: t.description ?? t.title,
          iconId: STATUS_ICON[t.status as Status] ?? 'circle-outline',
          command: t.briefId ? {
            command: 'atrune.openBriefInMissionControl',
            title: 'Open brief',
            arguments: [{ workspaceId: t.workspaceId, briefId: t.briefId }],
          } : undefined,
        })),
      }];
    });
  }
}
