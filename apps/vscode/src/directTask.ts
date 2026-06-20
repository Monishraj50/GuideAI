// Phase 3 — Direct-task UI: Quick ask flow + native result viewer.
//
// Two entry shapes:
//   askOneAgent — user picks an agent from the roster, types a prompt, agent runs.
//   autoFix     — user types a description; server picks/hires a relevant agent.
//
// After a successful run we show the response in an untitled Markdown editor
// tab (no webview chrome — pure VS Code), with a follow-up popup offering to
// open a diff against the workspace folder for files the agent may have touched.

import * as vscode from 'vscode';
import { AtruneApi, type DirectTaskRun } from './api';
import { confirmCost, forecastBrief } from './costPreview';

export async function askOneAgent(
  api: AtruneApi,
  activeWorkspaceId: () => string | null,
  preselectedPrompt?: string,
): Promise<void> {
  const wsId = activeWorkspaceId();
  if (!wsId) {
    vscode.window.showWarningMessage('No active Atrune project. Open one in Mission Control first.');
    return;
  }

  // Pick an agent from the roster (or offer to open the marketplace).
  const agents = await api.listAgents(wsId);
  if (agents.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      'No agents hired in this project yet. Use Auto-fix instead, or browse the marketplace.',
      'Auto-fix instead', 'Browse marketplace',
    );
    if (pick === 'Auto-fix instead') return autoFix(api, activeWorkspaceId, preselectedPrompt);
    if (pick === 'Browse marketplace') {
      vscode.commands.executeCommand('atrune.openMissionControl');
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    agents.map((a) => ({
      label: a.displayName,
      description: a.role,
      detail: `status: ${a.status}`,
      agentId: a.id,
    })),
    { placeHolder: 'Pick an agent to ask' },
  );
  if (!picked) return;

  const prompt = await vscode.window.showInputBox({
    prompt: `What should ${picked.label} do?`,
    value: preselectedPrompt,
    ignoreFocusOut: true,
    placeHolder: 'Describe the task in plain English…',
  });
  if (!prompt?.trim()) return;

  // Cost preview — direct tasks are cheaper than briefs (1 agent, no pipeline).
  const askForecast = forecastBrief(prompt, 1);
  askForecast.usd *= 0.4;
  askForecast.minutes = Math.max(1, askForecast.minutes * 0.3);
  if (!(await confirmCost(askForecast, `Asking ${picked.label}`))) return;

  await runWithProgress(`${picked.label} working…`, async () => {
    const r = await api.directTask({
      workspaceId: wsId, agentId: picked.agentId, prompt: prompt.trim(),
      cwd: currentFolderCwd(),
    });
    await handleRunResult(r.ok ? r.run! : null, r.error, picked.label);
  });
}

export async function autoFix(
  api: AtruneApi,
  activeWorkspaceId: () => string | null,
  preselectedDescription?: string,
): Promise<void> {
  const wsId = activeWorkspaceId();
  if (!wsId) {
    vscode.window.showWarningMessage('No active Atrune project. Open one in Mission Control first.');
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: 'What should we fix or build?',
    value: preselectedDescription,
    ignoreFocusOut: true,
    placeHolder: 'e.g. add input validation to the /shorten endpoint',
  });
  if (!description?.trim()) return;

  // Cost preview — auto-fix runs an abbreviated 3-phase pipeline.
  const fixForecast = forecastBrief(description, 2);
  fixForecast.usd *= 0.6;
  fixForecast.minutes = Math.max(2, fixForecast.minutes * 0.6);
  if (!(await confirmCost(fixForecast, 'Auto-fixing this'))) return;

  await runWithProgress('Auto-fix · picking an agent…', async () => {
    const r = await api.autoFix({
      workspaceId: wsId, description: description.trim(),
      cwd: currentFolderCwd(),
    });
    await handleRunResult(r.ok ? r.run! : null, r.error, r.run?.pickedAgentRole ?? 'agent');
  });
}

// ---------- shared ----------

async function handleRunResult(run: DirectTaskRun | null, error: string | undefined, who: string): Promise<void> {
  if (!run) {
    vscode.window.showErrorMessage(`Atrune · run failed: ${error ?? 'unknown'}`);
    return;
  }
  if (run.status === 'budget-blocked') {
    vscode.window.showWarningMessage(`Atrune · budget gate paused this task: ${run.error ?? ''}`);
    return;
  }
  if (run.status === 'error') {
    vscode.window.showErrorMessage(`Atrune · ${who} failed: ${run.error ?? ''}`);
    return;
  }

  // Show the response in an untitled Markdown tab (no webview chrome).
  const header = [
    `# Atrune · direct task`,
    ``,
    `**Agent**: ${run.agentId}`,
    `**Prompt**: ${run.prompt}`,
    `**Tokens**: ${run.tokensIn}↓ / ${run.tokensOut}↑ · ~$${run.costUsd.toFixed(4)}`,
    `**Duration**: ${run.durationMs}ms`,
    ``,
    `---`,
    ``,
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({
    content: header + (run.text || '_(empty response)_'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  // Phase 3 native-diff teaser: if the active VS Code folder has uncommitted
  // changes after the run, offer to show them. We don't try to detect which
  // files specifically — that's a v1.1 enhancement once we wire SCM signals.
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 0) {
    vscode.window.showInformationMessage(
      `${who} finished. If files were edited in this folder, open the SCM panel to see the diff.`,
      'Open SCM',
    ).then((pick) => {
      if (pick === 'Open SCM') vscode.commands.executeCommand('workbench.view.scm');
    });
  }
}

async function runWithProgress<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    () => fn(),
  );
}

function currentFolderCwd(): string | undefined {
  const folder = (vscode.workspace.workspaceFolders ?? [])[0];
  return folder?.uri.fsPath;
}

/** Common entry: when the user invokes Quick ask, choose between the two
 *  modes via a QuickPick. Phase 5 will polish this with templates. */
export async function quickAskChooser(
  api: AtruneApi,
  activeWorkspaceId: () => string | null,
  contextPrompt?: string,
): Promise<void> {
  const items: Array<vscode.QuickPickItem & { mode: 'auto' | 'one' }> = [
    {
      label: '⚡ Auto-fix this',
      description: 'describe what to do; we pick the right agent',
      mode: 'auto',
    },
    {
      label: '🎯 Ask one agent',
      description: 'pick an agent from your roster; you control who runs it',
      mode: 'one',
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Quick ask — how do you want to dispatch this?' });
  if (!pick) return;
  if (pick.mode === 'auto') return autoFix(api, activeWorkspaceId, contextPrompt);
  return askOneAgent(api, activeWorkspaceId, contextPrompt);
}
