// Rules editor — Custom-mode permission rules for this repo.
//
// Custom mode consults `rules[]` in order; first match wins. Each rule is:
//   { tool: 'Bash', argsPattern?: '^\\{"command":"git status.*', action: 'auto-approve' | 'always-ask' | 'deny' }
//
// Also lists the session allowlist (this-brief-only auto-approves) for
// visibility — read-only; it clears on brief completion.

import * as vscode from 'vscode';
import { AtruneApi, type PoliciesSnapshot } from '../api';

let panel: vscode.WebviewPanel | undefined;

export async function openRulesEditor(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  activeWorkspaceId: () => string | null,
): Promise<void> {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }

  panel = vscode.window.createWebviewPanel(
    'atrune.rulesEditor',
    'AtruneAI · Permission rules',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.svg');
  panel.onDidDispose(() => { panel = undefined; });

  async function rerender() {
    const policies = await api.getPolicies();
    const wsId = activeWorkspaceId();
    const sessionKeys = wsId ? await api.getSessionAllow(wsId) : [];
    panel!.webview.html = renderHtml(policies, sessionKeys);
  }
  await rerender();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'setMode': {
        const ok = await api.setPermissionMode(msg.mode);
        if (!ok) vscode.window.showErrorMessage('Failed to switch mode.');
        await rerender();
        break;
      }
      case 'addRule': {
        const { tool, argsPattern, action, description } = msg;
        if (!tool || !action) return;
        const id = `rule-user-${tool.toLowerCase()}-${Date.now().toString(36)}`;
        const ok = await api.addPolicyRule({
          id,
          description: description || `${action} ${tool}`,
          match: { tool, ...(argsPattern ? { argsPattern } : {}) },
          action,
        });
        if (!ok) vscode.window.showErrorMessage('Failed to add rule.');
        await rerender();
        break;
      }
      case 'deleteRule': {
        const ok = await api.deletePolicyRule(msg.id);
        if (!ok) vscode.window.showErrorMessage('Failed to delete rule.');
        await rerender();
        break;
      }
      case 'refresh': {
        await rerender();
        break;
      }
    }
  });
}

function renderHtml(policies: PoliciesSnapshot | null, sessionKeys: string[]): string {
  if (!policies) {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;color:var(--vscode-foreground)">
      <h1>Permission rules</h1>
      <p>Server not reachable. <button onclick="acquireVsCodeApi().postMessage({type:'refresh'})">Retry</button></p>
    </body>`;
  }
  const rows = policies.rules.map((r) => `
    <tr>
      <td><code>${escapeHtml(r.match.tool)}</code></td>
      <td><code>${escapeHtml(r.match.argsPattern ?? '')}</code></td>
      <td><span class="act act-${r.action}">${r.action}</span></td>
      <td>${escapeHtml(r.description)}</td>
      <td>${r.id.startsWith('rule-builtin-') ? '<em>builtin</em>' : `<button data-id="${escapeHtml(r.id)}" class="del">Delete</button>`}</td>
    </tr>`).join('');
  const sessionList = sessionKeys.length === 0
    ? '<p><em>none — Manual/Custom mode has no session-scoped allows for this workspace yet.</em></p>'
    : `<ul>${sessionKeys.map((k) => `<li><code>${escapeHtml(k)}</code></li>`).join('')}</ul>`;

  return `<!doctype html><meta charset="utf-8">
<style>
  body { font-family: system-ui; padding: 1.5rem; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { margin-top: 0; }
  h2 { margin-top: 2rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--vscode-widget-border, #444); vertical-align: top; }
  th { font-weight: 600; opacity: 0.8; }
  code { background: var(--vscode-textCodeBlock-background, #222); padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.9em; }
  .act { font-weight: 600; text-transform: uppercase; font-size: 0.8em; padding: 0.15rem 0.5rem; border-radius: 3px; }
  .act-auto-approve { background: rgba(80,200,120,0.25); }
  .act-always-ask   { background: rgba(230,180,80,0.25); }
  .act-deny         { background: rgba(230,80,80,0.25); }
  form { display: grid; grid-template-columns: 1fr 2fr 1fr auto; gap: 0.5rem; align-items: end; margin-top: 0.75rem; }
  label { display: flex; flex-direction: column; font-size: 0.85em; opacity: 0.85; }
  input, select { font: inherit; padding: 0.35rem 0.5rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; }
  button { padding: 0.4rem 0.9rem; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.del { background: transparent; color: var(--vscode-errorForeground); }
  .mode-banner { padding: 0.75rem 1rem; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); border-radius: 3px; margin: 1rem 0; }
  .mode-picker { display: flex; gap: 0.5rem; margin: 0.5rem 0 1rem; }
  .mode-pick { padding: 0.3rem 0.75rem; border: 1px solid var(--vscode-widget-border, #444); border-radius: 3px; cursor: pointer; background: transparent; }
  .mode-pick.active { background: var(--vscode-focusBorder); color: var(--vscode-editor-background); border-color: var(--vscode-focusBorder); }
</style>
<body>
  <h1>Permission rules</h1>
  <div class="mode-banner">
    <strong>Mode:</strong>
    <div class="mode-picker">
      <button class="mode-pick ${policies.mode === 'manual' ? 'active' : ''}" data-mode="manual">Manual — ask everything</button>
      <button class="mode-pick ${policies.mode === 'custom' ? 'active' : ''}" data-mode="custom">Custom — rules below</button>
      <button class="mode-pick ${policies.mode === 'auto' ? 'active' : ''}" data-mode="auto">Auto — allow everything safe</button>
    </div>
    <small>Rules only apply in Custom mode. Hard-denies (<code>rm -rf</code>, <code>--no-verify</code>) block in every mode.</small>
  </div>

  <h2>Rules (Custom mode)</h2>
  <table>
    <thead><tr><th>Tool</th><th>Args pattern (regex)</th><th>Action</th><th>Description</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5"><em>No rules yet.</em></td></tr>'}</tbody>
  </table>

  <h2>Add a rule</h2>
  <form id="add-form">
    <label>Tool <input name="tool" placeholder="Bash / Read / Edit / Write" required></label>
    <label>Args pattern <input name="argsPattern" placeholder='^\\{"command":"git status'></label>
    <label>Action
      <select name="action">
        <option value="auto-approve">auto-approve</option>
        <option value="always-ask" selected>always-ask</option>
        <option value="deny">deny</option>
      </select>
    </label>
    <button type="submit">Add rule</button>
  </form>
  <p><small>Args pattern is a regex tested against the JSON of the tool's args. Leave blank to match every call of the tool.</small></p>

  <h2>Session allowlist (this brief only)</h2>
  <p><small>Auto-approves granted via <em>Always allow (this session)</em> during the current brief. Wiped when the brief completes.</small></p>
  ${sessionList}

<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.mode-pick').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'setMode', mode: b.dataset.mode }));
  });
  document.querySelectorAll('button.del').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'deleteRule', id: b.dataset.id }));
  });
  document.getElementById('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    vscode.postMessage({
      type: 'addRule',
      tool: f.tool.value.trim(),
      argsPattern: f.argsPattern.value.trim(),
      action: f.action.value,
      description: '',
    });
    f.reset();
  });
</script>
</body>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
