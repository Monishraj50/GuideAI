// 👥 Team — hired roster + per-agent task transcripts.
//
// Each agent node is collapsible. Children are the on-disk transcript files
// at <repo>/atrune/agents/<role>/sessions/*.md — one per phase task.
// Clicking a child opens the markdown file in the editor with preview-to-side.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AtruneApi, type Agent } from '../api';

interface AgentNode {
  kind: 'agent';
  label: string;
  agent: Agent;
  workspaceId: string;
}

interface TaskNode {
  kind: 'task';
  label: string;
  filePath: string;
  description?: string;
}

interface InfoNode {
  kind: 'info';
  label: string;
  description?: string;
  iconId?: string;
  command?: vscode.Command;
}

type Node = AgentNode | TaskNode | InfoNode;

export class TeamProvider implements vscode.TreeDataProvider<Node> {
  private _emit = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._emit.event;
  refresh() { this._emit.fire(); }

  constructor(
    private api: AtruneApi,
    private activeWorkspaceId: () => string | null,
  ) {}

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'agent') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      const a = node.agent;
      item.description = a.role;
      item.tooltip = `${a.displayName} (${a.role}) · status: ${a.status} · expand to see task transcripts`;
      item.iconPath = new vscode.ThemeIcon(
        a.status === 'working' ? 'sync~spin' : a.status === 'retired' ? 'archive' : 'organization',
      );
      item.contextValue = 'agent';
      return item;
    }
    if (node.kind === 'task') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = `Open transcript: ${node.filePath}`;
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'taskTranscript';
      item.command = {
        command: 'atrune.openTaskTranscript',
        title: 'Open task transcript',
        arguments: [{ filePath: node.filePath }],
      };
      return item;
    }
    // info
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description) item.description = node.description;
    if (node.iconId)      item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.command)     item.command = node.command;
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element?.kind === 'agent') {
      return this.transcriptsForRole(element.workspaceId, element.agent.role);
    }
    const wsId = this.activeWorkspaceId();
    if (!wsId) return [{ kind: 'info', label: 'No active project', iconId: 'info' }];

    const agents = await this.api.listAgents(wsId);
    if (agents.length === 0) {
      return [
        { kind: 'info', label: 'No agents hired yet', description: 'auto-hires when you brief', iconId: 'info' },
        {
          kind: 'info',
          label: 'Browse marketplace →',
          description: 'opens Hire in your browser',
          iconId: 'arrow-right',
          command: {
            command: 'atrune.openMissionControl',
            title: 'Open marketplace',
            arguments: [{ route: '/hire' }],
          },
        },
      ];
    }
    return agents.map((a): AgentNode => ({ kind: 'agent', label: a.displayName, agent: a, workspaceId: wsId }));
  }

  private async transcriptsForRole(workspaceId: string, role: string): Promise<Node[]> {
    const mdRoot = await resolveMdRoot(this.api, workspaceId);
    if (!mdRoot) return [{ kind: 'info', label: 'No transcripts yet', description: 'agent hasn’t run', iconId: 'info' }];
    const dir = path.join(mdRoot, 'agents', role, 'sessions');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch { /* directory doesn't exist yet */ }
    if (files.length === 0) {
      return [{ kind: 'info', label: 'No transcripts yet', description: 'agent hasn’t run', iconId: 'info' }];
    }
    files.sort();
    return files.map((f): TaskNode => {
      const taskId = f.replace(/\.md$/, '');
      return {
        kind: 'task',
        label: taskId,
        description: 'transcript',
        filePath: path.join(dir, f),
      };
    });
  }
}

/** Resolve the workspace's markdown root: <targetFolder>/atrune if bound,
 *  else the sandbox storage path. */
async function resolveMdRoot(api: AtruneApi, workspaceId: string): Promise<string | null> {
  const meta = await api.getWorkspaceMeta(workspaceId);
  if (meta?.targetFolder?.trim()) {
    return path.join(meta.targetFolder, 'atrune');
  }
  const home = process.env.GUIDEAI_HOME || path.join(os.homedir(), '.guideai');
  return path.join(home, 'workspaces', workspaceId);
}
