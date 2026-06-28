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
  // Live-Claude terminal coords (set when we can parse them from the
  // transcript filename `<briefId>-<phase>.md`).
  workspaceId?: string;
  briefId?: string;
  phase?: string;
  role?: string;
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
      item.tooltip = `Open Claude session for this brief (claude --resume)`;
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'taskTranscript';
      item.command = (node.workspaceId && node.briefId)
        ? {
            command: 'atrune.openTaskClaudeTerminal',
            title: 'Open claude --resume <session> for this task',
            arguments: [{ workspaceId: node.workspaceId, briefId: node.briefId }],
          }
        : {
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
    let files: { name: string; mtime: number; size: number }[] = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, mtime: st.mtimeMs, size: st.size };
        });
    } catch { /* directory doesn't exist yet */ }
    if (files.length === 0) {
      return [{ kind: 'info', label: 'No transcripts yet', description: 'agent hasn’t run', iconId: 'info' }];
    }
    // Cross-reference work-items so we can show task title + live/done state.
    const allWorkItems = await this.api.listWorkItems(workspaceId).catch(() => []);
    // Group: items still running for this role go to the top with "● live".
    const inProgressIds = new Set(
      allWorkItems
        .filter((w) => w.assignedRole === role && w.status === 'in_progress')
        .map((w) => w.briefId && w.phase ? `${w.briefId}-${w.phase}` : null)
        .filter(Boolean) as string[],
    );
    // Sort by mtime descending — newest first, naturally putting active runs first.
    files.sort((a, b) => b.mtime - a.mtime);

    return files.map((f): TaskNode => {
      const taskId = f.name.replace(/\.md$/, '');
      const isLive = inProgressIds.has(taskId);
      const matchingItem = allWorkItems.find(
        (w) => w.assignedRole === role && w.briefId && w.phase && `${w.briefId}-${w.phase}` === taskId,
      );
      // Transcript file naming convention is "<briefId>-<phase>.md".
      const m = taskId.match(/^(brief-[a-z0-9]+)-(research|plan|implement|review|verify)$/);
      const briefId = m?.[1];
      const phase = m?.[2];
      return {
        kind: 'task',
        label: matchingItem?.title ?? taskId,
        description: isLive ? '● live · click for live Claude session' : 'done · click to replay session',
        filePath: path.join(dir, f.name),
        workspaceId,
        briefId,
        phase,
        role,
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
