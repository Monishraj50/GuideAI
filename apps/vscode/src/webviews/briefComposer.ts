// 💬 New brief composer — minimal native webview form.
//
// Fast path to dispatch a brief without opening Mission Control. Picks the
// active workspace from the dropdown, takes a goal in plain English, optional
// security tag, posts to /api/workspaces/:id/briefs. Phase 5 will swap this
// for the embedded BriefPane React component; for now native HTML is enough.

import * as vscode from 'vscode';
import { AtruneApi, type WorkspaceSummary } from '../api';

let panel: vscode.WebviewPanel | undefined;

export async function openBriefComposer(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  activeWorkspaceId: () => string | null,
  onDispatched: () => void,
) {
  if (panel) { panel.reveal(vscode.ViewColumn.Two); return; }

  panel = vscode.window.createWebviewPanel(
    'atrune.briefComposer',
    'Atrune · New brief',
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.svg');

  const workspaces = await api.listWorkspaces();
  const active = activeWorkspaceId();
  panel.webview.html = renderHtml(workspaces, active);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'submit': {
        const wsId = String(msg.workspaceId ?? '');
        const body = String(msg.body ?? '').trim();
        const securityTagged = !!msg.securityTagged;
        if (!wsId || !body) {
          panel?.webview.postMessage({ type: 'error', error: 'workspace + brief body are required' });
          return;
        }
        panel?.webview.postMessage({ type: 'submitting' });
        const r = await api.submitBrief({ workspaceId: wsId, body, securityTagged });
        if (r.ok) {
          panel?.webview.postMessage({ type: 'success', briefId: r.briefId });
          onDispatched();
          vscode.window.showInformationMessage(`Brief dispatched · ${r.briefId}`, 'Open Mission Control')
            .then((p) => { if (p === 'Open Mission Control') vscode.commands.executeCommand('atrune.openMissionControl'); });
          // Close the composer after a short delay so the success badge is visible
          setTimeout(() => panel?.dispose(), 1200);
        } else {
          panel?.webview.postMessage({ type: 'error', error: r.error });
        }
        return;
      }
    }
  });

  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
}

function renderHtml(workspaces: WorkspaceSummary[], active: string | null): string {
  const options = workspaces
    .map((w) => `<option value="${w.id}"${w.id === active ? ' selected' : ''}>${escapeHtml(w.name)}</option>`)
    .join('');
  const hasWorkspaces = workspaces.length > 0;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>Atrune · New brief</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0e1116);
    --ink: var(--vscode-editor-foreground, #e6e9ef);
    --dim: var(--vscode-descriptionForeground, #7e8390);
    --line: var(--vscode-panel-border, #2a2f3a);
    --accent: var(--vscode-button-background, #5cf2c0);
    --accent-fg: var(--vscode-button-foreground, #0e1116);
    --err: var(--vscode-errorForeground, #f48771);
    --ok: var(--vscode-testing-iconPassed, #5cf2c0);
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
  body { padding: 24px; max-width: 720px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 20px; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); margin: 14px 0 6px; }
  select, textarea, input[type=text] {
    width: 100%; box-sizing: border-box; padding: 8px 10px;
    background: var(--bg); color: var(--ink);
    border: 1px solid var(--line); border-radius: 4px;
    font: inherit; font-size: 13px;
  }
  textarea { min-height: 140px; resize: vertical; font-family: ui-monospace, monospace; line-height: 1.5; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .checkbox-row label { margin: 0; text-transform: none; font-size: 12px; color: var(--ink); letter-spacing: 0; }
  .actions { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
  button {
    padding: 7px 14px; border-radius: 4px; border: 0;
    background: var(--accent); color: var(--accent-fg);
    font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  .status { font-size: 12px; }
  .status.error { color: var(--err); }
  .status.ok { color: var(--ok); }
  .empty { padding: 32px; text-align: center; color: var(--dim); border: 1px dashed var(--line); border-radius: 6px; font-size: 13px; }
</style>
</head>
<body>
  <h1>💬 New brief</h1>
  <p class="sub">Describe what your team should do, in plain English. Atrune structures it for you.</p>

  ${hasWorkspaces ? `
  <form id="form">
    <label for="workspace">Project</label>
    <select id="workspace" required>${options}</select>

    <label for="body">Goal</label>
    <textarea id="body" placeholder="e.g. Build a tiny URL-shortener API with a POST /shorten endpoint that persists to SQLite." required></textarea>

    <div class="checkbox-row">
      <input type="checkbox" id="security" />
      <label for="security">Security-tagged · review runs at pass@3 with cross-vendor opinion (if configured)</label>
    </div>

    <div class="actions">
      <button type="submit" id="submit">Dispatch brief</button>
      <button type="button" class="secondary" id="cancel">Cancel</button>
      <span class="status" id="status"></span>
    </div>
  </form>
  ` : `
  <div class="empty">
    No projects yet. Open Mission Control to create one, then come back.
  </div>
  `}

  <script>
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('form');
    const statusEl = document.getElementById('status');
    const submit = document.getElementById('submit');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        vscode.postMessage({
          type: 'submit',
          workspaceId: document.getElementById('workspace').value,
          body: document.getElementById('body').value,
          securityTagged: document.getElementById('security').checked,
        });
      });
      document.getElementById('cancel').addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
      });
    }
    window.addEventListener('message', (e) => {
      const m = e.data; if (!m || !m.type) return;
      if (m.type === 'submitting') { submit.disabled = true; statusEl.textContent = 'Dispatching…'; statusEl.className = 'status'; }
      if (m.type === 'success')    { statusEl.textContent = 'Dispatched · ' + (m.briefId || ''); statusEl.className = 'status ok'; }
      if (m.type === 'error')      { submit.disabled = false; statusEl.textContent = 'Error: ' + m.error; statusEl.className = 'status error'; }
    });
  </script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
