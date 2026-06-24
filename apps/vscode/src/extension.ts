// AtruneAI VS Code extension — entry point.
//
// IMPORTANT activation order:
//   1. Commands are registered SYNCHRONOUSLY at the top of activate(), before
//      any `await`. Otherwise a user clicking a button while the server is
//      still spawning gets "command not found".
//   2. TreeViews + status bar are wired next.
//   3. Async server startup, first-launch prompt, and the poll loop kick off
//      LAST — they happen in the background after activate() returns.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { AtruneServer } from './server';
import { AtruneApi } from './api';
import { ActiveWorkProvider } from './views/activeWork';
import { ProgressProvider } from './views/progress';
import { TeamProvider } from './views/team';
import { openMissionControl } from './webviews/missionControl';
import { openBriefComposer } from './webviews/briefComposer';
import { openKanban } from './webviews/kanban';
import { quickAskChooser, askOneAgent, autoFix } from './directTask';
import { AtruneStatusBar } from './statusBar';
import { checkNewApprovals } from './approvals';
import { resetFirstLaunch } from './firstLaunch';
import { openConnectSubscription } from './webviews/connectSubscription';
import { hasConsent, promptForConsent, revokeAndWipe } from './folderConsent';

let server: AtruneServer | undefined;
let pollHandle: NodeJS.Timeout | undefined;
let statusBar: AtruneStatusBar | undefined;

/** On-disk path for a brief's saved chat transcript. */
function briefChatPath(workspaceId: string, briefId: string): string {
  const home = process.env.GUIDEAI_HOME || path.join(os.homedir(), '.guideai');
  return path.join(home, 'workspaces', workspaceId, 'briefs', briefId, 'chat.md');
}

/**
 * Open a brief's saved chat.md in the editor + show the markdown preview
 * to the side. Falls back to the Mission Control Logs/Replay page if the
 * file doesn't exist yet (mid-brief).
 */
async function openBriefChatFile(workspaceId: string, briefId: string): Promise<void> {
  const filePath = briefChatPath(workspaceId, briefId);
  if (!fs.existsSync(filePath)) {
    const pick = await vscode.window.showInformationMessage(
      'No saved chat for this task yet — the transcript is written when the brief completes. Open the live Logs/Replay page in your browser?',
      'Open Logs',
      'Cancel',
    );
    if (pick === 'Open Logs') {
      await vscode.commands.executeCommand('atrune.openMissionControl', { route: `/logs/${briefId}` });
    }
    return;
  }
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  // Show the rendered markdown preview next to the editor view.
  try {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
  } catch {}
}

export async function activate(ctx: vscode.ExtensionContext) {
  server = new AtruneServer();
  server.log('Atrune extension activating…');

  const api = new AtruneApi();

  // Active workspace tracking. Synchronous declarations only — handlers below
  // close over these and use them at click-time.
  let activeWorkspaceId: string | null = null;
  let refreshAll: () => void = () => {};
  function setActiveWorkspaceId(id: string) {
    activeWorkspaceId = id;
    refreshAll();
  }

  // Connection state — drives the `atrune.connected` context key. Sidebar
  // TreeViews are hidden until this is true. Set on activate + after any
  // provider connection succeeds.
  async function checkConnectionAndSetContext(): Promise<boolean> {
    const claude = await api.getGlobalClaude();
    const openai = await api.getGlobalOpenAI();
    const copilotInstalled = !!vscode.extensions.getExtension('GitHub.copilot');
    const connected = !!(claude?.ready || openai?.apiKeySet || copilotInstalled);
    await vscode.commands.executeCommand('setContext', 'atrune.connected', connected);
    return connected;
  }
  // Folder consent state — drives the `atrune.folderConsented` context key.
  // True when <open-folder>/.atrune/.consent.json exists. Sidebar TreeViews
  // ALSO gate on this — initial state shows only the Welcome view until the
  // user explicitly clicks Allow.
  //
  // We also probe the running server: if consent says NO but the server still
  // returns 200 on data routes, it was spawned with a stale ATRUNE_DB_PATH
  // (its env doesn't update on tsx-watch reload). In that case we dispose
  // and respawn so the server lines up with the truth on disk.
  let lastConsentState: boolean | null = null;
  async function checkConsentAndSetContext(): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const consented = !!(folder && hasConsent(folder));
    await vscode.commands.executeCommand('setContext', 'atrune.folderConsented', consented);

    // Probe server vs consent. Only if we own the server — we never kill an
    // external pnpm dev that the user might be running.
    let serverMismatch = false;
    if (server && server.weOwnProcesses) {
      try {
        const probe = await fetch(`http://localhost:${server.serverPort()}/api/workspaces`).catch(() => null);
        const serverHasStorage = probe?.status === 200;
        // Mismatch: consent says NO storage, but server returns workspaces (200).
        // Or: consent says YES, but server returns 503.
        if (serverHasStorage !== consented) serverMismatch = true;
      } catch {}
    }

    const transition = lastConsentState !== null && lastConsentState !== consented;
    if (transition || serverMismatch) {
      try {
        await server?.dispose();
        server = new AtruneServer();
        await server.ensureRunning();
        await refreshActiveWorkspaceImmediate();
        refreshAll();
      } catch {}
    }
    lastConsentState = consented;
    return consented;
  }
  async function refreshActiveWorkspace() {
    const list = await api.listWorkspaces();
    if (list.length === 0) { activeWorkspaceId = null; return; }
    if (!activeWorkspaceId || !list.find((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = list[0]?.id ?? null;
    }
  }
  /** Force an immediate poll cycle — used after dispatch so sidebars don't
   *  wait 5s to show the new brief / tasks / status. */
  async function refreshActiveWorkspaceImmediate() {
    await refreshActiveWorkspace();
    if (activeWorkspaceId) {
      const plan = await api.getPlan(activeWorkspaceId);
      statusBar?.update(plan);
    }
  }

  // ── COMMANDS — register synchronously, BEFORE any await ─────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('atrune.openMissionControl', async (opts?: { route?: string }) => {
      await openMissionControl(ctx, opts);
    }),
    vscode.commands.registerCommand('atrune.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:atrune-ai.atruneai');
      await vscode.commands.executeCommand('workbench.action.openSettings', 'atrune');
    }),
    vscode.commands.registerCommand('atrune.newBrief', async () => {
      // After a brief is dispatched, force an immediate poll cycle (faster
      // than waiting for the 5s tick) so sidebars + status bar pick up the
      // new brief, then nudge the user to the project view in their browser.
      await openBriefComposer(
        ctx, api, () => activeWorkspaceId,
        async (info?: { workspaceId?: string; briefId?: string }) => {
          await refreshActiveWorkspaceImmediate();
          refreshAll();
          if (info?.workspaceId && info?.briefId) {
            // Auto-open the native Kanban so the user sees the phase cards
            // immediately (especially important in Manual mode where work
            // can't progress until the user drags a card to Active).
            await openKanban({ workspaceId: info.workspaceId, briefId: info.briefId });
          }
        },
      );
    }),
    vscode.commands.registerCommand('atrune.quickAsk', async () => {
      await quickAskChooser(api, () => activeWorkspaceId, undefined, setActiveWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.askOneAgent', async () => {
      await askOneAgent(api, () => activeWorkspaceId, undefined, setActiveWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.autoFixThisFile', async (uri?: vscode.Uri) => {
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
      // Clear the first-launch flag and re-check context so the Welcome view
      // surfaces the connect button. We deliberately do NOT pop a modal here —
      // the user re-engages via the sidebar Welcome view buttons.
      await resetFirstLaunch(ctx);
      await checkConnectionAndSetContext();
      await checkConsentAndSetContext();
    }),
    vscode.commands.registerCommand('atrune.connectSubscription', async () => {
      await openConnectSubscription(ctx, api, async () => { await checkConnectionAndSetContext(); });
    }),
    vscode.commands.registerCommand('atrune.allowFolderStorage', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      if (folder && hasConsent(folder)) {
        const re = await vscode.window.showInformationMessage(
          `Atrune storage is already enabled for:\n\n  ${folder}/.atrune/\n\n` +
          `Do you want to re-prompt (e.g. switch to a different folder)?`,
          { modal: true },
          'Re-prompt',
        );
        if (re !== 'Re-prompt') return;
      }
      const consented = await promptForConsent();
      if (consented) {
        vscode.window.showInformationMessage(`Atrune storage enabled at ${consented}/.atrune/`);
        // Restart the server so it picks up ATRUNE_DB_PATH for the consented folder.
        await server?.dispose();
        server = new AtruneServer();
        await server.ensureRunning();
        await refreshActiveWorkspaceImmediate();
        refreshAll();
      }
    }),
    vscode.commands.registerCommand('atrune.revokeFolderStorage', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        vscode.window.showInformationMessage('No folder open — nothing to revoke.');
        return;
      }
      if (!hasConsent(folder)) {
        vscode.window.showInformationMessage(`No Atrune storage exists in ${folder}.`);
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Revoke Atrune storage for this folder?\n\n` +
        `This DELETES ${folder}/.atrune/ — the project DB, events, transcripts, ` +
        `and consent marker. Equivalent to running rm -rf .atrune/ yourself. ` +
        `Subscription connection stays untouched.`,
        { modal: true },
        'Delete .atrune/ and revoke',
      );
      if (confirm !== 'Delete .atrune/ and revoke') return;
      const result = revokeAndWipe(folder);
      if (result.removed) {
        vscode.window.showInformationMessage(`Removed ${result.path}. Atrune is now in initial state.`);
        // Server was talking to the deleted DB. Respawn so it falls back to sandbox.
        await server?.dispose();
        server = new AtruneServer();
        await server.ensureRunning();
        await refreshActiveWorkspaceImmediate();
        refreshAll();
      } else {
        vscode.window.showWarningMessage(`Couldn't remove ${result.path}.`);
      }
    }),
    vscode.commands.registerCommand('atrune.switchToWorkspace', async (workspaceId?: string) => {
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) return;
      setActiveWorkspaceId(workspaceId);
      vscode.window.setStatusBarMessage(`Atrune · active project: ${workspaceId}`, 3000);
    }),
    vscode.commands.registerCommand('atrune.openBriefInMissionControl', async (args?: {
      workspaceId?: string; briefId?: string;
    }) => {
      if (!args?.workspaceId) return;
      // Prefer the native Kanban if we have a briefId — same surface, no browser.
      if (args.briefId) {
        await openKanban({ workspaceId: args.workspaceId, briefId: args.briefId });
        return;
      }
      const route = `/projects/${args.workspaceId}`;
      await vscode.commands.executeCommand('atrune.openMissionControl', { route });
    }),
    vscode.commands.registerCommand('atrune.openKanban', async (args?: {
      workspaceId?: string; briefId?: string;
    }) => {
      if (!args?.workspaceId || !args?.briefId) {
        vscode.window.showInformationMessage('No brief selected. Dispatch a brief first.');
        return;
      }
      await openKanban({ workspaceId: args.workspaceId, briefId: args.briefId });
    }),
    vscode.commands.registerCommand('atrune.openTaskTranscript', async (args?: { filePath?: string }) => {
      const fp = args?.filePath?.trim();
      if (!fp || !fs.existsSync(fp)) {
        vscode.window.showInformationMessage('Transcript not found — agent may not have written it yet.');
        return;
      }
      const uri = vscode.Uri.file(fp);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      try { await vscode.commands.executeCommand('markdown.showPreviewToSide', uri); } catch {}
    }),
    vscode.commands.registerCommand('atrune.showAgentWork', async (args?: {
      workspaceId: string; agentId: string; role: string; displayName: string;
    }) => {
      if (!args?.workspaceId || !args?.role) return;
      const allSessions = await api.listSessions(args.workspaceId);
      const myTasks = allSessions.filter((s) => s.agentRole === args.role || s.agentId === args.agentId);
      if (myTasks.length === 0) {
        const pick = await vscode.window.showInformationMessage(
          `${args.displayName} has no recorded tasks yet.`,
          'View in Mission Control',
        );
        if (pick === 'View in Mission Control') {
          vscode.commands.executeCommand('atrune.openMissionControl', { route: '/org' });
        }
        return;
      }
      const STATUS_GLYPH: Record<string, string> = {
        running: '$(sync~spin)',
        completed: '$(check)',
        failed: '$(error)',
        skipped: '$(circle-slash)',
      };
      const pick = await vscode.window.showQuickPick(
        myTasks.map((s) => ({
          label: `${STATUS_GLYPH[s.status] ?? '$(circle-outline)'} ${s.briefTitle}`,
          description: `${s.phase} · ${s.status}`,
          detail: `${s.tokensIn.toLocaleString()}↓/${s.tokensOut.toLocaleString()}↑ · ${s.taskId}`,
          briefId: s.briefId,
        })),
        { placeHolder: `${args.displayName} · ${myTasks.length} task${myTasks.length > 1 ? 's' : ''} · pick one to view the saved session` },
      );
      if (pick) {
        // Saved session per feature: open the brief's chat.md file written
        // at completion. Falls back to Logs/Replay if not yet written.
        await openBriefChatFile(args.workspaceId, (pick as any).briefId);
      }
    }),
    vscode.commands.registerCommand('atrune.showAllSessions', async () => {
      const wsId = activeWorkspaceId;
      if (!wsId) {
        vscode.window.showWarningMessage('No active project.');
        return;
      }
      const sessions = await api.listSessions(wsId);
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No sessions yet — dispatch a brief to start.');
        return;
      }
      const STATUS_GLYPH: Record<string, string> = {
        running: '$(sync~spin)',
        completed: '$(check)',
        failed: '$(error)',
        skipped: '$(circle-slash)',
      };
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: `${STATUS_GLYPH[s.status] ?? '$(circle-outline)'} ${s.briefTitle}`,
          description: s.agentDisplayName ? `@${s.agentDisplayName}` : (s.agentRole ? `@${s.agentRole}` : ''),
          detail: `${s.phase} · ${s.status} · ${s.tokensIn.toLocaleString()}↓/${s.tokensOut.toLocaleString()}↑`,
          briefId: s.briefId,
        })),
        { placeHolder: `All sessions · ${sessions.length} · pick one to view the saved session` },
      );
      if (pick) {
        await openBriefChatFile(wsId, (pick as any).briefId);
      }
    }),
    vscode.commands.registerCommand('atrune.setRepoRoot', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Use as Atrune monorepo',
      });
      if (!picked || !picked[0]) return;
      await server?.setRepoRoot(picked[0].fsPath);
      vscode.window.showInformationMessage('Atrune monorepo set. Restarting server…');
      await server?.dispose();
      server = new AtruneServer();
      const r = await server.ensureRunning();
      if (r.ok) vscode.window.showInformationMessage('Atrune server is up.');
      else      vscode.window.showWarningMessage(`Still can't start: ${r.reason}`);
    }),
  );

  // ── TREE VIEWS + STATUS BAR — also synchronous ─────────────────────────
  const activeWork = new ActiveWorkProvider(api, () => activeWorkspaceId);
  const progress   = new ProgressProvider(api, () => activeWorkspaceId);
  const team       = new TeamProvider(api, () => activeWorkspaceId);

  // No-op provider for the welcome view — it's filled by `viewsWelcome` in
  // package.json (shown when `!atrune.connected`). VS Code still needs a
  // registered data provider for the view to exist.
  const welcomeProvider: vscode.TreeDataProvider<never> = {
    onDidChangeTreeData: undefined,
    getTreeItem: () => new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None),
    getChildren: () => [],
  };

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('atrune.welcome', welcomeProvider),
    vscode.window.registerTreeDataProvider('atrune.activeWork', activeWork),
    vscode.window.registerTreeDataProvider('atrune.progress', progress),
    vscode.window.registerTreeDataProvider('atrune.team', team),
  );

  refreshAll = () => {
    activeWork.refresh();
    progress.refresh();
    team.refresh();
  };

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

  // Set the initial connection + consent context BEFORE the async startup
  // so the sidebar's welcome view renders immediately on first activation.
  // We re-check after the server is up + on every poll tick.
  void checkConnectionAndSetContext();
  void checkConsentAndSetContext();

  // ── ASYNC STARTUP — runs in the background, doesn't block command use ──
  (async () => {
    let status = await server!.ensureRunning();

    // "repo not found" is recoverable: ask the user to point at the monorepo.
    if (!status.ok && status.reason === 'repo not found') {
      const pick = await vscode.window.showWarningMessage(
        'Atrune monorepo not found. Choose the folder containing pnpm-workspace.yaml to start the server.',
        'Choose folder…',
        'Open output',
      );
      if (pick === 'Choose folder…') {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Use as Atrune monorepo',
        });
        if (picked && picked[0]) {
          await server!.setRepoRoot(picked[0].fsPath);
          status = await server!.ensureRunning();
        }
      } else if (pick === 'Open output') {
        server?.show();
      }
    }

    if (!status.ok) {
      vscode.window.showWarningMessage(
        `Atrune server not reachable: ${status.reason ?? 'unknown'}. Run "Atrune: Set monorepo folder" from the command palette to fix.`,
        'Set monorepo folder…',
        'Open output',
      ).then((p) => {
        if (p === 'Set monorepo folder…') vscode.commands.executeCommand('atrune.setRepoRoot');
        else if (p === 'Open output') server?.show();
      });
    }
    await refreshActiveWorkspace();
    void tick();
    // Re-check context keys after the server is up. NO MODAL PROMPTS — the
    // user opts into both gates by clicking the buttons in the Welcome view
    // (atrune.welcome viewsWelcome). Activation must be silent so opening
    // any repo doesn't ambush the user with popups.
    void (async () => {
      await checkConnectionAndSetContext();
      await checkConsentAndSetContext();
    })();
    pollHandle = setInterval(() => {
      void tick();
      // Re-check consent on every poll so deleting <repo>/.atrune/ outside
      // the extension (e.g. `rm -rf .atrune/`) flips the sidebar back to the
      // initial Welcome view within ~5s.
      void checkConsentAndSetContext();
    }, 5000);
  })();

  ctx.subscriptions.push({ dispose: () => { if (pollHandle) clearInterval(pollHandle); } });

  server.log('Atrune extension activated.');
}

export async function deactivate() {
  if (pollHandle) clearInterval(pollHandle);
  await server?.dispose();
}
