// 📦 Mission Control webview — embeds the existing Next.js UI in an iframe.
//
// VS Code webviews can't normally load arbitrary localhost URLs because the
// webview itself lives on a special vscode-webview:// origin. The trick is
// `portMapping` — VS Code transparently rewrites the webview's view of
// `localhost:<webviewPort>` to hit the extension host's `extensionHostPort`.
//
// So the iframe inside the webview HTML loads `http://localhost:3000`, which
// VS Code routes to the real :3000 process running on the user's machine.

import * as vscode from 'vscode';

/** Singleton panel — reuse if already open. */
let panel: vscode.WebviewPanel | undefined;

export function openMissionControl(ctx: vscode.ExtensionContext, opts: { route?: string } = {}) {
  const webPort = vscode.workspace.getConfiguration('atrune').get<number>('webPort', 3000);
  const serverPort = vscode.workspace.getConfiguration('atrune').get<number>('serverPort', 4000);
  const route = opts.route ?? '';
  const iframeSrc = `http://localhost:${webPort}${route}?vscode=1`;

  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    // Navigate the existing iframe by re-posting HTML (cheaper than tearing down)
    panel.webview.html = renderHtml(iframeSrc, webPort, serverPort);
    return panel;
  }

  panel = vscode.window.createWebviewPanel(
    'atrune.missionControl',
    'Atrune · Mission Control',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      portMapping: [
        { webviewPort: webPort,    extensionHostPort: webPort },
        { webviewPort: serverPort, extensionHostPort: serverPort },
      ],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.svg');
  panel.webview.html = renderHtml(iframeSrc, webPort, serverPort);

  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);

  // Bridge: relay messages between the iframe and the extension host so
  // Phase 3+ can implement native VS Code actions (openDiff, openInEditor, etc.)
  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'atrune:openInEditor': {
        const uri = typeof msg.path === 'string' ? vscode.Uri.file(msg.path) : null;
        if (uri) vscode.window.showTextDocument(uri);
        return;
      }
      // More bridge messages land here in Phase 3+.
    }
  });

  return panel;
}

function renderHtml(iframeSrc: string, webPort: number, serverPort: number): string {
  // CSP — allow the iframe + inline script for the bridge.
  const csp = [
    `default-src 'none'`,
    `frame-src http://localhost:${webPort} http://localhost:${serverPort}`,
    `script-src 'unsafe-inline'`,
    `style-src 'unsafe-inline'`,
    `img-src https: data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Atrune · Mission Control</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100vh; width: 100vw; background: #0e1116; color: #e6e9ef; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
    .empty {
      display: flex; align-items: center; justify-content: center;
      height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif;
      color: #7e8390; font-size: 13px;
    }
  </style>
</head>
<body>
  <iframe id="atrune-frame" src="${iframeSrc}"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          allow="clipboard-write"></iframe>
  <script>
    // Bridge between the iframe and the VS Code extension host.
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('atrune-frame');

    // iframe → ext
    window.addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      vscode.postMessage(e.data);
    });

    // ext → iframe
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (frame.contentWindow) frame.contentWindow.postMessage(e.data, '*');
    });
  </script>
</body>
</html>`;
}
