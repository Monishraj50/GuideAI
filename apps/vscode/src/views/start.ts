// 🚀 Start view — welcome-style tree of the most-used GuideAI commands.
// No data fetching, no async, no state — every row is a static entry point
// so a first-time user has a discoverable landing pad.

import * as vscode from 'vscode';

interface Node {
  label: string;
  iconId: string;
  tooltip: string;
  command: string;
}

const ROWS: Node[] = [
  { label: 'New brief…',              iconId: 'rocket',            tooltip: 'Compose and dispatch a full-pipeline brief',            command: 'atrune.newBrief' },
  { label: 'Quick task',              iconId: 'zap',               tooltip: 'One-shot task with a single agent (no pipeline)',        command: 'atrune.quickAsk' },
  { label: 'Auto-fix current file…',  iconId: 'wand',              tooltip: 'Describe a small fix; we route to a specialist',          command: 'atrune.autoFixThisFile' },
  { label: 'Open Kanban',             iconId: 'checklist',         tooltip: 'View the phase board for the active brief',              command: 'atrune.openKanban' },
  { label: 'Review task diff…',       iconId: 'diff',              tooltip: 'Approve/reject hunks from a completed task (S9)',        command: 'atrune.reviewTaskDiff' },
  { label: 'Resume session…',         iconId: 'comment-discussion',tooltip: 'Reopen a saved Claude session with prompt cache warm',    command: 'atrune.resumeSession' },
  { label: 'Browse packs…',           iconId: 'package',           tooltip: 'View / install / uninstall skill+agent packs',           command: 'atrune.browsePacks' },
];

export class StartProvider implements vscode.TreeDataProvider<Node> {
  private _emit = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._emit.event;
  refresh() { this._emit.fire(); }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(n.iconId);
    item.tooltip = n.tooltip;
    item.command = { title: n.label, command: n.command };
    return item;
  }

  async getChildren(): Promise<Node[]> {
    return ROWS;
  }
}
