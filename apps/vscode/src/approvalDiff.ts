// Diff preview + Approve/Deny/Always-allow-session buttons for a pending
// approval. For Edit/Write approvals, we open VS Code's built-in diff editor
// with the on-disk content on the left and the tool's proposed content on
// the right. The decision buttons show as a QuickPick that pops up alongside.
// For non-file tools (Bash/WebFetch/etc), we skip the diff and show only the
// decision picker.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AtruneApi } from './api';

interface Args {
  approvalId: string;
  tool: string;
  args: Record<string, unknown>;
  workspaceId: string;
  onDecided?: () => void;
}

export async function openApprovalDiff(api: AtruneApi, opts: Args): Promise<void> {
  const preview = await api.getApprovalPreview(opts.approvalId);
  let closeDiff: (() => Promise<void>) | null = null;

  if (preview && (preview.kind === 'edit' || preview.kind === 'write')) {
    closeDiff = await openDiffTabs(preview, opts.approvalId);
  }

  const summary = summarize(opts.tool, opts.args);
  type Pick = vscode.QuickPickItem & { action: 'approve' | 'deny' | 'always' };
  const picks: Pick[] = [
    { label: '$(check) Approve', description: 'run this call once', action: 'approve' },
    { label: '$(check-all) Always allow (this session)', description: 'skip the prompt until this brief finishes', action: 'always' },
    { label: '$(x) Deny', description: 'block this call', action: 'deny' },
  ];
  const pick = await vscode.window.showQuickPick<Pick>(picks, {
    placeHolder: `Decision for: ${summary}`,
    ignoreFocusOut: true,
  });

  if (closeDiff) await closeDiff();

  if (!pick) return;
  const decision: 'approved' | 'denied' = pick.action === 'deny' ? 'denied' : 'approved';
  const ok = await api.decideApproval(opts.approvalId, decision, opts.workspaceId, {
    alwaysAllowSession: pick.action === 'always',
  });
  if (ok) {
    const verb = pick.action === 'always' ? 'always-allowed' : decision;
    vscode.window.setStatusBarMessage(`Atrune · ${verb} ${opts.tool}`, 3000);
    opts.onDecided?.();
  } else {
    vscode.window.showErrorMessage(`Atrune · failed to record decision (${opts.approvalId}).`);
  }
}

async function openDiffTabs(
  preview: { kind: 'edit' | 'write'; filePath: string; before: string; after: string },
  approvalId: string,
): Promise<() => Promise<void>> {
  // Materialize before/after to temp files so we can use `vscode.diff`. Using
  // untitled schemes gets weird for large content and the diff header is nicer
  // with real filenames.
  const tmpRoot = path.join(os.tmpdir(), 'atrune-approvals', approvalId);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const baseName = path.basename(preview.filePath) || 'preview';
  const beforePath = path.join(tmpRoot, `before-${baseName}`);
  const afterPath  = path.join(tmpRoot, `after-${baseName}`);
  fs.writeFileSync(beforePath, preview.before, 'utf8');
  fs.writeFileSync(afterPath, preview.after, 'utf8');

  const title = `${preview.kind === 'write' ? 'Write' : 'Edit'} · ${shortPath(preview.filePath)}`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(beforePath),
    vscode.Uri.file(afterPath),
    title,
    { preview: true, viewColumn: vscode.ViewColumn.One },
  );

  return async () => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  };
}

function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof args.command === 'string') {
    return `Bash: ${truncate(args.command as string, 60)}`;
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof args.file_path === 'string') {
    return `${tool} ${shortPath(args.file_path as string)}`;
  }
  return `${tool} ${truncate(JSON.stringify(args), 60)}`;
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 3 ? p : '…/' + parts.slice(-3).join('/');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
