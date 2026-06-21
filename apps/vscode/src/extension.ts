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
import { AtruneServer } from './server';
import { AtruneApi } from './api';
import { ActiveWorkProvider } from './views/activeWork';
import { ProgressProvider } from './views/progress';
import { TeamProvider } from './views/team';
import { openMissionControl } from './webviews/missionControl';
import { openBriefComposer } from './webviews/briefComposer';
import { quickAskChooser, askOneAgent, autoFix } from './directTask';
import { AtruneStatusBar } from './statusBar';
import { checkNewApprovals } from './approvals';
import { maybePromptFirstLaunch, resetFirstLaunch } from './firstLaunch';
import { openConnectSubscription } from './webviews/connectSubscription';

let server: AtruneServer | undefined;
let pollHandle: NodeJS.Timeout | undefined;
let statusBar: AtruneStatusBar | undefined;

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
          if (info?.workspaceId) {
            vscode.window.showInformationMessage(
              'Brief dispatched. Watch tasks appear in the sidebar, or open the project view.',
              'Open project view',
              'Open Kanban board',
            ).then((p) => {
              if (p === 'Open project view') {
                vscode.commands.executeCommand('atrune.openMissionControl', { route: `/projects/${info.workspaceId}` });
              } else if (p === 'Open Kanban board') {
                vscode.commands.executeCommand('atrune.openMissionControl', { route: '/board' });
              }
            });
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
      await resetFirstLaunch(ctx);
      await maybePromptFirstLaunch(ctx, api, async () => { await checkConnectionAndSetContext(); });
    }),
    vscode.commands.registerCommand('atrune.connectSubscription', async () => {
      await openConnectSubscription(ctx, api, async () => { await checkConnectionAndSetContext(); });
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
      const route = args.briefId
        ? `/projects/${args.workspaceId}#brief-${args.briefId}`
        : `/projects/${args.workspaceId}`;
      await vscode.commands.executeCommand('atrune.openMissionControl', { route });
    }),
    vscode.commands.registerCommand('atrune.showAgentWork', async (args?: {
      workspaceId: string; agentId: string; role: string; displayName: string;
    }) => {
      if (!args?.workspaceId || !args?.role) return;
      const items = await api.listAgentWork(args.workspaceId, args.role);
      if (items.length === 0) {
        const pick = await vscode.window.showInformationMessage(
          `${args.displayName} has no assigned work right now.`,
          'View in Mission Control',
        );
        if (pick === 'View in Mission Control') {
          vscode.commands.executeCommand('atrune.openMissionControl', { route: '/org' });
        }
        return;
      }
      const STATUS_GLYPH: Record<string, string> = {
        todo: '$(circle-outline)',
        in_progress: '$(sync~spin)',
        blocked: '$(warning)',
        done: '$(check)',
        cancelled: '$(circle-slash)',
      };
      const pick = await vscode.window.showQuickPick(
        items.map((it) => ({
          label: `${STATUS_GLYPH[it.status] ?? ''} ${it.title}`,
          description: it.status,
          detail: [it.phase, it.priority, it.description ?? '']
            .filter(Boolean).join(' · '),
          item: it,
        })),
        { placeHolder: `${args.displayName} · ${items.length} task${items.length > 1 ? 's' : ''} assigned` },
      );
      if (pick) {
        vscode.commands.executeCommand('atrune.openMissionControl', { route: '/board' });
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

  // Set the initial connection-context BEFORE the async startup so the
  // sidebar's welcome view (`!atrune.connected`) renders immediately on
  // first activation. We re-check after the server is up.
  void checkConnectionAndSetContext();

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
    // Re-check after server is up (now that we can hit /api/integrations/*)
    // and prompt first-launch if no provider is connected.
    void (async () => {
      await checkConnectionAndSetContext();
      await maybePromptFirstLaunch(ctx, api, async () => {
        await checkConnectionAndSetContext();
      });
    })();
    pollHandle = setInterval(() => { void tick(); }, 5000);
  })();

  ctx.subscriptions.push({ dispose: () => { if (pollHandle) clearInterval(pollHandle); } });

  server.log('Atrune extension activated.');
}

export async function deactivate() {
  if (pollHandle) clearInterval(pollHandle);
  await server?.dispose();
}
