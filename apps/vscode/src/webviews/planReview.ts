// 📝 Plan editor webview — opens when a brief dispatched in `assisted` mode
// pauses after Phase 1 (Plan). Shows the generated plan.md in an editable
// textarea alongside a model dropdown + Approve / Regenerate / Reject.
//
// Approve  → releases the PLAN_APPROVED gate → pipeline moves to Implement.
// Regenerate (with new model) → archives current plan.md → re-runs Phase 1
//              with the chosen model → refreshes this webview when done.
// Reject   → cancels the brief, marks outcome abandoned.

import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | undefined;
let currentBriefId: string | null = null;

/** Close the Plan editor tab if it's open (e.g. on consent-loss transition). */
export function closePlanReviewIfOpen(): boolean {
  if (!panel) return false;
  try { panel.dispose(); } catch {}
  panel = undefined;
  currentBriefId = null;
  return true;
}

export interface OpenPlanReviewArgs {
  briefId: string;
  briefBody: string;
  planBody: string;
  model: string;
  onDone?: () => void;
}

function base(): string {
  const port = vscode.workspace.getConfiguration('atrune').get<number>('serverPort', 4000);
  return `http://localhost:${port}`;
}

export function openPlanReview(args: OpenPlanReviewArgs): void {
  // Same-brief re-entry: refresh the existing tab. Different brief: dispose
  // + reopen (a stale tab shouldn't linger targeting a rejected brief).
  if (panel && currentBriefId === args.briefId) {
    panel.webview.postMessage({ type: 'refresh', planBody: args.planBody, model: args.model });
    panel.reveal(vscode.ViewColumn.Two);
    return;
  }
  if (panel) { try { panel.dispose(); } catch {} panel = undefined; }

  currentBriefId = args.briefId;
  panel = vscode.window.createWebviewPanel(
    'atrune.planReview',
    `Plan review · ${args.briefId.slice(-8)}`,
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = new vscode.ThemeIcon('output-view-icon');
  panel.webview.html = renderHtml(args);

  panel.onDidDispose(() => { panel = undefined; currentBriefId = null; });

  panel.webview.onDidReceiveMessage(async (m: any) => {
    if (m?.type === 'approve') {
      const r = await fetch(`${base()}/api/briefs/${args.briefId}/plan/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits: typeof m.edits === 'string' ? m.edits : undefined }),
      }).catch(() => null);
      if (!r?.ok) {
        vscode.window.showErrorMessage(`Plan approve failed: HTTP ${r?.status ?? '(unreachable)'}`);
        return;
      }
      vscode.window.showInformationMessage(`Plan approved — pipeline moving to Implement.`);
      args.onDone?.();
      panel?.dispose();
      return;
    }
    if (m?.type === 'regenerate') {
      const model = typeof m.model === 'string' ? m.model : args.model;
      const r = await fetch(`${base()}/api/briefs/${args.briefId}/plan/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, note: m.note ?? undefined }),
      }).catch(() => null);
      if (!r?.ok) {
        vscode.window.showErrorMessage(`Regenerate failed: HTTP ${r?.status ?? '(unreachable)'}`);
        return;
      }
      // Webview stays open. When Phase 1 completes again the SSE listener
      // will call openPlanReview() again with the new planBody — triggering
      // the same-brief refresh branch at the top.
      panel?.webview.postMessage({ type: 'regenerating', model });
      vscode.window.setStatusBarMessage(`Regenerating plan with ${model}…`, 4000);
      return;
    }
    if (m?.type === 'reject') {
      const confirm = await vscode.window.showWarningMessage(
        'Reject the plan? The brief will be cancelled — no code gets written.',
        { modal: true }, 'Reject brief',
      );
      if (confirm !== 'Reject brief') return;
      const r = await fetch(`${base()}/api/briefs/${args.briefId}/plan/reject`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: typeof m.note === 'string' ? m.note : undefined }),
      }).catch(() => null);
      if (!r?.ok) {
        vscode.window.showErrorMessage(`Reject failed: HTTP ${r?.status ?? '(unreachable)'}`);
        return;
      }
      vscode.window.showInformationMessage('Brief rejected.');
      args.onDone?.();
      panel?.dispose();
      return;
    }
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderHtml(args: OpenPlanReviewArgs): string {
  return /* html */`<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 12px 16px; }
  h1 { font-size: 15px; margin: 0 0 4px 0; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; }
  .brief { padding: 8px 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; margin-bottom: 12px; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
  .toolbar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); z-index: 2; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  .toolbar button { padding: 4px 12px; }
  .toolbar select { padding: 4px 6px; }
  #approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border); }
  #reject { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  #plan { width: 100%; min-height: 400px; padding: 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; box-sizing: border-box; resize: vertical; }
  #note { width: 100%; margin-top: 8px; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: inherit; box-sizing: border-box; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  #status { color: var(--vscode-descriptionForeground); margin-left: 8px; font-size: 11px; }
</style>
</head><body>
<h1>📝 Plan review</h1>
<div class="meta">Brief <code>${esc(args.briefId)}</code> · generated by <span class="badge" id="model-badge">${esc(args.model)}</span></div>

<details open>
  <summary>Original brief</summary>
  <div class="brief">${esc(args.briefBody)}</div>
</details>

<div class="toolbar">
  <button id="approve" title="Ship the current plan to Implement + Review">✓ Approve &amp; continue</button>

  <span style="margin-left:8px;">Regenerate with:</span>
  <select id="model">
    <option value="haiku">Haiku</option>
    <option value="sonnet">Sonnet</option>
    <option value="opus">Opus</option>
  </select>
  <button id="regen">↻ Regenerate</button>

  <span style="flex:1"></span>

  <button id="reject" title="Cancel the brief entirely — no code written">✗ Reject</button>
  <span id="status"></span>
</div>

<label class="hint" for="plan">Edit the plan below (approve saves the edits before Implement runs).</label>
<textarea id="plan" spellcheck="false">${esc(args.planBody)}</textarea>

<label class="hint" for="note" style="display:block; margin-top:10px;">Reviewer note (optional; attached to regenerate/reject).</label>
<textarea id="note" rows="2" placeholder="Why regenerate/reject?"></textarea>

<script>
  const vscode = acquireVsCodeApi();
  const modelSel = document.getElementById('model');
  modelSel.value = ${JSON.stringify(args.model)};

  document.getElementById('approve').addEventListener('click', () => {
    vscode.postMessage({ type: 'approve', edits: document.getElementById('plan').value });
  });
  document.getElementById('regen').addEventListener('click', () => {
    vscode.postMessage({
      type: 'regenerate',
      model: modelSel.value,
      note: document.getElementById('note').value || undefined,
    });
    document.getElementById('status').textContent = '↻ regenerating…';
  });
  document.getElementById('reject').addEventListener('click', () => {
    vscode.postMessage({ type: 'reject', note: document.getElementById('note').value || undefined });
  });

  // Same-brief re-entry from the extension (Regenerate finished, new plan.md written).
  window.addEventListener('message', (evt) => {
    if (evt.data?.type === 'refresh') {
      document.getElementById('plan').value = evt.data.planBody ?? '';
      document.getElementById('model-badge').textContent = evt.data.model ?? modelSel.value;
      modelSel.value = evt.data.model ?? modelSel.value;
      document.getElementById('status').textContent = '';
    } else if (evt.data?.type === 'regenerating') {
      document.getElementById('status').textContent = '↻ regenerating with ' + (evt.data.model ?? '') + '…';
    }
  });
</script>
</body></html>`;
}
