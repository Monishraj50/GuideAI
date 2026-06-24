// Zero-config first-launch — two gates the user passes through before Atrune
// is actually usable:
//   1. Subscription connect (Claude CLI / API key / Copilot / Codex)
//   2. Folder consent (allow .atrune/ storage in the open repo)
//
// Gate 1 lives at ~/.guideai/integrations/ (cross-project, persists).
// Gate 2 lives at <folder>/.atrune/.consent.json (per-folder, vanishes with
// the folder — deleting .atrune/ resets the project to initial state).

import * as vscode from 'vscode';
import { AtruneApi } from './api';
import { openConnectSubscription } from './webviews/connectSubscription';
import { hasConsent, promptForConsent } from './folderConsent';

const STORAGE_KEY = 'atrune.firstLaunchHandled';

export async function maybePromptFirstLaunch(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  onConnected: () => Promise<void> | void,
): Promise<void> {
  // Gate 1 — subscription. Skip if already connected globally.
  const global = await api.getGlobalClaude();
  if (!global?.ready) {
    await openConnectSubscription(ctx, api, async () => {
      // After connect, fall through to the consent gate below.
      await maybePromptFolderConsent();
      await ctx.globalState.update(STORAGE_KEY, true);
      await onConnected();
    });
    return;
  }

  // Subscription already connected. Mark first-launch as handled (covers the
  // legacy single-gate flow). Then check the consent gate independently —
  // even if first-launch was previously handled, if the user deleted .atrune/
  // we want to re-prompt for consent so the data location stays explicit.
  if (!ctx.globalState.get<boolean>(STORAGE_KEY)) {
    await ctx.globalState.update(STORAGE_KEY, true);
  }
  await maybePromptFolderConsent();
  await onConnected();
}

/** Gate 2 — folder consent. Only prompts when the open folder has NO
 *  .atrune/.consent.json. If the user previously consented and then deleted
 *  the .atrune/ folder, we'll re-prompt here automatically. */
export async function maybePromptFolderConsent(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const open = folders[0]?.uri.fsPath;
  if (open && hasConsent(open)) return; // already consented; nothing to do
  await promptForConsent();
}

export async function resetFirstLaunch(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.globalState.update(STORAGE_KEY, undefined);
}
