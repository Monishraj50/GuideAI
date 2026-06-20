// Zero-config first-launch: if no global Claude integration exists, prompt
// the user once for either an Anthropic API key or to use the local Claude
// CLI. After this, all auto-created workspaces inherit the global default —
// the user never sees an integration setup screen again.

import * as vscode from 'vscode';
import { AtruneApi } from './api';

const STORAGE_KEY = 'atrune.firstLaunchHandled';

export async function maybePromptFirstLaunch(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
): Promise<void> {
  // Already handled? Skip.
  if (ctx.globalState.get<boolean>(STORAGE_KEY)) return;

  const global = await api.getGlobalClaude();
  if (global?.ready) {
    // Already configured (perhaps via the web UI). Don't bother the user.
    await ctx.globalState.update(STORAGE_KEY, true);
    return;
  }

  // Show the connect-or-key picker.
  const choice = await vscode.window.showInformationMessage(
    'Welcome to AtruneAI. Connect to Claude to get started — pick one:',
    'Use my local Claude CLI',
    'Paste an Anthropic API key',
    'Skip for now',
  );

  if (choice === 'Use my local Claude CLI') {
    const r = await api.connectGlobalClaudeCli();
    if (r.ok) {
      vscode.window.showInformationMessage('Atrune · Claude CLI connected. You\'re ready to brief.');
      await ctx.globalState.update(STORAGE_KEY, true);
    } else {
      vscode.window.showErrorMessage(
        `Could not connect Claude CLI: ${r.error}. Run \`claude login\` in a terminal first, then re-run "Atrune: Show me around".`,
      );
    }
    return;
  }

  if (choice === 'Paste an Anthropic API key') {
    const key = await vscode.window.showInputBox({
      prompt: 'Paste your Anthropic API key',
      placeHolder: 'sk-ant-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith('sk-ant-') ? null : 'Should start with sk-ant-…'),
    });
    if (!key?.trim()) return;

    const r = await api.setGlobalClaudeApiKey(key.trim());
    if (r.ok) {
      vscode.window.showInformationMessage('Atrune · key saved. You\'re ready to brief.');
      await ctx.globalState.update(STORAGE_KEY, true);
    } else {
      vscode.window.showErrorMessage(`Could not save key: ${r.error}`);
    }
    return;
  }

  // User skipped — don't pester them again this session, but re-check next time.
}

/** Reset the first-launch flag (debug / re-onboarding). */
export async function resetFirstLaunch(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.globalState.update(STORAGE_KEY, undefined);
}
