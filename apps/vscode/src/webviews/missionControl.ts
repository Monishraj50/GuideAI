// 📦 Mission Control — opens the Atrune web UI in the user's default browser.
//
// Why not a webview iframe?
//   VS Code webviews are hosted on the vscode-webview:// origin (HTTPS-class).
//   Chromium blocks http://localhost iframes from HTTPS contexts as mixed
//   content. VS Code's portMapping only intercepts fetch/XHR initiated by JS
//   inside the webview — it does NOT rewrite iframe SRC URLs. And
//   asExternalUri() returns the original http URL on local installs (it only
//   tunnels in remote/SSH/Codespaces).
//
// So locally, an iframe at http://localhost:3000 inside a webview is blocked.
// The reliable pattern — used by Gitpod, Codespaces, and most "embed a dev
// server" extensions — is to open the web UI in the user's default browser.
// The VS Code sidebar handles in-editor state; the browser is the rich
// Mission Control experience.

import * as vscode from 'vscode';

export async function openMissionControl(
  ctx: vscode.ExtensionContext,
  opts: { route?: string } = {},
): Promise<void> {
  const webPort = vscode.workspace.getConfiguration('atrune').get<number>('webPort', 3000);
  const route = opts.route ?? '';
  const url = `http://localhost:${webPort}${route}?vscode=1`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
