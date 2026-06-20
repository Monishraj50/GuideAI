// Atrium.AI VS Code extension — entry point.
//
// Phase 1 scope:
//   - Activate on startup → auto-spawn Atrium server + web if not running
//   - Three sidebar TreeViews: Active work · Pending · Team
//   - Three commands: Open Mission Control · Refresh sidebar · Restart server
//   - 5s polling refresh on all three views (cheap; replaces SSE for now)
//
// Phases 2+ will add toolbar buttons, webview composer, status bar HUD, etc.

import * as vscode from 'vscode';
import { AtriumServer } from './server';
import { AtriumApi } from './api';
import { ActiveWorkProvider } from './views/activeWork';
import { PendingProvider } from './views/pending';
import { TeamProvider } from './views/team';

let server: AtriumServer | undefined;
let pollHandle: NodeJS.Timeout | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  server = new AtriumServer();
  server.log('Atrium extension activating…');

  const api = new AtriumApi();

  // Active workspace tracking — for now, default to the first workspace the
  // server knows about. Phase 2 will add an explicit picker tied to the open
  // VS Code folder.
  let activeWorkspaceId: string | null = null;
  async function refreshActiveWorkspace() {
    const list = await api.listWorkspaces();
    if (list.length === 0) { activeWorkspaceId = null; return; }
    if (!activeWorkspaceId || !list.find((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = list[0]?.id ?? null;
    }
  }

  // Bring the server up before wiring views (so the first poll doesn't 404).
  const status = await server.ensureRunning();
  if (!status.ok) {
    vscode.window.showWarningMessage(
      `Atrium server not reachable: ${status.reason ?? 'unknown'}. Open the Atrium output channel for details.`,
      'Open output',
    ).then((p) => { if (p === 'Open output') server?.show(); });
  }
  await refreshActiveWorkspace();

  // Three TreeViews.
  const activeWork = new ActiveWorkProvider(api, () => activeWorkspaceId);
  const pending    = new PendingProvider(api, () => activeWorkspaceId);
  const team       = new TeamProvider(api, () => activeWorkspaceId);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('atrium.activeWork', activeWork),
    vscode.window.registerTreeDataProvider('atrium.pending', pending),
    vscode.window.registerTreeDataProvider('atrium.team', team),
  );

  function refreshAll() {
    activeWork.refresh();
    pending.refresh();
    team.refresh();
  }

  // 5s poll cadence — cheap, predictable, replaces SSE for v1.
  pollHandle = setInterval(async () => {
    await refreshActiveWorkspace();
    refreshAll();
  }, 5000);
  ctx.subscriptions.push({ dispose: () => { if (pollHandle) clearInterval(pollHandle); } });

  // Commands.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('atrium.openMissionControl', async () => {
      const port = vscode.workspace.getConfiguration('atrium').get<number>('webPort', 3000);
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/`));
    }),
    vscode.commands.registerCommand('atrium.refresh', async () => {
      await refreshActiveWorkspace();
      refreshAll();
    }),
    vscode.commands.registerCommand('atrium.restartServer', async () => {
      vscode.window.showInformationMessage('Restarting Atrium server…');
      await server?.dispose();
      server = new AtriumServer();
      const r = await server.ensureRunning();
      if (r.ok) vscode.window.showInformationMessage('Atrium server is back up.');
      else      vscode.window.showWarningMessage(`Restart failed: ${r.reason}`);
    }),
  );

  server.log('Atrium extension activated.');
}

export async function deactivate() {
  if (pollHandle) clearInterval(pollHandle);
  await server?.dispose();
}
