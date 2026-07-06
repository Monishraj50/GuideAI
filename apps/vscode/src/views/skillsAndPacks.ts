// 🛠 Skills & Packs view (S13).
//
// Two top-level buckets:
//   Skills → grouped by source (_user / _custom / _pack:* / _seed / legacy)
//   Packs  → grouped by install status; missing-deps flagged with a warning
//
// Click a skill row → open its .md file (best-effort — resolves the source
// dir under ~/.guideai/skills/ or ~/.guideai/packs/).

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { AtruneApi } from '../api';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  contextValue?: string;
  command?: vscode.Command;
  children?: Node[];
  collapsibleState?: vscode.TreeItemCollapsibleState;
}

const home = () => process.env.GUIDEAI_HOME || path.join(os.homedir(), '.guideai');

function skillFilePath(source: string, name: string): string {
  if (source.startsWith('_pack:')) {
    const packName = source.slice('_pack:'.length);
    return path.join(home(), 'packs', packName, 'skills', `${name}.md`);
  }
  if (source === '_user' || source === '_custom' || source === '_seed') {
    return path.join(home(), 'skills', source, `${name}.md`);
  }
  return path.join(home(), 'skills', `${name}.md`);
}

export class SkillsAndPacksProvider implements vscode.TreeDataProvider<Node> {
  private _emit = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._emit.event;
  refresh() { this._emit.fire(); }

  constructor(private api: AtruneApi) {}

  getTreeItem(node: Node): vscode.TreeItem {
    const collapsible = node.collapsibleState ?? (node.children?.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    const item = new vscode.TreeItem(node.label, collapsible);
    if (node.description)  item.description = node.description;
    if (node.tooltip)      item.tooltip = node.tooltip;
    if (node.iconId)       item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.contextValue) item.contextValue = node.contextValue;
    if (node.command)      item.command = node.command;
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (parent) return parent.children ?? [];
    const [skills, packs] = await Promise.all([this.api.listSkills(), this.api.listPacks()]);

    // ── Skills bucket ──
    const bySource = new Map<string, typeof skills.skills>();
    for (const s of skills.skills) {
      if (!bySource.has(s.source)) bySource.set(s.source, []);
      bySource.get(s.source)!.push(s);
    }
    const skillGroups: Node[] = [];
    const order = ['_user', '_custom', '_seed', 'legacy'];
    const seen = new Set<string>();
    for (const src of order) {
      const list = bySource.get(src);
      if (!list?.length) continue;
      seen.add(src);
      skillGroups.push(sourceGroup(src, list));
    }
    // Pack-sourced skills.
    for (const [src, list] of bySource) {
      if (seen.has(src) || !src.startsWith('_pack:')) continue;
      skillGroups.push(sourceGroup(src, list));
    }

    // ── Packs bucket ──
    const packChildren: Node[] = packs.packs.map((p) => ({
      label: p.name,
      description: `v${p.version} · ${p.skillCount} skill${p.skillCount === 1 ? '' : 's'}${p.hasMissingReqs ? ' · missing deps' : ''}`,
      tooltip: p.description ?? '',
      iconId: p.hasMissingReqs ? 'warning' : 'package',
      contextValue: 'pack',
    }));
    if (packChildren.length === 0) {
      packChildren.push({ label: 'No packs installed', description: 'run "Atrune: Install a pack…"', iconId: 'info' });
    }

    return [
      {
        label: 'Skills',
        description: `${skills.count} total`,
        iconId: 'symbol-method',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        children: skillGroups.length ? skillGroups
          : [{ label: 'No skills loaded', description: 'seeds land automatically on first use', iconId: 'info' }],
      },
      {
        label: 'Packs',
        description: `${packs.count} installed`,
        iconId: 'package',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        children: packChildren,
      },
    ];
  }
}

function sourceGroup(source: string, skills: Array<{ name: string; description: string; appliesTo: string[]; keywords: string[]; source: string }>): Node {
  const label = source === '_user' ? '_user (your overrides)'
    : source === '_custom' ? '_custom'
    : source === '_seed' ? '_seed (built-in)'
    : source === 'legacy' ? 'legacy (flat root)'
    : source.startsWith('_pack:') ? source.replace('_pack:', 'pack: ')
    : source;
  return {
    label,
    description: `${skills.length}`,
    iconId: source.startsWith('_pack:') ? 'package'
      : source === '_user' ? 'account'
      : source === '_seed' ? 'book'
      : 'file-code',
    children: skills.map((s) => ({
      label: s.name,
      description: s.appliesTo.join(',') || 'any',
      tooltip: s.description,
      iconId: 'symbol-method',
      command: {
        command: 'vscode.open',
        title: 'Open skill file',
        arguments: [vscode.Uri.file(skillFilePath(s.source, s.name))],
      },
    })),
  };
}
