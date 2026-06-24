// 🎯 Active work — Projects in the current folder, with their briefs.
//
// Layout:
//   📂 Projects in /home/me/myrepo
//     📁 habitloop          ← workspace
//       🚀 Build the signup flow      brief-7a2c4b · active
//       ✓ Push to GitHub               brief-3a1b0c · done
//     📁 quicklink-test
//       ✓ Initial scaffold              brief-9d1e8f · done
//
// "Current folder" = the first VS Code workspaceFolder. We match workspaces
// by their meta.json#targetFolder. If no targetFolder is set anywhere, we
// fall back to listing ALL workspaces (zero-config case).
//
// Click a brief → fires `atrune.openBriefInMissionControl` → opens
// Mission Control to /projects/<workspaceId> in the browser.

import * as vscode from 'vscode';
import { AtruneApi, type WorkspaceSummary } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  children?: Node[];
  command?: vscode.Command;
}

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

    const all = await this.api.listWorkspaces();
    if (all.length === 0) {
      return [
        { label: 'No projects yet', iconId: 'info' },
        {
          label: 'Create a project →',
          description: 'intake + discovery in a tab',
          iconId: 'add',
          command: {
            command: 'atrune.newProject',
            title: 'Create a new project',
          },
        },
      ];
    }

    // Filter workspaces by the open folder, if any.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    let matching: WorkspaceSummary[] = all;
    if (cwd) {
      const annotated = await Promise.all(all.map(async (w) => {
        const meta = await this.api.getWorkspaceMeta(w.id);
        const folder = meta?.targetFolder ?? null;
        const matches = !!folder && (folder === cwd || folder.startsWith(cwd + '/') || cwd.startsWith(folder + '/'));
        return { ws: w, matches };
      }));
      const filtered = annotated.filter((a) => a.matches).map((a) => a.ws);
      // If at least one workspace has a folder binding to here, show only
      // those. Otherwise (nothing bound), show all so the user isn't blank.
      matching = filtered.length > 0 ? filtered : all;
    }

    // For each workspace, list its briefs (top 5, most recent).
    const projectNodes = await Promise.all(matching.map(async (w): Promise<Node> => {
      const plan = await this.api.getPlan(w.id);
      const briefs = plan?.briefs.recent ?? [];
      const briefNodes: Node[] = briefs.slice(0, 8).map((b): Node => {
        const title = (b.body.split('\n')[0] ?? b.id).slice(0, 60);
        return {
          label: title,
          description: `${b.id.slice(-6)} · ${b.status}`,
          tooltip: b.body,
          iconId: briefIconFor(b.status),
          command: {
            command: 'atrune.openBriefInMissionControl',
            title: 'Open brief in Mission Control',
            arguments: [{ workspaceId: w.id, briefId: b.id }],
          },
        };
      });

      if (briefNodes.length === 0) {
        briefNodes.push({
          label: 'No briefs yet',
          description: 'dispatch one to start',
          iconId: 'dash',
        });
      }

      const isActive = w.id === this.activeWorkspaceId();
      return {
        label: w.name + (isActive ? '  •' : ''),
        description: `${w.totalBriefs} brief${w.totalBriefs !== 1 ? 's' : ''} · ${w.agents} agent${w.agents !== 1 ? 's' : ''}`,
        tooltip: `Workspace: ${w.id}${isActive ? ' (active)' : ''}`,
        iconId: isActive ? 'folder-active' : 'folder',
        children: briefNodes,
        command: {
          command: 'atrune.switchToWorkspace',
          title: 'Make this the active project',
          arguments: [w.id],
        },
      };
    }));

    return projectNodes;
  }
}

function briefIconFor(status: string): string {
  switch (status) {
    case 'active':    return 'rocket';
    case 'done':      return 'check';
    case 'failed':    return 'error';
    case 'archived':  return 'archive';
    default:          return 'circle-outline';
  }
}
