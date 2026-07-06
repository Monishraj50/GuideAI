// S13 · GuideAI status bar item.
//
// Format (S13 spec):
//   ● GuideAI · ↓Nk ↑Nk · $X.XX · model
// Turns warning-yellow when approvals are pending so it's impossible to miss.

import * as vscode from 'vscode';
import type { PlanResp } from './api';

/** Format a token count as `123` (<1000), `1.2k` (<100k), `123k` (otherwise). */
function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

/** Model slot — pipeline routes per-phase (sonnet/opus/sonnet) so "current
 *  model" is inherently fuzzy. We surface `sonnet` while a brief is running
 *  (implement-phase default) and `—` when idle. */
function detectModelSlot(plan: PlanResp): string {
  return plan.briefs.active > 0 ? 'sonnet' : '—';
}

export class AtruneStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'atrune.actions';
    this.item.show();
    this.renderConnecting();
  }

  update(plan: PlanResp | null): void {
    if (!plan) { this.renderConnecting(); return; }

    const dot = this.healthDot(plan);
    const tIn  = fmtK(plan.tokensIn  ?? plan.tokens);
    const tOut = fmtK(plan.tokensOut ?? 0);
    const budget = `$${plan.usd.toFixed(2)}`;
    const model = detectModelSlot(plan);
    const pendingSlot = plan.pendingApprovals.length > 0
      ? ` · ${plan.pendingApprovals.length} pending`
      : '';

    this.item.text = `${dot} GuideAI · ↓${tIn} ↑${tOut} · ${budget} · ${model}${pendingSlot}`;
    this.item.tooltip = this.buildTooltip(plan);
    this.item.backgroundColor = plan.pendingApprovals.length > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  private renderConnecting(): void {
    this.item.text = '$(loading~spin) GuideAI · connecting…';
    this.item.tooltip = 'GuideAI is connecting to the server.';
    this.item.backgroundColor = undefined;
  }

  private healthDot(plan: PlanResp): string {
    if (plan.pendingApprovals.length > 0) return '$(warning)';
    if (plan.briefs.active > 0) return '$(sync~spin)';
    return '$(circle-filled)';
  }

  private buildTooltip(plan: PlanResp): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**GuideAI** · ${plan.workspace.name}\n\n`);
    md.appendMarkdown(`- Agents: ${plan.agents.active} active / ${plan.agents.total} total\n`);
    md.appendMarkdown(`- Briefs: ${plan.briefs.active} running / ${plan.briefs.total} total\n`);
    md.appendMarkdown(`- Spend: \`$${plan.usd.toFixed(2)}\` · ${plan.tokens.toLocaleString()} tokens (${(plan.tokensIn ?? 0).toLocaleString()}↓ / ${(plan.tokensOut ?? 0).toLocaleString()}↑)\n`);
    md.appendMarkdown(`- Pending approvals: ${plan.pendingApprovals.length}\n\n`);
    md.appendMarkdown(`_Click for GuideAI actions._`);
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
