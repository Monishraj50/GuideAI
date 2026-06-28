// S0 cleanup: Mission Control (apps/web) was deleted. This file is now
// a no-op so existing call sites compile. A toast tells the user the
// UI has moved into the VS Code sidebar.

import * as vscode from 'vscode';

let warned = false;

export async function openMissionControl(
  _ctx: vscode.ExtensionContext,
  _opts: { route?: string } = {},
): Promise<void> {
  if (warned) return;
  warned = true;
  setTimeout(() => { warned = false; }, 30_000);
  vscode.window.showInformationMessage(
    'Mission Control was removed in the simplification pass. Use the Atrune sidebar — every surface lives there now.',
  );
}
