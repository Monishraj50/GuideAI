// 💬 New brief composer — webview form with project folder, agent tags, budget.
//
// Form sections:
//   1. Project (workspace dropdown)
//   2. Goal (textarea, supports prefill from a template)
//   3. Project folder (where agents write code → becomes cwd) + Browse button
//   4. Tagged agents (auto-suggest button + chips + native add-agent picker)
//   5. Budget (Currency/Tokens toggle + amount input)
//   6. Security checkbox
//
// Message protocol with the extension host:
//   webview → ext:
//     {type:'pickFolder'}
//     {type:'suggestAgents', taskBody, workspaceId}
//     {type:'addAgent'}                                ← opens native QuickPick
//     {type:'submit', workspaceId, body, securityTagged, targetFolder, taggedAgents, budget}
//   ext → webview:
//     {type:'pickedFolder', path}
//     {type:'suggestions', items}
//     {type:'agentAdded', role, displayName}
//     {type:'submitting' | 'success' | 'error' | 'idle'}

import * as vscode from 'vscode';
import { AtruneApi, type WorkspaceSummary, type AgentSuggestion } from '../api';
import { pickTemplate } from '../templates';
import { confirmCost, forecastBrief } from '../costPreview';

let panel: vscode.WebviewPanel | undefined;

/** Close the brief-composer tab if it's open. Called on consent loss so a
 *  user mid-typing on a deleted project doesn't submit into thin air. */
export function closeBriefComposerIfOpen(): boolean {
  if (!panel) return false;
  try { panel.dispose(); } catch {}
  panel = undefined;
  return true;
}

export async function openBriefComposer(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  activeWorkspaceId: () => string | null,
  onDispatched: (info?: {
    workspaceId?: string;
    briefId?: string;
    // S4: server may have routed this brief through the quick lane. Extension
    // uses these to skip Kanban and open a single result panel instead.
    quick?: boolean;
    quickReason?: string;
    run?: any;
  }) => void | Promise<void>,
) {
  if (panel) { panel.reveal(vscode.ViewColumn.Two); return; }

  const picked = await pickTemplate(ctx);
  if (picked === null) return;
  const prefill = picked === 'blank' ? '' : picked.body;

  panel = vscode.window.createWebviewPanel(
    'atrune.briefComposer',
    'Atrune · New brief',
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.svg');

  const workspaces = await api.listWorkspaces();
  const active = activeWorkspaceId();
  panel.webview.html = renderHtml(workspaces, active, prefill);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {

      case 'suggestAgents': {
        const taskBody = String(msg.taskBody ?? '').trim();
        if (!taskBody) {
          panel?.webview.postMessage({ type: 'suggestions', items: [] });
          return;
        }
        const r = await api.suggestAgents({
          taskBody,
          workspaceId: msg.workspaceId || undefined,
          limit: 5,
        });
        panel?.webview.postMessage({ type: 'suggestions', items: r.suggestions });
        return;
      }

      case 'addAgent': {
        const q = await vscode.window.showInputBox({
          prompt: 'Search the agent catalog by role / specialty',
          placeHolder: 'e.g. python, security, frontend',
          ignoreFocusOut: true,
        });
        if (!q?.trim()) return;
        const results = await api.searchCatalog(q.trim());
        if (results.length === 0) {
          vscode.window.showInformationMessage(`No agents matched "${q}"`);
          return;
        }
        const pick = await vscode.window.showQuickPick(
          results.slice(0, 20).map((a) => ({
            label: `$(person) ${a.displayName}`,
            description: a.role,
            detail: a.description,
            role: a.role,
            displayName: a.displayName,
          })),
          { placeHolder: 'Pick an agent to tag' },
        );
        if (pick) {
          panel?.webview.postMessage({
            type: 'agentAdded',
            role: (pick as any).role,
            displayName: (pick as any).displayName,
          });
        }
        return;
      }

      case 'submit': {
        const wsId = String(msg.workspaceId ?? '');
        const body = String(msg.body ?? '').trim();
        const securityTagged = !!msg.securityTagged;
        const taggedAgents = Array.isArray(msg.taggedAgents)
          ? msg.taggedAgents.filter((r: unknown) => typeof r === 'string' && (r as string).trim())
          : undefined;
        const budget = msg.budget && typeof msg.budget.amount === 'number' && msg.budget.amount > 0
          ? { mode: msg.budget.mode === 'tokens' ? 'tokens' as const : 'currency' as const, amount: msg.budget.amount }
          : undefined;
        // Phase D — direct-dispatch from the composer runs end-to-end. Mode
        // selection only happens for plan-approval flows (web UI / project page),
        // where the user picks Auto/Manual in the "Ready to implement" panel.

        if (!wsId || !body) {
          panel?.webview.postMessage({ type: 'error', error: 'workspace + brief body are required' });
          return;
        }

        // Cost preview — tagged agent count informs the forecast.
        const agentCount = Math.max(3, (taggedAgents?.length ?? 0));
        const forecast = forecastBrief(body, agentCount);
        const confirmed = await confirmCost(forecast, 'This brief');
        if (!confirmed) {
          panel?.webview.postMessage({ type: 'idle' });
          return;
        }

        panel?.webview.postMessage({ type: 'submitting' });
        // targetFolder is now a workspace-level setting; the orchestrator
        // reads it from the workspace meta.json. We don't send it per-brief.
        //
        // Dispatched briefs mirror the project-creation flow: assisted mode,
        // so Phase 1 pauses at the Plan editor for Approve / Regenerate /
        // Reject. preferredModel is read server-side from the workspace's
        // intake row when we don't send one explicitly — matches the
        // regenerate route's fallback path.
        const r = await api.submitBrief({
          workspaceId: wsId, body, securityTagged, taggedAgents, budget,
          mode: 'assisted',
        });
        if (r.ok) {
          panel?.webview.postMessage({ type: 'success', briefId: r.briefId });
          // Pass briefId + workspaceId so the caller can auto-navigate.
          // The caller handles its own notifications now (extension.ts shows
          // "Open project view" / "Open Kanban board" buttons).
          await onDispatched({
            workspaceId: wsId, briefId: r.briefId,
            quick: r.quick, quickReason: r.quickReason, run: r.run,
          });
          setTimeout(() => panel?.dispose(), 1200);
        } else {
          panel?.webview.postMessage({ type: 'error', error: r.error });
        }
        return;
      }

      // 'detailed' brief flow removed in S1 (discovery + critique cut).
    }
  });

  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
}

function renderHtml(
  workspaces: WorkspaceSummary[],
  active: string | null,
  prefill: string,
): string {
  const options = workspaces
    .map((w) => `<option value="${w.id}"${w.id === active ? ' selected' : ''}>${escapeHtml(w.name)}</option>`)
    .join('');
  const hasWorkspaces = workspaces.length > 0;
  const prefillText = escapeHtml(prefill);

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
    --soft: var(--vscode-editorWidget-background, #1a1f29);
    --accent: var(--vscode-button-background, #5cf2c0);
    --accent-fg: var(--vscode-button-foreground, #0e1116);
    --teal: #14B8A6;
    --err: var(--vscode-errorForeground, #f48771);
    --ok:  var(--vscode-testing-iconPassed, #5cf2c0);
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
  body { padding: 24px; max-width: 760px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 20px; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); margin: 14px 0 6px; }
  select, textarea, input[type=text], input[type=number] {
    width: 100%; box-sizing: border-box; padding: 8px 10px;
    background: var(--bg); color: var(--ink);
    border: 1px solid var(--line); border-radius: 4px;
    font: inherit; font-size: 13px;
  }
  textarea { min-height: 140px; resize: vertical; font-family: ui-monospace, monospace; line-height: 1.5; }
  .row { display: flex; gap: 8px; align-items: stretch; }
  .row input { flex: 1; }
  .row button { flex-shrink: 0; }

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
  button.tiny { padding: 4px 8px; font-size: 12px; }

  .status { font-size: 12px; }
  .status.error { color: var(--err); }
  .status.ok { color: var(--ok); }
  .empty { padding: 32px; text-align: center; color: var(--dim); border: 1px dashed var(--line); border-radius: 6px; font-size: 13px; }

  /* Tagged-agents chips */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; min-height: 28px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--soft); border: 1px solid var(--line); border-radius: 999px;
    padding: 4px 8px 4px 10px; font-size: 12px;
  }
  .chip .meta { color: var(--dim); font-size: 11px; }
  .chip.fresh { border-color: var(--teal); }
  .chip .x {
    cursor: pointer; opacity: 0.6; padding: 0 2px;
    border: 0; background: transparent; color: var(--ink); font-size: 14px; line-height: 1;
  }
  .chip .x:hover { opacity: 1; }
  .chips-actions { display: flex; gap: 6px; margin-top: 4px; }
  .hint { font-size: 11px; color: var(--dim); margin-top: 4px; }

  /* Budget */
  .budget-row { display: flex; gap: 10px; align-items: center; }
  .budget-toggle { display: flex; gap: 4px; }
  .budget-toggle label {
    margin: 0; text-transform: none; letter-spacing: 0; font-size: 12px;
    padding: 6px 10px; border: 1px solid var(--line); border-radius: 4px; cursor: pointer;
    color: var(--ink);
  }
  .budget-toggle input[type=radio] { display: none; }
  .budget-toggle input[type=radio]:checked + label {
    background: var(--soft); border-color: var(--teal); color: var(--ink);
  }
  .budget-amount { display: flex; align-items: center; gap: 6px; flex: 1; }
  .budget-amount input { flex: 1; }
  .budget-amount .unit { color: var(--dim); font-size: 12px; min-width: 24px; }

</style>
</head>
<body>
  <h1>💬 New brief</h1>
  <p class="sub">Describe the work, point us at a folder, tag who should do it, set a budget. Missing agents are added to your team automatically.</p>

  ${hasWorkspaces ? `
  <form id="form">
    <label for="workspace">Project</label>
    <select id="workspace" required>${options}</select>

    <label for="body">Goal</label>
    <textarea id="body" placeholder="e.g. Build a tiny URL-shortener API with a POST /shorten endpoint that persists to SQLite." required>${prefillText}</textarea>

    <label>👥 Tag agents · missing roles get added to your team on dispatch</label>
    <div id="chips" class="chips"></div>
    <div class="chips-actions">
      <button type="button" class="secondary tiny" id="suggest">⚡ Suggest from brief</button>
      <button type="button" class="secondary tiny" id="add-agent">+ Add agent…</button>
      <span class="hint" id="tag-hint"></span>
    </div>

    <label>💰 Budget</label>
    <div class="budget-row">
      <div class="budget-toggle">
        <input type="radio" id="budget-currency" name="budget-mode" value="currency" checked />
        <label for="budget-currency">Currency</label>
        <input type="radio" id="budget-tokens" name="budget-mode" value="tokens" />
        <label for="budget-tokens">Tokens</label>
      </div>
      <div class="budget-amount">
        <span class="unit" id="budget-prefix">$</span>
        <input type="number" id="budget-amount" min="0" step="0.5" placeholder="5.00" />
        <span class="unit" id="budget-suffix"></span>
      </div>
    </div>
    <div class="hint">Soft cap surfaced in the status bar; the workspace budget cap is the hard stop.</div>

    <div class="checkbox-row">
      <input type="checkbox" id="security" />
      <label for="security">Security-tagged · review runs at pass@3 with cross-vendor opinion (if configured)</label>
    </div>

    <div class="actions">
      <button type="submit" id="submit">▶ Dispatch brief</button>
      <button type="button" class="secondary" id="cancel">Cancel</button>
      <span class="status" id="status"></span>
    </div>
    <div class="hint" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
      Tasks dispatch immediately and run plan → implement → review.
    </div>
  </form>
  ` : `
  <div class="empty">
    No projects yet. Run <strong>Atrune: New project…</strong> from the command palette to open the intake form, then come back.
  </div>
  `}

  <script>
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('form');
    const statusEl = document.getElementById('status');
    const submitBtn = document.getElementById('submit');

    // ── Tag chips state ─────────────────────────────────────────────────
    const tagged = new Map(); // role → { displayName, hiredAlready, fresh }
    const chipsEl = document.getElementById('chips');
    const tagHintEl = document.getElementById('tag-hint');

    function renderChips() {
      if (!chipsEl) return;
      chipsEl.innerHTML = '';
      if (tagged.size === 0) {
        chipsEl.innerHTML = '<span class="hint">No agents tagged. Click ⚡ Suggest or + Add agent.</span>';
        if (tagHintEl) tagHintEl.textContent = '';
        return;
      }
      for (const [role, info] of tagged) {
        const chip = document.createElement('span');
        chip.className = 'chip' + (info.fresh ? ' fresh' : '');
        chip.innerHTML =
          (info.displayName ? '<strong>' + info.displayName + '</strong>' : '<strong>' + role + '</strong>') +
          '<span class="meta">' + role + '</span>' +
          (info.hiredAlready === false ? '<span class="meta">· new role</span>' : '') +
          '<button type="button" class="x" data-role="' + role + '">×</button>';
        chipsEl.appendChild(chip);
      }
      // remove handlers
      chipsEl.querySelectorAll('.x').forEach((b) => {
        b.addEventListener('click', () => {
          tagged.delete(b.getAttribute('data-role'));
          renderChips();
        });
      });
      const freshCount = [...tagged.values()].filter((v) => v.hiredAlready === false).length;
      if (tagHintEl) tagHintEl.textContent = freshCount > 0
        ? freshCount + ' new role(s) will be added to your team on dispatch'
        : 'all tagged agents already on your team';
    }
    renderChips();

    // ── Budget toggle (currency / tokens with k-suffix) ─────────────────
    const budgetPrefix = document.getElementById('budget-prefix');
    const budgetSuffix = document.getElementById('budget-suffix');
    const budgetAmount = document.getElementById('budget-amount');
    function refreshBudgetUnit() {
      const tokensMode = document.getElementById('budget-tokens').checked;
      if (tokensMode) {
        budgetPrefix.textContent = '';
        budgetSuffix.textContent = 'k tokens';
        budgetAmount.step = '1';
        budgetAmount.placeholder = '50';
      } else {
        budgetPrefix.textContent = '$';
        budgetSuffix.textContent = '';
        budgetAmount.step = '0.5';
        budgetAmount.placeholder = '5.00';
      }
    }
    refreshBudgetUnit();
    document.getElementById('budget-currency').addEventListener('change', refreshBudgetUnit);
    document.getElementById('budget-tokens').addEventListener('change', refreshBudgetUnit);

    // ── Suggest agents button ──────────────────────────────────────────
    document.getElementById('suggest').addEventListener('click', () => {
      const body = document.getElementById('body').value;
      const workspaceId = document.getElementById('workspace').value;
      if (!body.trim()) { alert('Type a brief body first.'); return; }
      tagHintEl.textContent = 'suggesting…';
      vscode.postMessage({ type: 'suggestAgents', taskBody: body, workspaceId });
    });

    // ── Add agent manually ─────────────────────────────────────────────
    document.getElementById('add-agent').addEventListener('click', () => {
      vscode.postMessage({ type: 'addAgent' });
    });

    // ── Submit ─────────────────────────────────────────────────────────
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const tokensMode = document.getElementById('budget-tokens').checked;
        const rawAmount = parseFloat(document.getElementById('budget-amount').value);
        const amount = isNaN(rawAmount) ? 0
          : (tokensMode ? Math.round(rawAmount * 1000) : rawAmount);
        vscode.postMessage({
          type: 'submit',
          workspaceId: document.getElementById('workspace').value,
          body: document.getElementById('body').value,
          taggedAgents: [...tagged.keys()],
          budget: amount > 0
            ? { mode: tokensMode ? 'tokens' : 'currency', amount }
            : undefined,
          securityTagged: document.getElementById('security').checked,
        });
      });
      document.getElementById('cancel').addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
      });
    }

    // ── Extension → webview message handler ────────────────────────────
    window.addEventListener('message', (e) => {
      const m = e.data; if (!m || !m.type) return;
      if (m.type === 'suggestions') {
        // Add each suggestion as a chip (skip duplicates).
        const items = Array.isArray(m.items) ? m.items : [];
        if (items.length === 0) { tagHintEl.textContent = 'no strong suggestions for this brief'; }
        for (const it of items) {
          if (!tagged.has(it.role)) {
            tagged.set(it.role, { displayName: it.displayName, hiredAlready: !!it.hiredAlready, fresh: true });
          }
        }
        renderChips();
      }
      if (m.type === 'agentAdded') {
        if (!tagged.has(m.role)) {
          tagged.set(m.role, { displayName: m.displayName, hiredAlready: false, fresh: true });
        }
        renderChips();
      }
      if (m.type === 'submitting') { submitBtn.disabled = true; statusEl.textContent = 'Dispatching…'; statusEl.className = 'status'; }
      if (m.type === 'success')    { statusEl.textContent = 'Dispatched · ' + (m.briefId || ''); statusEl.className = 'status ok'; }
      if (m.type === 'error')      { submitBtn.disabled = false; statusEl.textContent = 'Error: ' + m.error; statusEl.className = 'status error'; }
      if (m.type === 'idle')       { submitBtn.disabled = false; statusEl.textContent = ''; statusEl.className = 'status'; }
    });
  </script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
