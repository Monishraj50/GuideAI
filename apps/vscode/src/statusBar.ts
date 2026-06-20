// Phase 4 — Atrune status bar item.
//
// One bar item, four slots separated by · :
//   <health dot> Atrune · <narrator> · <budget HUD> · <pending count>
//
// Clicks open Mission Control. Background turns warning-yellow when approvals
// are pending so the bar is impossible to miss without being aggressive.

import * as vscode from 'vscode';
import type { PlanResp } from './api';
import { narrate } from './narrator';

export class AtruneStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'atrune.openMissionControl';
    this.item.show();
    this.renderConnecting();
  }

  update(plan: PlanResp | null): void {
    if (!plan) {
      this.renderConnecting();
      return;
    }

    const dot = this.healthDot(plan);
    const sentence = narrate(plan);
    const budget = `$${plan.usd.toFixed(2)}`;
    const pendingSlot =
      plan.pendingApprovals.length > 0
        ? ` · ${plan.pendingApprovals.length} pending`
        : '';

    this.item.text = `${dot} Atrune · ${sentence} · ${budget}${pendingSlot}`;
    this.item.tooltip = this.buildTooltip(plan);

    if (plan.pendingApprovals.length > 0) {
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  private renderConnecting(): void {
    this.item.text = '$(loading~spin) Atrune · connecting…';
    this.item.tooltip = 'Atrune is connecting to the server.';
    this.item.backgroundColor = undefined;
  }

  private healthDot(plan: PlanResp): string {
    if (plan.pendingApprovals.length > 0) return '$(warning)';
    if (plan.briefs.active > 0) return '$(sync~spin)';
    return '$(circle-filled)';
  }

  private buildTooltip(plan: PlanResp): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Atrune** · ${plan.workspace.name}\n\n`);
    md.appendMarkdown(`- Agents: ${plan.agents.active} active / ${plan.agents.total} total\n`);
    md.appendMarkdown(`- Briefs: ${plan.briefs.active} running / ${plan.briefs.total} total\n`);
    md.appendMarkdown(`- Spend: \`$${plan.usd.toFixed(2)}\` · ${plan.tokens.toLocaleString()} tokens\n`);
    md.appendMarkdown(`- Pending approvals: ${plan.pendingApprovals.length}\n\n`);
    md.appendMarkdown(`_Click to open Mission Control_`);
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
