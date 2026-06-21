// Zero-config first-launch — opens the Connect Subscription webview if no
// provider is configured. After this runs once successfully, never shown
// again until the user runs `Atrune: Re-connect Claude (reset first-launch)`.
//
// Connection-state detection is done at activation in extension.ts; this
// module only opens the webview when needed.

import * as vscode from 'vscode';
import { AtruneApi } from './api';
import { openConnectSubscription } from './webviews/connectSubscription';

const STORAGE_KEY = 'atrune.firstLaunchHandled';

export async function maybePromptFirstLaunch(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  onConnected: () => void,
): Promise<void> {
  if (ctx.globalState.get<boolean>(STORAGE_KEY)) return;

  const global = await api.getGlobalClaude();
  if (global?.ready) {
    // Already configured (via the web UI or env). Skip without prompting.
    await ctx.globalState.update(STORAGE_KEY, true);
    onConnected();
    return;
  }

  // Open the webview connect screen and mark first-launch as handled.
  await openConnectSubscription(ctx, api, async () => {
    await ctx.globalState.update(STORAGE_KEY, true);
    onConnected();
  });
}

export async function resetFirstLaunch(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.globalState.update(STORAGE_KEY, undefined);
}
