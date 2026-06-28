// ✓ Progress tracker — tasks across the active workspace, bucketed by status.
//
// Three user-facing buckets:
//   Active   → work_item.status === 'in_progress'
//   Inactive → 'todo'  (or 'cancelled' — silently rolled in as "skipped")
//   Done     → 'done'  (or 'blocked' rolled in as "failed")
//
// Clicking a task opens that task's chat transcript at
//   <mdRoot>/agents/<role>/sessions/<briefId>-<phase>.md
// with markdown preview to side. If the task is still running, the preview
// auto-refreshes as the orchestrator appends new turns (live chat session).
// If done, the file is static (saved context).

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
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

const BUCKETS = [
  { id: 'active',   label: 'Active',   icon: 'play',           empty: 'no tasks running' },
  { id: 'inactive', label: 'Inactive', icon: 'circle-outline', empty: 'no waiting tasks' },
  { id: 'done',     label: 'Done',     icon: 'check',          empty: 'no completed tasks' },
] as const;
type BucketId = typeof BUCKETS[number]['id'];

function bucketOf(status: string): BucketId | null {
  if (status === 'in_progress') return 'active';
  if (status === 'todo') return 'inactive';
  if (status === 'done' || status === 'blocked') return 'done';
  return null; // cancelled = hidden
}

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

    const meta = await this.api.getWorkspaceMeta(wsId);
    const mdRoot = meta?.targetFolder?.trim()
      ? path.join(meta.targetFolder, 'atrune')
      : path.join(process.env.GUIDEAI_HOME || path.join(os.homedir(), '.guideai'), 'workspaces', wsId);

    const grouped: Record<BucketId, WorkItem[]> = { active: [], inactive: [], done: [] };
    for (const it of items) {
      const b = bucketOf(it.status);
      if (b) grouped[b].push(it);
    }

    return BUCKETS.map((g): Node => {
      const list = grouped[g.id];
      if (list.length === 0) {
        return { label: g.label, description: '0', iconId: g.icon };
      }
      return {
        label: g.label,
        description: `${list.length}`,
        iconId: g.icon,
        children: list.map((t): Node => {
          const isRunning = t.status === 'in_progress';
          const isFailed  = t.status === 'blocked';
          // Click → open a terminal running `claude --resume <brief-session-uuid>`
          // in the project folder. Same UX as if the user typed it themselves.
          return {
            label: t.title,
            description: [
              isRunning ? '● live' : '',
              isFailed ? 'failed' : '',
              t.assignedRole,
              t.phase,
            ].filter(Boolean).join(' · '),
            tooltip: 'Click to open the Claude session for this brief (claude --resume).\n\n' + (t.description ?? t.title),
            iconId: isRunning ? 'sync~spin'
              : isFailed     ? 'error'
              : t.status === 'done' ? 'check'
              : 'circle-outline',
            command: {
              command: 'atrune.openTaskClaudeTerminal',
              title: 'Open claude --resume <session> for this task',
              arguments: [{ workspaceId: wsId, taskId: t.id }],
            },
          };
        }),
      };
    });
  }
}
