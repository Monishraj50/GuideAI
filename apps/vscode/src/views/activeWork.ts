// 🎯 Active work — currently-running brief shown as a phase tree with tasks.
//
// Layout when a brief is active:
//   <brief title>
//     research · ✓ 3 done
//       ↳ task 1 · done · backend-developer
//       ↳ task 2 · done · qa-engineer
//     plan · ⏳ 2/5 in progress
//       ↳ task 1 · done · tech-lead
//       ↳ task 2 · in_progress · frontend-developer
//       ↳ task 3 · todo
//     implement · pending
//     review · pending
//     verify · pending
//
// When no brief is running, shows a friendly empty state with a link to
// Mission Control to view past briefs.

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

const PHASE_ORDER = ['research', 'plan', 'implement', 'review', 'verify'] as const;
type Phase = typeof PHASE_ORDER[number];

const STATUS_ICON: Record<WorkItem['status'], string> = {
  todo: 'circle-outline',
  in_progress: 'sync~spin',
  blocked: 'warning',
  done: 'check',
  cancelled: 'circle-slash',
};

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
        { label: 'No brief running', description: 'click + to start one', iconId: 'info' },
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

    // Fetch work items for this brief; group by phase.
    const items = await this.api.listWorkItems(wsId, active.id);
    const byPhase = new Map<Phase | 'other', WorkItem[]>();
    for (const p of PHASE_ORDER) byPhase.set(p, []);
    byPhase.set('other', []);
    for (const it of items) {
      const ph = (PHASE_ORDER as readonly string[]).includes(it.phase ?? '')
        ? (it.phase as Phase) : 'other';
      byPhase.get(ph)?.push(it);
    }

    const phaseNodes: Node[] = PHASE_ORDER.map((p): Node => {
      const taskList = byPhase.get(p) ?? [];
      const done = taskList.filter((t) => t.status === 'done').length;
      const inProgress = taskList.filter((t) => t.status === 'in_progress').length;
      const blocked = taskList.filter((t) => t.status === 'blocked').length;
      const total = taskList.length;

      const summary = total === 0
        ? 'pending'
        : done === total
          ? `✓ ${done} done`
          : inProgress > 0
            ? `⏳ ${done}/${total} · ${inProgress} running`
            : blocked > 0
              ? `⚠ ${blocked} blocked`
              : `${done}/${total}`;

      const phaseIcon = total === 0
        ? 'circle-outline'
        : done === total
          ? 'check'
          : inProgress > 0
            ? 'sync~spin'
            : blocked > 0
              ? 'warning'
              : 'circle-outline';

      return {
        label: p,
        description: summary,
        iconId: phaseIcon,
        children: taskList.map((t): Node => ({
          label: t.title,
          description: t.assignedRole ? `· ${t.assignedRole}` : undefined,
          tooltip: t.description ?? t.title,
          iconId: STATUS_ICON[t.status],
        })),
      };
    });

    // Tasks not bound to a known phase land in 'other' — only show the bucket if non-empty.
    const otherList = byPhase.get('other') ?? [];
    if (otherList.length > 0) {
      phaseNodes.push({
        label: 'other',
        description: `${otherList.length}`,
        iconId: 'list-unordered',
        children: otherList.map((t): Node => ({
          label: t.title,
          description: t.assignedRole ? `· ${t.assignedRole}` : undefined,
          iconId: STATUS_ICON[t.status],
        })),
      });
    }

    return [
      {
        label: active.body.split('\n')[0]?.slice(0, 60) ?? active.id,
        description: active.id,
        tooltip: active.body,
        iconId: 'rocket',
        children: phaseNodes,
        contextValue: 'activeBrief',
      },
    ];
  }
}
