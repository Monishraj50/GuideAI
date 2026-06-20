// Phase 4 — Native VS Code popups for new pending approvals.
//
// Watches the plan poll for NEW approval IDs (not yet seen this session).
// For each one, shows showInformationMessage with Approve/Deny/Open buttons.
// Click → decideApproval API + refresh.
//
// Approval IDs are GC'd from the seen-set once they drop out of pendingApprovals.

import * as vscode from 'vscode';
import { AtruneApi, type PlanResp } from './api';

const SEEN = new Set<string>();

export async function checkNewApprovals(
  api: AtruneApi,
  plan: PlanResp | null,
  workspaceId: string | null,
  onChange: () => void,
): Promise<void> {
  if (!plan || !workspaceId) return;

  for (const approval of plan.pendingApprovals) {
    if (SEEN.has(approval.id)) continue;
    SEEN.add(approval.id);

    const args = parseArgs(approval.argsJson);
    const summary = formatApproval(approval.tool, args);

    vscode.window
      .showInformationMessage(
        summary,
        'Approve',
        'Deny',
        'Open in Mission Control',
      )
      .then(async (choice) => {
        if (choice === 'Approve') {
          const ok = await api.decideApproval(approval.id, 'approved', workspaceId);
          if (ok) vscode.window.setStatusBarMessage(`Atrune · approved (${approval.tool})`, 3000);
          else vscode.window.showErrorMessage(`Atrune · failed to approve ${approval.tool}`);
          onChange();
        } else if (choice === 'Deny') {
          const ok = await api.decideApproval(approval.id, 'denied', workspaceId);
          if (ok) vscode.window.setStatusBarMessage(`Atrune · denied (${approval.tool})`, 3000);
          else vscode.window.showErrorMessage(`Atrune · failed to deny ${approval.tool}`);
          onChange();
        } else if (choice === 'Open in Mission Control') {
          vscode.commands.executeCommand('atrune.openMissionControl');
        }
      });
  }

  // GC: drop approval IDs that are no longer pending so we re-prompt if the
  // same tool comes up again (e.g. retried after edit).
  const stillPending = new Set(plan.pendingApprovals.map((a) => a.id));
  for (const id of Array.from(SEEN)) {
    if (!stillPending.has(id)) SEEN.delete(id);
  }
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatApproval(tool: string, args: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof args.command === 'string') {
    return `Atrune wants to run: ${truncate(args.command, 80)}`;
  }
  if (tool === 'Write' && typeof args.file_path === 'string') {
    return `Atrune wants to write: ${shortPath(args.file_path)}`;
  }
  if (tool === 'Edit' && typeof args.file_path === 'string') {
    return `Atrune wants to edit: ${shortPath(args.file_path)}`;
  }
  if (tool === 'WebFetch' && typeof args.url === 'string') {
    return `Atrune wants to fetch: ${truncate(args.url, 80)}`;
  }
  return `Atrune wants to use ${tool}`;
}

function shortPath(p: string): string {
  // Drop everything up to the last 3 path segments for readability.
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-3).join('/');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
