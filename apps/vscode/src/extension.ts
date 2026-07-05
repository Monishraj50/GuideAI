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
import { PermissionsProvider } from './views/permissions';
import { openApprovalDiff } from './approvalDiff';
import { PermissionsStream } from './permissionsStream';
import { openRulesEditor } from './webviews/rulesEditor';
import { openMissionControl } from './webviews/missionControl';
import { openBriefComposer } from './webviews/briefComposer';
import { openKanban } from './webviews/kanban';
import { openNewProject } from './webviews/newProject';
import { openLiveClaudeSession } from './liveClaudeTerminal';
import { openLiveSessionTail } from './sessionTail';
import { quickAskChooser, askOneAgent, autoFix } from './directTask';
import { AtruneStatusBar } from './statusBar';
import { checkNewApprovals } from './approvals';
import { resetFirstLaunch } from './firstLaunch';
import { openConnectSubscription, clearFolderSubscriptionAuthorization } from './webviews/connectSubscription';
import { hasConsent, hasSubscriptionAuthorized, promptForConsent, revokeAndWipe, getActiveConsentedFolder } from './folderConsent';

let server: AtruneServer | undefined;
let pollHandle: NodeJS.Timeout | undefined;
let statusBar: AtruneStatusBar | undefined;

/**
 * `claude --resume` only lists sessions whose project dir matches the
 * current cwd. So to open a specific session we must spawn the terminal
 * in the cwd Claude originally used. We can't decode the project dir name
 * back to a path (slashes and original dashes collide), so we read the
 * `cwd` field from the first JSON record of the .jsonl itself.
 */
function findCwdForSession(sessionId: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const jsonl = path.join(root, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonl)) continue;
    try {
      const head = fs.readFileSync(jsonl, 'utf8').slice(0, 8192);
      for (const line of head.split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
        } catch {}
      }
    } catch {}
    return null;
  }
  return null;
}

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

  // Per-window workspace routing: tag every localhost API call with the
  // header `X-Atrune-Workspace: <open-folder>`. The Fastify server uses
  // it to pick `<folder>/.atrune/db.sqlite` per request — so two VS Code
  // windows hitting the same `:4000` see DIFFERENT data. Done by patching
  // globalThis.fetch once at activation so api.ts, kanban.ts, sessionTail.ts,
  // liveClaudeTerminal.ts etc. all pick it up without per-file edits.
  if (!(globalThis as any).__atruneFetchPatched) {
    const _origFetch = globalThis.fetch.bind(globalThis);
    (globalThis as any).fetch = (input: any, init?: any) => {
      try {
        const u = typeof input === 'string'
          ? input
          : (input?.url ?? String(input));
        if (typeof u === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(u)) {
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (folder) {
            const headers = new Headers(init?.headers ?? {});
            headers.set('X-Atrune-Workspace', folder);
            return _origFetch(input, { ...(init ?? {}), headers });
          }
        }
      } catch {}
      return _origFetch(input, init);
    };
    (globalThis as any).__atruneFetchPatched = true;
  }

  // Per-repo isolation: every window resolves consent purely from its own
  // open folder's `.atrune/.consent.json`. On activation:
  //   1. Delete the legacy global pointer so old builds can't leak.
  //   2. If the open folder has no `.atrune/`, wipe the matching Claude
  //      session jsonls so deleting .atrune truly clears every cache.
  try {
    const { deleteLegacyActiveFolderPointer, reapOrphanedClaudeSessions } = await import('./folderConsent');
    const ptr = deleteLegacyActiveFolderPointer();
    if (ptr.removed) server.log('removed legacy global active-folder pointer (per-repo isolation enforced now)');
    const r = reapOrphanedClaudeSessions();
    if (r.reaped > 0) server.log(`reaped ${r.reaped} orphan Claude session dir(s) tied to ${r.folder}`);
  } catch {}

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
  //
  // Per-folder gate: even if global creds exist, `atrune.connected` stays
  // false until <folder>/.atrune/.subscription-authorized.json exists. That
  // file is written when the user clicks Connect inside the modal, and is
  // wiped when the user deletes .atrune/. Combined with .consent.json, this
  // makes the entire authorization story disappear with one rm -rf .atrune/.
  async function checkConnectionAndSetContext(): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const folderAuthorized = !!(folder && hasSubscriptionAuthorized(folder));
    if (!folderAuthorized) {
      await vscode.commands.executeCommand('setContext', 'atrune.connected', false);
      return false;
    }
    const claude = await api.getGlobalClaude();
    const copilotInstalled = !!vscode.extensions.getExtension('GitHub.copilot');
    const connected = !!(claude?.ready || copilotInstalled);
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
    // Prefer the persisted "active" folder so the consent state stays true
    // even when the user picked a folder DIFFERENT from the open one.
    const active = getActiveConsentedFolder();
    const consented = !!active;
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
    vscode.commands.registerCommand('atrune.actions', async () => {
      // Persistent quick-access menu — invoked from the status bar click.
      const activeFolder = getActiveConsentedFolder();
      const folder = activeFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      const consented = !!activeFolder;
      const subAuthed = !!(folder && hasSubscriptionAuthorized(folder));
      const serverAlive = await api.isAlive();
      type Action =
        | 'connect' | 'allow' | 'revoke' | 'disconnectAtrune'
        | 'mission' | 'briefs' | 'kanban' | 'newProject' | 'restart'
        | 'resumeClaude' | 'resumePipeline';
      const items: Array<{ label: string; description?: string; detail?: string; action: Action }> = [];
      if (!consented) {
        items.push({ label: '$(folder-active) Allow project storage', description: 'Step 1', action: 'allow' });
      }
      items.push({
        label: subAuthed
          ? '$(plug) Manage subscription · disconnect / switch provider'
          : '$(plug) Connect a subscription',
        description: consented ? (subAuthed ? 'connected' : 'Step 2') : '$(lock) requires Step 1',
        action: 'connect',
      });
      if (consented) {
        items.push({ label: '$(add) New project', description: 'open the new-project form', action: 'newProject' });
        items.push({ label: '$(comment-discussion) New brief…', detail: 'opens the brief composer', action: 'briefs' });
        items.push({ label: '$(layout) Open Kanban for active brief…', action: 'kanban' });
        items.push({ label: '$(debug-restart) Resume Claude session…', description: 'pick a saved brief', action: 'resumeClaude' });
        items.push({ label: '$(debug-continue) Resume brief pipeline…', description: 'recover a brief that got stuck after a crash', action: 'resumePipeline' });
      }
      items.push({ label: '$(window) Open Mission Control (browser)', action: 'mission' });
      items.push({ label: '$(refresh) Restart Atrune server', action: 'restart' });
      // Disconnect Atrune — full shutdown: subscription cleared, server killed
      // (port :4000 freed), per-folder subscription marker removed. .atrune/
      // contents stay so reconnecting later resumes the same project state.
      if (serverAlive || subAuthed) {
        items.push({
          label: '$(debug-disconnect) Disconnect Atrune',
          description: 'stop the server + remove subscription · .atrune/ stays',
          action: 'disconnectAtrune',
        });
      }
      if (consented) {
        items.push({ label: '$(trash) Revoke folder storage (delete .atrune/)', description: 'reset to initial state', action: 'revoke' });
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Atrune actions',
        matchOnDescription: true,
      });
      if (!pick) return;
      switch (pick.action) {
        case 'allow':   return vscode.commands.executeCommand('atrune.allowFolderStorage');
        case 'connect': return vscode.commands.executeCommand('atrune.connectSubscription');
        case 'newProject': return vscode.commands.executeCommand('atrune.newProject');
        case 'briefs':  return vscode.commands.executeCommand('atrune.newBrief');
        case 'kanban':  return vscode.commands.executeCommand('atrune.openKanban');
        case 'mission': return vscode.commands.executeCommand('atrune.openMissionControl');
        case 'restart': return vscode.commands.executeCommand('atrune.restartServer');
        case 'revoke':  return vscode.commands.executeCommand('atrune.revokeFolderStorage');
        case 'disconnectAtrune': return vscode.commands.executeCommand('atrune.disconnectAtrune');
        case 'resumeClaude': return vscode.commands.executeCommand('atrune.resumeClaudeSession');
        case 'resumePipeline': {
          // Quick Pick across all recent briefs that are 'active' (i.e. haven't
          // been marked done/failed). Most relevant target after a crash.
          const wsId = activeWorkspaceId;
          if (!wsId) { vscode.window.showInformationMessage('No active project.'); return; }
          const plan = await api.getPlan(wsId);
          const candidates = (plan?.briefs.recent ?? []).filter((b) => b.status === 'active');
          if (candidates.length === 0) {
            vscode.window.showInformationMessage('No active briefs to resume.');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            candidates.map((b) => ({
              label: `$(debug-continue) ${(b.body.split('\n')[0] ?? b.id).slice(0, 80)}`,
              description: `${b.id.slice(-6)} · ${b.status}`,
              detail: new Date(b.createdAt).toLocaleString(),
              briefId: b.id,
            })),
            { placeHolder: 'Pick a brief to resume' },
          );
          if (!picked) return;
          return vscode.commands.executeCommand('atrune.resumeBriefPipeline', { briefId: picked.briefId });
        }
      }
    }),
    vscode.commands.registerCommand('atrune.disconnectAtrune', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Disconnect Atrune?\n\n' +
        'This will:\n' +
        '  • Disconnect your subscription (Claude tokens cleared)\n' +
        '  • Stop the Atrune server and free port 4000\n' +
        '  • Remove the per-folder subscription marker\n\n' +
        'Your .atrune/ folder, project DB, briefs, and transcripts STAY.\n' +
        'Click any connect / setup action later to bring it back.',
        { modal: true },
        'Disconnect',
      );
      if (confirm !== 'Disconnect') return;
      // 1. Global creds cleared so the Connect modal starts from "Not Connected"
      try { await api.disconnectGlobalClaude(); } catch {}
      // 2. Per-folder subscription marker removed (folder consent stays)
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (folder) {
        try {
          const { revokeSubscriptionAuthorization } = require('./folderConsent') as typeof import('./folderConsent');
          revokeSubscriptionAuthorization(folder);
        } catch {}
      }
      // 3. Server processes killed → port :4000 freed
      await server?.dispose();
      server = undefined;
      // 4. Flip context keys so sidebar reflects the disconnected state
      await vscode.commands.executeCommand('setContext', 'atrune.connected', false);
      // (folderConsented stays true so the user keeps the Step 2-only Welcome view)
      await checkConsentAndSetContext();
      refreshAll();
      vscode.window.showInformationMessage('Atrune disconnected. Click "Connect a subscription" anytime to bring it back.');
    }),
    vscode.commands.registerCommand('atrune.connectSubscription', async () => {
      // If the server was killed (Disconnect Atrune), bring it back up before
      // opening the modal — the modal calls /api/integrations endpoints.
      if (!server || !(await api.isAlive())) {
        server?.dispose().catch(() => {});
        server = new AtruneServer();
        await server.ensureRunning();
      }
      // Gate Step 2 behind Step 1. Connect modal cannot open until the user
      // has explicitly granted folder storage for this project. The active
      // folder may be DIFFERENT from the open VS Code folder if the user
      // picked one via "Pick a different folder…" — check that, not the
      // open folder.
      const activeFolder = getActiveConsentedFolder();
      if (!activeFolder) {
        const pick = await vscode.window.showInformationMessage(
          'Allow project storage first. Atrune writes its DB + transcripts inside `.atrune/` — the folder needs to be opted in before any subscription can be wired up.',
          { modal: true },
          'Allow storage now',
        );
        if (pick === 'Allow storage now') {
          await vscode.commands.executeCommand('atrune.allowFolderStorage');
        }
        return;
      }
      await openConnectSubscription(ctx, api, async () => { await checkConnectionAndSetContext(); });
    }),
    vscode.commands.registerCommand('atrune.allowFolderStorage', async () => {
      const activeFolder = getActiveConsentedFolder();
      if (activeFolder) {
        const re = await vscode.window.showInformationMessage(
          `Atrune storage is already enabled for:\n\n  ${activeFolder}/.atrune/\n\n` +
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
      // Revoke the ACTIVE consented folder (which may differ from the open
      // VS Code folder if the user picked one via "Pick a different folder…").
      const folder = getActiveConsentedFolder();
      if (!folder) {
        vscode.window.showInformationMessage('No consented folder — nothing to revoke.');
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
        // Clear per-folder subscription authorization so the Connect modal
        // starts from "Not Connected" again next time it's opened.
        await clearFolderSubscriptionAuthorization(ctx);
        await vscode.commands.executeCommand('setContext', 'atrune.connected', false);
        const extra = result.claudeSessionsRemoved > 0
          ? ` · Wiped ${result.claudeSessionsRemoved} Claude session dir(s) under ~/.claude/projects/`
          : '';
        vscode.window.showInformationMessage(
          `Removed ${result.path}. Atrune is now in initial state.${extra}`,
        );
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
    vscode.commands.registerCommand('atrune.newProject', async () => {
      await openNewProject(ctx, api, async (workspaceId) => {
        setActiveWorkspaceId(workspaceId);
        await refreshActiveWorkspaceImmediate();
        refreshAll();
        vscode.window.showInformationMessage(`Project created · ${workspaceId}`);
      });
    }),
    vscode.commands.registerCommand('atrune.editProjectIntake', async (workspaceId?: string) => {
      // Resume an "empty" project's intake from Active Work. Opens the same
      // New Project tab in edit-mode — name is pre-filled and read-only,
      // intake fields seeded from whatever was saved before.
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) return;
      await openNewProject(
        ctx, api,
        async (id) => {
          setActiveWorkspaceId(id);
          await refreshActiveWorkspaceImmediate();
          refreshAll();
          vscode.window.showInformationMessage(`Intake saved · ${id}`);
        },
        { existingWorkspaceId: workspaceId },
      );
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
    vscode.commands.registerCommand('atrune.resumeClaudeSession', async () => {
      // Sessions are now per-(feature_tag, role) and stamped on work_items.
      // List every DISTINCT session UUID across this workspace's work_items
      // so the user picks one and we open the right `claude --resume <uuid>`.
      const wsId = activeWorkspaceId;
      if (!wsId) {
        vscode.window.showInformationMessage('No active project. Open one in Active Work first.');
        return;
      }
      const items = await api.listWorkItems(wsId);
      // Group by sessionId → take one representative item per session.
      const bySession = new Map<string, typeof items[number]>();
      for (const w of items) {
        if (!w.claudeSessionId) continue;
        const prev = bySession.get(w.claudeSessionId);
        if (!prev || w.updatedAt > prev.updatedAt) bySession.set(w.claudeSessionId, w);
      }
      if (bySession.size === 0) {
        vscode.window.showInformationMessage('No saved Claude sessions yet for this project. Dispatch a brief first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [...bySession.entries()].map(([sid, w]) => ({
          label: `$(comment-discussion) ${w.assignedRole ?? '(no role)'} · ${w.featureTag ?? '(no feature)'}`,
          description: `${sid.slice(0, 8)}…`,
          detail: `last activity: ${new Date(w.updatedAt).toLocaleString()} · status: ${w.status}`,
          sessionId: sid,
        })),
        { placeHolder: 'Pick a Claude session to resume', matchOnDescription: true, matchOnDetail: true },
      );
      if (!picked) return;
      // Spawn in the cwd the original Claude session used — `claude --resume`
      // only lists sessions whose project dir matches the cwd. Read it from
      // the .jsonl itself; fall back to workspace targetFolder / open folder.
      const meta = await api.getWorkspaceMeta(wsId);
      const cwd = findCwdForSession(picked.sessionId)
        ?? meta?.targetFolder?.trim()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const t = vscode.window.createTerminal({
        name: `claude --resume ${picked.sessionId.slice(0, 8)}`,
        cwd,
        iconPath: new vscode.ThemeIcon('comment-discussion'),
      });
      t.sendText(`claude --resume ${picked.sessionId}`, true);
      t.show(true);
    }),
    vscode.commands.registerCommand('atrune.openTaskClaudeTerminal', async (args?: {
      workspaceId?: string; taskId?: string; briefId?: string;
    }) => {
      // Click handler for a task in Progress Tracker / Team. Resolves the
      // task's per-(feature, role) Claude session UUID, finds the cwd it
      // was originally launched from (read from the jsonl), and opens a
      // VS Code terminal running `claude --resume <uuid>` there.
      const wsId = args?.workspaceId ?? activeWorkspaceId;
      if (!wsId) { vscode.window.showInformationMessage('No active project.'); return; }
      const items = await api.listWorkItems(wsId);
      let sessionId: string | null = null;
      let label = '';
      if (args?.taskId) {
        const item = items.find((w) => w.id === args.taskId);
        sessionId = item?.claudeSessionId ?? null;
        label = `${item?.assignedRole ?? ''} · ${item?.phase ?? ''}`;
      } else if (args?.briefId) {
        const briefItems = items
          .filter((w) => w.briefId === args.briefId && w.claudeSessionId)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        sessionId = briefItems[0]?.claudeSessionId ?? null;
        label = `${briefItems[0]?.assignedRole ?? ''} · ${briefItems[0]?.phase ?? ''}`;
      }
      if (!sessionId) {
        vscode.window.showInformationMessage('No Claude session yet for this task — drag a phase card to Active to start the agent.');
        return;
      }
      // Spawn in the cwd the original session used so `claude --resume`
      // resolves correctly. Read the cwd from the jsonl (lossy slash-to-
      // dash encoding can't be inverted; the jsonl stores the real cwd).
      const cwd = findCwdForSession(sessionId)
        ?? (await api.getWorkspaceMeta(wsId))?.targetFolder?.trim()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const t = vscode.window.createTerminal({
        name: `claude · ${label || sessionId.slice(0, 8)}`,
        cwd,
        iconPath: new vscode.ThemeIcon('comment-discussion'),
      });
      t.sendText(`claude --resume ${sessionId}`, true);
      t.show(true);
    }),
    vscode.commands.registerCommand('atrune.openLiveSessionTail', async (args?: {
      workspaceId?: string; briefId?: string; taskId?: string;
    }) => {
      const wsId = args?.workspaceId ?? activeWorkspaceId;
      if (!wsId) {
        vscode.window.showInformationMessage('No active project.');
        return;
      }
      // taskId is the preferred selector — opens THIS work_item's session,
      // so two tasks under the same brief but different roles open
      // different sessions. briefId is the legacy fallback.
      if (!args?.taskId && !args?.briefId) {
        vscode.window.showInformationMessage('No task/brief context for live session.');
        return;
      }
      await openLiveSessionTail(api, {
        workspaceId: wsId,
        taskId: args?.taskId,
        briefId: args?.briefId,
      });
    }),
    vscode.commands.registerCommand('atrune.resumeBriefPipeline', async (args?: {
      briefId?: string;
    }) => {
      // Re-run the brief's pipeline from where it left off. Used when the
      // server died mid-phase and tasks are stuck. The orchestrator skips
      // phases whose artifact is already on disk, so it's safe to call.
      const briefId = args?.briefId;
      if (!briefId) {
        vscode.window.showInformationMessage('No brief context for resume.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Resume pipeline for ${briefId}?\n\n` +
        'Re-runs runPipeline for this brief. Phases whose artifact is already on disk are skipped, ' +
        'so this is safe even if some phases completed before the disruption.',
        { modal: true }, 'Resume',
      );
      if (confirm !== 'Resume') return;
      const r = await api.resumeBrief(briefId);
      if (r.ok) {
        vscode.window.showInformationMessage(`Resumed ${briefId}. Watch the Progress Tracker for live updates.`);
        vscode.commands.executeCommand('atrune.refresh');
      } else {
        vscode.window.showErrorMessage(`Resume failed: ${r.error ?? 'unknown error'}`);
      }
    }),
    vscode.commands.registerCommand('atrune.resumeBriefSession', async (args?: {
      workspaceId?: string; briefId?: string;
    }) => {
      // Click handler for a task in Progress Tracker / Team. Looks up the
      // brief's stored Claude session UUID and opens a VS Code terminal
      // running `claude --resume <uuid>` in the cwd Claude originally used —
      // identical UX to typing it in a shell yourself.
      const wsId = args?.workspaceId ?? activeWorkspaceId;
      const briefId = args?.briefId;
      if (!wsId || !briefId) {
        vscode.window.showInformationMessage('No brief context for this task.');
        return;
      }
      const plan = await api.getPlan(wsId);
      const brief = (plan?.briefs.recent ?? []).find((b) => b.id === briefId);
      if (!brief?.claudeSessionId) {
        vscode.window.showInformationMessage(
          `No Claude session for ${briefId} yet — it gets created when the first phase runs.`,
        );
        return;
      }
      // `claude --resume` only lists sessions matching the current cwd, so
      // we MUST spawn the terminal in the same dir Claude was launched in.
      // The jsonl encodes its cwd in the first JSON record — read it.
      const cwd = findCwdForSession(brief.claudeSessionId)
        ?? (await api.getWorkspaceMeta(wsId))?.targetFolder?.trim()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const t = vscode.window.createTerminal({
        name: `claude --resume ${brief.claudeSessionId.slice(0, 8)}`,
        cwd,
        iconPath: new vscode.ThemeIcon('comment-discussion'),
      });
      t.sendText(`claude --resume ${brief.claudeSessionId}`, true);
      t.show(true);
    }),
    vscode.commands.registerCommand('atrune.openLiveClaude', async (args?: {
      workspaceId?: string; briefId?: string; phase?: string; role?: string;
    }) => {
      if (!args?.workspaceId || !args?.briefId || !args?.phase || !args?.role) {
        vscode.window.showInformationMessage('No task selected — pick a task from Progress Tracker or Team.');
        return;
      }
      await openLiveClaudeSession(api, {
        workspaceId: args.workspaceId,
        briefId: args.briefId,
        phase: args.phase as any,
        role: args.role,
      });
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
    vscode.commands.registerCommand('atrune.openBriefOverallPlan', async (args?: {
      workspaceId?: string; briefId?: string;
    }) => {
      if (!args?.workspaceId || !args?.briefId) return;
      // Resolve the workspace's md root (visible atrune/ if folder-bound,
      // else sandbox under ~/.guideai/workspaces/<id>/).
      const meta = await api.getWorkspaceMeta(args.workspaceId);
      const mdRoot = meta?.targetFolder?.trim()
        ? path.join(meta.targetFolder, 'atrune')
        : path.join(process.env.GUIDEAI_HOME || path.join(os.homedir(), '.guideai'), 'workspaces', args.workspaceId);
      const file = path.join(mdRoot, 'briefs', args.briefId, 'overallplan.md');
      if (!fs.existsSync(file)) {
        const pick = await vscode.window.showInformationMessage(
          `overallplan.md not found yet for ${args.briefId}. The orchestrator writes it on dispatch.`,
          'Open Kanban instead',
        );
        if (pick === 'Open Kanban instead') {
          await vscode.commands.executeCommand('atrune.openKanban', args);
        }
        return;
      }
      const uri = vscode.Uri.file(file);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
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
    vscode.commands.registerCommand('atrune.setPermissionMode', async () => {
      const current = await api.getPermissionMode();
      type ModePick = vscode.QuickPickItem & { mode: 'auto' | 'manual' | 'custom' };
      const pick = await vscode.window.showQuickPick<ModePick>([
        {
          label: '$(shield) Manual',
          description: current === 'manual' ? '· current' : '',
          detail: 'Ask before every tool call. Safest.',
          mode: 'manual',
        },
        {
          label: '$(law) Custom',
          description: current === 'custom' ? '· current' : '',
          detail: 'Read/Glob/Grep auto-allow; Bash/Edit/Write ask. Editable rules.',
          mode: 'custom',
        },
        {
          label: '$(rocket) Auto',
          description: current === 'auto' ? '· current' : '',
          detail: 'Auto-approve everything safe. Hard-denies (rm -rf, --no-verify) still block.',
          mode: 'auto',
        },
      ], { placeHolder: 'Pick a permission mode' });
      if (!pick || pick.mode === current) return;
      const ok = await api.setPermissionMode(pick.mode);
      if (ok) {
        vscode.window.setStatusBarMessage(`Atrune · permission mode: ${pick.mode}`, 3000);
        refreshAll();
      } else {
        vscode.window.showErrorMessage('Failed to switch permission mode.');
      }
    }),
    vscode.commands.registerCommand('atrune.killswitch', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Killswitch: terminate every running agent process now?\n\n' +
        'All in-flight tasks stop. Pending approvals denied. .atrune/ stays.',
        { modal: true }, 'Kill everything',
      );
      if (confirm !== 'Kill everything') return;
      const r = await api.killswitch(activeWorkspaceId ?? undefined);
      if (r) {
        vscode.window.showInformationMessage(
          `Atrune · killed ${r.killed} agent${r.killed === 1 ? '' : 's'} in ${r.durationMs}ms.`,
        );
        refreshAll();
      } else {
        vscode.window.showErrorMessage('Killswitch failed — server unreachable?');
      }
    }),
    vscode.commands.registerCommand('atrune.openRulesEditor', async () => {
      await openRulesEditor(ctx, api, () => activeWorkspaceId);
    }),
    vscode.commands.registerCommand('atrune.reviewApproval', async (args?: {
      approvalId?: string; tool?: string; args?: Record<string, unknown>;
    }) => {
      if (!args?.approvalId || !activeWorkspaceId) return;
      await openApprovalDiff(api, {
        approvalId: args.approvalId,
        tool: args.tool ?? '',
        args: args.args ?? {},
        workspaceId: activeWorkspaceId,
        onDecided: () => refreshAll(),
      });
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
  const activeWork  = new ActiveWorkProvider(api, () => activeWorkspaceId);
  const progress    = new ProgressProvider(api, () => activeWorkspaceId);
  const team        = new TeamProvider(api, () => activeWorkspaceId);
  const permissions = new PermissionsProvider(api, () => activeWorkspaceId);
  const permissionsStream = new PermissionsStream(
    () => api.serverBase(),
    () => permissions.refresh(),
  );
  ctx.subscriptions.push({ dispose: () => permissionsStream.dispose() });

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
    vscode.window.registerTreeDataProvider('atrune.permissions', permissions),
    vscode.window.registerTreeDataProvider('atrune.activeWork', activeWork),
    vscode.window.registerTreeDataProvider('atrune.progress', progress),
    vscode.window.registerTreeDataProvider('atrune.team', team),
  );

  refreshAll = () => {
    permissions.refresh();
    activeWork.refresh();
    progress.refresh();
    team.refresh();
  };

  statusBar = new AtruneStatusBar();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  async function tick() {
    await refreshActiveWorkspace();
    refreshAll();
    // Keep the SSE stream pointed at whatever workspace is currently active.
    // No-op when the ID hasn't changed, so this is safe to call every tick.
    permissionsStream.setWorkspace(activeWorkspaceId);
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
