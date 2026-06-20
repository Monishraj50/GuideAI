// AtruneAI VS Code extension — entry point.
//
// Phase 1 scope:
//   - Activate on startup → auto-spawn Atrune server + web if not running
//   - Three sidebar TreeViews: Active work · Pending · Team
//   - Three commands: Open Mission Control · Refresh sidebar · Restart server
//   - 5s polling refresh on all three views (cheap; replaces SSE for now)
//
// Phases 2+ will add toolbar buttons, webview composer, status bar HUD, etc.

import * as vscode from 'vscode';
import { AtruneServer } from './server';
import { AtruneApi } from './api';
import { ActiveWorkProvider } from './views/activeWork';
import { PendingProvider } from './views/pending';
import { TeamProvider } from './views/team';
import { openMissionControl } from './webviews/missionControl';
import { openBriefComposer } from './webviews/briefComposer';
import { quickAskChooser, askOneAgent, autoFix } from './directTask';
import { AtruneStatusBar } from './statusBar';
import { checkNewApprovals } from './approvals';
import { maybePromptFirstLaunch, resetFirstLaunch } from './firstLaunch';

let server: AtruneServer | undefined;
let pollHandle: NodeJS.Timeout | undefined;
let statusBar: AtruneStatusBar | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  server = new AtruneServer();
  server.log('Atrune extension activating…');

  const api = new AtruneApi();

  // Active workspace tracking. Zero-config flow: if the user invokes a
  // direct task with no workspace, one is auto-created and we adopt it.
  let activeWorkspaceId: string | null = null;
  async function refreshActiveWorkspace() {
    const list = await api.listWorkspaces();
    if (list.length === 0) { activeWorkspaceId = null; return; }
    if (!activeWorkspaceId || !list.find((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = list[0]?.id ?? null;
    }
  }
  function setActiveWorkspaceId(id: string) {
    activeWorkspaceId = id;
    refreshAll();
  }

  // Bring the server up before wiring views (so the first poll doesn't 404).
  const status = await server.ensureRunning();
  if (!status.ok) {
    vscode.window.showWarningMessage(
      `Atrune server not reachable: ${status.reason ?? 'unknown'}. Open the Atrune output channel for details.`,
      'Open output',
    ).then((p) => { if (p === 'Open output') server?.show(); });
  }
  await refreshActiveWorkspace();

  // Three TreeViews.
  const activeWork = new ActiveWorkProvider(api, () => activeWorkspaceId);
  const pending    = new PendingProvider(api, () => activeWorkspaceId);
  const team       = new TeamProvider(api, () => activeWorkspaceId);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('atrune.activeWork', activeWork),
    vscode.window.registerTreeDataProvider('atrune.pending', pending),
    vscode.window.registerTreeDataProvider('atrune.team', team),
  );

  function refreshAll() {
    activeWork.refresh();
    pending.refresh();
    team.refresh();
  }

  // Phase 4 — status bar + native approval popups.
  statusBar = new AtruneStatusBar();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  async function tick() {
    await refreshActiveWorkspace();
    refreshAll();
    if (activeWorkspaceId) {
      const plan = await api.getPlan(activeWorkspaceId);
      statusBar?.update(plan);
      await checkNewApprovals(api, plan, activeWorkspaceId, () => refreshAll());
    } else {
      statusBar?.update(null);
    }
  }

  // Prime the status bar immediately so users don't see "connecting…" for 5s.
  void tick();

  // Zero-config first launch: one popup asking for Claude credentials, then
  // silent forever. Auto-created workspaces inherit the global default.
  void maybePromptFirstLaunch(ctx, api);

  // 5s poll cadence — cheap, predictable, replaces SSE for v1.
  pollHandle = setInterval(() => { void tick(); }, 5000);
  ctx.subscriptions.push({ dispose: () => { if (pollHandle) clearInterval(pollHandle); } });

  // Commands.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('atrune.openMissionControl', async (opts?: { route?: string }) => {
      await openMissionControl(ctx, opts);
    }),
    vscode.commands.registerCommand('atrune.openSettings', async () => {
      // Open VS Code's own settings filtered to Atrune configuration.
      // Settings page inside Mission Control is reachable via the
      // openMissionControl({route:'/settings'}) variant if the user prefers.
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:atrune-ai.atrune-ai');
      // Fallback for unpublished installs where the publisher isn't right yet
      // — open generic settings filtered by keyword:
      await vscode.commands.executeCommand('workbench.action.openSettings', 'atrune');
    }),
    vscode.commands.registerCommand('atrune.newBrief', async () => {
      await openBriefComposer(ctx, api, () => activeWorkspaceId, () => refreshAll());
    }),
    vscode.commands.registerCommand('atrune.quickAsk', async () => {
      await quickAskChooser(api, () => activeWorkspaceId, undefined, setActiveWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.askOneAgent', async () => {
      await askOneAgent(api, () => activeWorkspaceId, undefined, setActiveWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.autoFixThisFile', async (uri?: vscode.Uri) => {
      // Editor context-menu / explorer-context entry. If a URI was passed
      // (right-click in the file explorer), include the file path in the prompt.
      const filePath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      const fileHint = filePath ? `(file: ${filePath}) ` : '';
      await autoFix(api, () => activeWorkspaceId, `${fileHint}`.trim() || undefined, setActiveWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.askAgentAboutSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed?.document.getText(ed.selection);
      const contextPrompt = sel?.trim()
        ? `Here is a code selection from ${ed?.document.uri.fsPath ?? 'this file'}:\n\n\`\`\`\n${sel}\n\`\`\`\n\nWhat I want: `
        : undefined;
      await askOneAgent(api, () => activeWorkspaceId, contextPrompt, setActiveWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.switchWorkspace', async () => {
      const list = await api.listWorkspaces();
      if (list.length === 0) {
        vscode.window.showInformationMessage('No projects yet — create one in Mission Control.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((w) => ({ label: w.name, description: w.id, detail: `${w.agents} agents · ${w.totalBriefs} briefs · ${w.pendingApprovals} pending` })),
        { placeHolder: 'Switch active Atrune project' },
      );
      if (pick) {
        activeWorkspaceId = pick.description!;
        refreshAll();
        vscode.window.showInformationMessage(`Active project: ${pick.label}`);
      }
    }),
    vscode.commands.registerCommand('atrune.refresh', async () => {
      await refreshActiveWorkspace();
      refreshAll();
    }),
    vscode.commands.registerCommand('atrune.restartServer', async () => {
      vscode.window.showInformationMessage('Restarting Atrune server…');
      await server?.dispose();
      server = new AtruneServer();
      const r = await server.ensureRunning();
      if (r.ok) vscode.window.showInformationMessage('Atrune server is back up.');
      else      vscode.window.showWarningMessage(`Restart failed: ${r.reason}`);
    }),
    vscode.commands.registerCommand('atrune.showWalkthrough', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        { category: `${ctx.extension.id}#atrune.welcome` },
        false,
      );
    }),
    vscode.commands.registerCommand('atrune.resetFirstLaunch', async () => {
      await resetFirstLaunch(ctx);
      await maybePromptFirstLaunch(ctx, api);
    }),
  );

  server.log('Atrune extension activated.');
}

export async function deactivate() {
  if (pollHandle) clearInterval(pollHandle);
  await server?.dispose();
}
