// 📋 New project intake webview — native VS Code tab with the same fields the
// web UI's IntakeSection renders (goal, project folder, success criteria,
// constraints, budget, planning mode, hire mode), plus an optional
// "run round-table now" trigger.
//
// Replaces the legacy "Open Mission Control to create a project" link in the
// Active Work empty state. Submission flow:
//   1. POST /api/workspaces { name, targetFolder }
//   2. PUT  /api/workspaces/:id/intake { goal, successCriteria, constraints,
//      budgetHintUsd, budgetHintUnit, planningMode, hireMode }
//   3. (optional) POST /api/workspaces/:id/discovery to kick the round-table
//   4. Close the tab + refresh sidebars + set active workspace.

import * as vscode from 'vscode';
import { AtruneApi } from '../api';

let panel: vscode.WebviewPanel | undefined;

type PlanningMode = 'auto' | 'assisted' | 'manual';
type HireMode = 'auto' | 'manual' | 'hybrid';
type BudgetUnit = 'USD' | 'EUR' | 'GBP' | 'INR' | 'JPY' | 'tokens';

export async function openNewProject(
  ctx: vscode.ExtensionContext,
  api: AtruneApi,
  onCreated: (workspaceId: string) => void | Promise<void>,
  options?: { existingWorkspaceId?: string },
): Promise<void> {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }

  panel = vscode.window.createWebviewPanel(
    'atrune.newProject',
    options?.existingWorkspaceId
      ? `AtruneAI · Finish setup · ${options.existingWorkspaceId}`
      : 'AtruneAI · New project',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.svg');

  const openFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // Edit-mode prefill: when re-opening an existing empty workspace, read the
  // workspace's name + targetFolder + intake fields and seed the form so the
  // user picks up where they left off.
  let prefill: PrefillState | null = null;
  if (options?.existingWorkspaceId) {
    prefill = await loadPrefillFromWorkspace(options.existingWorkspaceId);
  }
  panel.webview.html = renderHtml({
    defaultTargetFolder: openFolder,
    prefill,
    existingWorkspaceId: options?.existingWorkspaceId ?? null,
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'pickFolder': {
        const initial = msg.current?.trim() || openFolder;
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          openLabel: 'Use this folder',
          defaultUri: initial ? vscode.Uri.file(initial) : undefined,
        });
        if (picked && picked[0]) {
          panel?.webview.postMessage({ type: 'pickedFolder', path: picked[0].fsPath });
        }
        return;
      }

      case 'submit': {
        const name = String(msg.name ?? '').trim();
        const goal = String(msg.goal ?? '').trim();
        const targetFolder = String(msg.targetFolder ?? '').trim() || undefined;
        const successCriteria = Array.isArray(msg.successCriteria)
          ? msg.successCriteria.map(String).map((s: string) => s.trim()).filter(Boolean)
          : [];
        const constraints = Array.isArray(msg.constraints)
          ? msg.constraints.map(String).map((s: string) => s.trim()).filter(Boolean)
          : [];
        const budgetHintUsd = typeof msg.budgetHintUsd === 'number' && msg.budgetHintUsd > 0
          ? msg.budgetHintUsd
          : null;
        const budgetHintUnit: BudgetUnit = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'tokens'].includes(msg.budgetHintUnit)
          ? msg.budgetHintUnit
          : 'USD';
        const planningMode: PlanningMode = ['auto', 'assisted', 'manual'].includes(msg.planningMode)
          ? msg.planningMode
          : 'assisted';
        const hireMode: HireMode = ['auto', 'manual', 'hybrid'].includes(msg.hireMode)
          ? msg.hireMode
          : 'manual';
        const runDiscovery = !!msg.runDiscovery && planningMode !== 'manual';

        if (!name) {
          panel?.webview.postMessage({ type: 'error', error: 'Project name is required' });
          return;
        }
        if (!goal) {
          panel?.webview.postMessage({ type: 'error', error: 'Goal is required' });
          return;
        }

        panel?.webview.postMessage({ type: 'submitting' });
        try {
          // 1. Either reuse an existing workspace (edit-mode finish-setup
          //    flow) or create a new one. In edit-mode we still PATCH the
          //    targetFolder in case the user picked a different one.
          let wsId: string;
          if (options?.existingWorkspaceId) {
            wsId = options.existingWorkspaceId;
            if (targetFolder) {
              await fetch(`http://localhost:4000/api/workspaces/${wsId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ targetFolder }),
              }).catch(() => {});
            }
          } else {
            const created = await api.createWorkspace(name, targetFolder);
            if (!created.ok || !created.id) {
              throw new Error(created.error ?? 'workspace create failed');
            }
            wsId = created.id;
          }

          // 2. Save intake fields
          const intakeResp = await fetch(`http://localhost:4000/api/workspaces/${wsId}/intake`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              goal,
              successCriteria,
              constraints,
              budgetHintUsd,
              budgetHintUnit,
              planningMode,
              hireMode,
            }),
          });
          if (!intakeResp.ok) {
            const j = await intakeResp.json().catch(() => ({}));
            throw new Error(`intake save failed: ${(j as any).error ?? intakeResp.status}`);
          }

          // 3. Optional: kick off discovery round-table
          if (runDiscovery) {
            // Fire-and-forget — the round-table takes ~30s; the user can
            // watch progress on the project page in Mission Control or the
            // sidebar.
            void fetch(`http://localhost:4000/api/workspaces/${wsId}/discovery`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            }).catch(() => {});
          }

          panel?.webview.postMessage({ type: 'success', workspaceId: wsId });
          await onCreated(wsId);
          // Close the tab shortly after — give the success state a moment to render.
          setTimeout(() => panel?.dispose(), 900);
        } catch (e: any) {
          panel?.webview.postMessage({ type: 'error', error: e?.message ?? String(e) });
        }
        return;
      }

      case 'cancel': {
        panel?.dispose();
        return;
      }
    }
  });

  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
}

interface PrefillState {
  name: string;
  targetFolder: string;
  goal: string;
  successCriteria: string[];
  constraints: string[];
  budgetHintUsd: number | null;
  budgetHintUnit: BudgetUnit;
  planningMode: PlanningMode;
  hireMode: HireMode;
}

/** Edit-mode prefill: read workspace + intake + meta and shape it for the
 *  form. Used when re-opening an empty workspace from Active Work. */
async function loadPrefillFromWorkspace(workspaceId: string): Promise<PrefillState | null> {
  try {
    const [wsResp, intakeResp, metaResp] = await Promise.all([
      fetch(`http://localhost:4000/api/workspaces`).catch(() => null),
      fetch(`http://localhost:4000/api/workspaces/${workspaceId}/intake`).catch(() => null),
      fetch(`http://localhost:4000/api/workspaces/${workspaceId}/meta`).catch(() => null),
    ]);
    const wsList = (wsResp?.ok ? ((await wsResp.json()) as any).workspaces ?? [] : []) as any[];
    const ws = wsList.find((w: any) => w.id === workspaceId);
    const intakeJson = intakeResp?.ok ? (await intakeResp.json() as any) : null;
    const i = (intakeJson?.intake ?? {}) as any;
    const metaJson = metaResp?.ok ? (await metaResp.json() as any) : null;
    return {
      name: ws?.name ?? workspaceId,
      targetFolder: (metaJson?.targetFolder ?? '') as string,
      goal: i.goal ?? '',
      successCriteria: Array.isArray(i.successCriteria) ? i.successCriteria : [],
      constraints: Array.isArray(i.constraints) ? i.constraints : [],
      budgetHintUsd: i.budgetHintUsd ?? null,
      budgetHintUnit: (i.budgetHintUnit ?? 'USD') as BudgetUnit,
      planningMode: (i.planningMode ?? 'assisted') as PlanningMode,
      hireMode: (i.hireMode ?? 'manual') as HireMode,
    };
  } catch {
    return null;
  }
}

function renderHtml(opts: { defaultTargetFolder: string; prefill: PrefillState | null; existingWorkspaceId: string | null }): string {
  const initial = opts.prefill;
  const targetFolderJson = JSON.stringify(initial?.targetFolder || opts.defaultTargetFolder);
  const initialJson = JSON.stringify(initial);
  const headline = opts.existingWorkspaceId
    ? `📋 Finish setup · <code>${opts.existingWorkspaceId}</code>`
    : '📋 New project';
  const sub = opts.existingWorkspaceId
    ? "This project was created but its intake isn't filled in yet. Complete the fields below to run the round-table."
    : 'Set the intake fields and (optionally) run the discovery round-table immediately.';
  const nameReadonly = opts.existingWorkspaceId ? 'readonly' : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>New project · Atrune</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0e1116);
    --ink: var(--vscode-editor-foreground, #e6e9ef);
    --dim: var(--vscode-descriptionForeground, #7e8390);
    --line: var(--vscode-panel-border, #2a2f3a);
    --soft: var(--vscode-editorWidget-background, #1a1f29);
    --accent: var(--vscode-button-background, #5cf2c0);
    --accent-fg: var(--vscode-button-foreground, #0e1116);
    --err:  var(--vscode-errorForeground, #f48771);
    --ok:   var(--vscode-testing-iconPassed, #5cf2c0);
    --teal: #14B8A6;
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
  body { padding: 24px; max-width: 760px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 20px; }
  label.field { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); margin: 16px 0 6px; }
  .hint { font-size: 11px; color: var(--dim); margin-top: 4px; }
  input[type=text], input[type=number], textarea, select {
    width: 100%; box-sizing: border-box;
    background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 4px;
    padding: 8px 10px; font: inherit; font-size: 13px;
  }
  textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, monospace; line-height: 1.5; }
  .row { display: flex; gap: 8px; align-items: stretch; }
  .row input { flex: 1; }
  .row button { flex-shrink: 0; }
  button {
    padding: 7px 12px; border-radius: 4px; border: 0;
    background: var(--accent); color: var(--accent-fg);
    font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button.tiny { padding: 3px 8px; font-size: 12px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Chips */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; min-height: 26px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--soft); border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 6px 3px 10px; font-size: 12px;
  }
  .chip .x { cursor: pointer; opacity: 0.6; border: 0; background: transparent; color: var(--ink); font-size: 14px; padding: 0 2px; line-height: 1; }
  .chip .x:hover { opacity: 1; }

  /* Mode cards */
  .mode-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .mode-grid input[type=radio] { display: none; }
  .mode-card {
    margin: 0; padding: 10px 12px; border: 1.5px solid var(--line); border-radius: 6px;
    background: var(--soft); cursor: pointer; color: var(--ink);
    text-transform: none; letter-spacing: 0;
  }
  .mode-card:hover { border-color: var(--teal); }
  .mode-grid input[type=radio]:checked + .mode-card {
    border-color: var(--teal); background: rgba(20, 184, 166, 0.08); box-shadow: 0 0 0 1px var(--teal);
  }
  .mode-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .mode-desc { font-size: 10.5px; color: var(--dim); line-height: 1.4; }

  /* Budget row */
  .budget-row { display: flex; gap: 8px; align-items: center; }
  .budget-row input[type=number] { width: 140px; flex: 0 0 auto; }
  .budget-row select { width: auto; }

  .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .checkbox-row label { margin: 0; text-transform: none; font-size: 12px; color: var(--ink); letter-spacing: 0; }

  .actions { display: flex; gap: 8px; margin-top: 22px; align-items: center; }
  .status { font-size: 12px; margin-left: auto; }
  .status.error { color: var(--err); }
  .status.ok    { color: var(--ok); }
</style>
</head><body>
  <h1>${headline}</h1>
  <p class="sub">${sub}</p>

  <form id="form">
    <label class="field" for="name">Project name</label>
    <input id="name" type="text" placeholder="e.g. Palette Picker" required ${nameReadonly} />

    <label class="field" for="goal">Goal</label>
    <textarea id="goal" placeholder="Build a single-page color palette generator that…" required></textarea>

    <label class="field" for="folder">Project folder (where agents write code)</label>
    <div class="row">
      <input id="folder" type="text" placeholder="/home/you/projects/this-project" />
      <button type="button" class="secondary tiny" id="pick-folder">Browse…</button>
    </div>
    <div class="hint">Leave empty to use the sandbox. Opening this folder in VS Code later reconnects the project.</div>

    <label class="field">Success criteria</label>
    <div id="criteria-chips" class="chips"></div>
    <div class="row">
      <input id="criteria-draft" type="text" placeholder="e.g. user finishes in under 2 minutes" />
      <button type="button" class="secondary tiny" id="criteria-add">Add</button>
    </div>

    <label class="field">Constraints</label>
    <div id="constraints-chips" class="chips"></div>
    <div class="row">
      <input id="constraints-draft" type="text" placeholder="e.g. must work offline; ship by Friday" />
      <button type="button" class="secondary tiny" id="constraints-add">Add</button>
    </div>

    <label class="field">Budget hint</label>
    <div class="budget-row">
      <input id="budget-amount" type="number" min="0" step="0.5" placeholder="5.00" />
      <select id="budget-unit">
        <option value="USD" selected>USD ($)</option>
        <option value="EUR">EUR (€)</option>
        <option value="GBP">GBP (£)</option>
        <option value="INR">INR (₹)</option>
        <option value="JPY">JPY (¥)</option>
        <option value="tokens">Tokens</option>
      </select>
      <span class="hint">leave blank = no limit</span>
    </div>

    <label class="field">Planning mode</label>
    <div class="mode-grid">
      <input type="radio" id="plan-auto"     name="planning-mode" value="auto" />
      <label for="plan-auto" class="mode-card"><div class="mode-title">Auto</div><div class="mode-desc">Run round-table, synthesis → brief, pipeline starts.</div></label>
      <input type="radio" id="plan-assisted" name="planning-mode" value="assisted" checked />
      <label for="plan-assisted" class="mode-card"><div class="mode-title">Assisted</div><div class="mode-desc">Run round-table; review + edit the synthesis before dispatch.</div></label>
      <input type="radio" id="plan-manual"   name="planning-mode" value="manual" />
      <label for="plan-manual" class="mode-card"><div class="mode-title">Manual</div><div class="mode-desc">Skip the round-table; write the brief yourself.</div></label>
    </div>

    <label class="field">Hiring mode</label>
    <div class="mode-grid">
      <input type="radio" id="hire-auto"   name="hire-mode" value="auto" />
      <label for="hire-auto" class="mode-card"><div class="mode-title">Auto</div><div class="mode-desc">Hire every recommended role automatically.</div></label>
      <input type="radio" id="hire-hybrid" name="hire-mode" value="hybrid" />
      <label for="hire-hybrid" class="mode-card"><div class="mode-title">Hybrid</div><div class="mode-desc">Hire safe defaults; ask before specialised roles.</div></label>
      <input type="radio" id="hire-manual" name="hire-mode" value="manual" checked />
      <label for="hire-manual" class="mode-card"><div class="mode-title">Manual</div><div class="mode-desc">You approve each hire from the marketplace.</div></label>
    </div>

    <div class="checkbox-row">
      <input id="run-discovery" type="checkbox" checked />
      <label for="run-discovery">Run discovery round-table immediately after create</label>
    </div>

    <div class="actions">
      <button type="submit" id="submit">Create project</button>
      <button type="button" class="secondary" id="cancel">Cancel</button>
      <span class="status" id="status"></span>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();
    const initialFolder = ${targetFolderJson};
    const prefill = ${initialJson};
    const folderEl = document.getElementById('folder');
    folderEl.value = initialFolder;

    // chip state — seeded from prefill in edit-mode
    const criteria = prefill && Array.isArray(prefill.successCriteria) ? [...prefill.successCriteria] : [];
    const constraints = prefill && Array.isArray(prefill.constraints) ? [...prefill.constraints] : [];

    // Apply scalar prefill values (name, goal, budget, modes) when the
    // webview is opened in edit-mode for an existing empty workspace.
    if (prefill) {
      if (prefill.name) document.getElementById('name').value = prefill.name;
      if (prefill.goal) document.getElementById('goal').value = prefill.goal;
      if (prefill.budgetHintUsd != null) document.getElementById('budget-amount').value = prefill.budgetHintUsd;
      if (prefill.budgetHintUnit) document.getElementById('budget-unit').value = prefill.budgetHintUnit;
      const planRadio = document.querySelector('input[name="planning-mode"][value="' + (prefill.planningMode || 'assisted') + '"]');
      if (planRadio) planRadio.checked = true;
      const hireRadio = document.querySelector('input[name="hire-mode"][value="' + (prefill.hireMode || 'manual') + '"]');
      if (hireRadio) hireRadio.checked = true;
    }

    function renderCriteria() {
      const el = document.getElementById('criteria-chips');
      el.innerHTML = '';
      criteria.forEach((item, i) => {
        const span = document.createElement('span');
        span.className = 'chip';
        span.textContent = item;
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'x'; x.textContent = '×';
        x.addEventListener('click', () => { criteria.splice(i, 1); renderCriteria(); });
        span.appendChild(x);
        el.appendChild(span);
      });
    }
    function renderConstraints() {
      const el = document.getElementById('constraints-chips');
      el.innerHTML = '';
      constraints.forEach((item, i) => {
        const span = document.createElement('span');
        span.className = 'chip';
        span.textContent = item;
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'x'; x.textContent = '×';
        x.addEventListener('click', () => { constraints.splice(i, 1); renderConstraints(); });
        span.appendChild(x);
        el.appendChild(span);
      });
    }
    function addCriterion() {
      const v = document.getElementById('criteria-draft').value.trim();
      if (!v) return;
      criteria.push(v);
      document.getElementById('criteria-draft').value = '';
      renderCriteria();
    }
    function addConstraint() {
      const v = document.getElementById('constraints-draft').value.trim();
      if (!v) return;
      constraints.push(v);
      document.getElementById('constraints-draft').value = '';
      renderConstraints();
    }
    // Surface prefilled chips immediately (edit-mode).
    renderCriteria();
    renderConstraints();

    document.getElementById('criteria-add').addEventListener('click', addCriterion);
    document.getElementById('criteria-draft').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCriterion(); }
    });
    document.getElementById('constraints-add').addEventListener('click', addConstraint);
    document.getElementById('constraints-draft').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addConstraint(); }
    });

    document.getElementById('pick-folder').addEventListener('click', () => {
      vscode.postMessage({ type: 'pickFolder', current: folderEl.value });
    });

    document.getElementById('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const amountRaw = document.getElementById('budget-amount').value;
      const unit = document.getElementById('budget-unit').value;
      const amount = amountRaw === '' ? null : Number(amountRaw);
      // For tokens, the input is in raw token count (we don't k-scale here).
      const budgetHintUsd = amount != null && !isNaN(amount) ? amount : null;

      const planningMode = document.querySelector('input[name="planning-mode"]:checked')?.value || 'assisted';
      const hireMode = document.querySelector('input[name="hire-mode"]:checked')?.value || 'manual';
      const runDiscovery = document.getElementById('run-discovery').checked;

      vscode.postMessage({
        type: 'submit',
        name: document.getElementById('name').value,
        goal: document.getElementById('goal').value,
        targetFolder: folderEl.value,
        successCriteria: criteria,
        constraints,
        budgetHintUsd,
        budgetHintUnit: unit,
        planningMode,
        hireMode,
        runDiscovery,
      });
    });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    // host → webview
    const statusEl = document.getElementById('status');
    const submitBtn = document.getElementById('submit');
    window.addEventListener('message', (e) => {
      const m = e.data; if (!m || !m.type) return;
      if (m.type === 'submitting') { submitBtn.disabled = true; statusEl.textContent = 'Creating…'; statusEl.className = 'status'; }
      else if (m.type === 'success') { statusEl.textContent = 'Created · ' + (m.workspaceId || ''); statusEl.className = 'status ok'; }
      else if (m.type === 'error')   { submitBtn.disabled = false; statusEl.textContent = 'Error: ' + m.error; statusEl.className = 'status error'; }
      else if (m.type === 'pickedFolder') { folderEl.value = m.path || ''; }
    });
  </script>
</body></html>`;
}
