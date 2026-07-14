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
import * as path from 'node:path';
import * as os from 'node:os';
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
          description: 'open the new-project form',
          iconId: 'add',
          command: {
            command: 'atrune.newProject',
            title: 'Create a new project',
          },
        },
      ];
    }

    // Show every workspace the server returned. Server-side per-folder DB
    // routing (via the X-Atrune-Workspace header, consent-gated) already
    // scopes this list to the currently-open folder — a strict tree-side
    // targetFolder-must-match filter would double-gate and hide workspaces
    // whose meta.json has a null / stale / normalized-differently targetFolder
    // even though they legitimately live in this folder's .atrune/db.sqlite.
    const matching: WorkspaceSummary[] = all;

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
            command: 'atrune.openBriefOverallPlan',
            title: 'Open overallplan.md',
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
      // "Empty / needs setup" = no briefs dispatched yet. Click sends the
      // user back into the New Project tab in edit-mode to finish intake.
      // Empty projects render as a LEAF (no children) so the user sees only
      // the "needs setup" action — no confusing "dispatch one to start" hint.
      const needsSetup = w.totalBriefs === 0;
      return {
        label: w.name + (isActive ? '  •' : '') + (needsSetup ? '  ⚙' : ''),
        description: needsSetup
          ? 'needs setup · click to finish intake'
          : `${w.totalBriefs} brief${w.totalBriefs !== 1 ? 's' : ''} · ${w.agents} agent${w.agents !== 1 ? 's' : ''}`,
        tooltip: needsSetup
          ? `Workspace: ${w.id}\nNo briefs yet — click to open the intake form (name + goal + criteria + constraints).`
          : `Workspace: ${w.id}${isActive ? ' (active)' : ''}`,
        iconId: needsSetup ? 'gear' : (isActive ? 'folder-active' : 'folder'),
        children: needsSetup ? undefined : briefNodes,
        command: needsSetup
          ? {
              command: 'atrune.editProjectIntake',
              title: 'Finish project setup',
              arguments: [w.id],
            }
          : {
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
