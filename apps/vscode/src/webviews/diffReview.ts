// 🩹 Diff review webview — per-task hunk-level accept/reject.
//
// Opens when a completed work_item has a non-empty diff vs its baseGitRef.
// The user toggles which hunks land on disk; rejected hunks are reverted +
// a follow-up review-phase work_item is created so the work isn't lost.

import * as vscode from 'vscode';
import { AtruneApi } from '../api';

interface Hunk {
  id: string;
  file: string;
  header: string;
  body: string;
  binary: boolean;
  addedLines: number;
  removedLines: number;
}

interface HunkFile {
  file: string;
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
  binary: boolean;
}

let panel: vscode.WebviewPanel | undefined;

/** Close the diff-review tab if it's open. Called on consent loss so a
 *  half-selected hunk approval doesn't apply against a missing baseGitRef. */
export function closeDiffReviewIfOpen(): boolean {
  if (!panel) return false;
  try { panel.dispose(); } catch {}
  panel = undefined;
  return true;
}

export async function openDiffReview(args: {
  api: AtruneApi;
  workItemId: string;
  taskTitle: string;
  onApplied?: () => void;
}) {
  if (panel) { panel.reveal(vscode.ViewColumn.Two); return; }
  const diff = await args.api.getWorkItemDiff(args.workItemId);
  if (!diff || diff.files.length === 0) {
    vscode.window.showInformationMessage(`No diff to review for "${args.taskTitle}"${diff?.reason ? ` — ${diff.reason}` : ''}.`);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'atrune.diffReview',
    `Diff review · ${args.taskTitle}`,
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = new vscode.ThemeIcon('diff');
  panel.webview.html = renderHtml(args.workItemId, args.taskTitle, diff.files);

  panel.onDidDispose(() => { panel = undefined; });

  panel.webview.onDidReceiveMessage(async (m: any) => {
    if (m?.type === 'apply') {
      const r = await args.api.applyWorkItemDiff({
        workItemId: args.workItemId,
        acceptedHunkIds: Array.isArray(m.acceptedHunkIds) ? m.acceptedHunkIds : [],
        note: typeof m.note === 'string' ? m.note : undefined,
      });
      if (!r) {
        vscode.window.showErrorMessage('Atrune · diff apply failed.');
        return;
      }
      const parts: string[] = [];
      parts.push(`applied ${r.applied.length}`);
      parts.push(`reverted ${r.reverted.length}`);
      if (r.failed.length) parts.push(`failed ${r.failed.length}`);
      if (r.followupWorkItemId) parts.push(`follow-up ${r.followupWorkItemId.slice(0, 8)}…`);
      const label = `Atrune · diff review · ${r.outcome} · ${parts.join(' · ')}`;
      if (r.failed.length) vscode.window.showWarningMessage(label);
      else vscode.window.showInformationMessage(label);
      args.onApplied?.();
      panel?.dispose();
    }
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderHunk(h: Hunk): string {
  if (h.binary) {
    return `<pre class="hunk binary">${esc(h.body || '(binary file)')}</pre>`;
  }
  const lines = h.body.split('\n').map((l) => {
    const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add'
      : l.startsWith('-') && !l.startsWith('---') ? 'del'
      : 'ctx';
    return `<span class="${cls}">${esc(l)}</span>`;
  });
  return `<pre class="hunk">${lines.join('\n')}</pre>`;
}

function renderHtml(workItemId: string, taskTitle: string, files: HunkFile[]): string {
  const totalHunks = files.reduce((s, f) => s + f.hunks.length, 0);
  const filesHtml = files.map((f) => {
    const hunks = f.hunks.map((h) => `
      <div class="hunkRow">
        <label>
          <input type="checkbox" class="hunkCheck" data-hunk-id="${esc(h.id)}" checked />
          <span class="hunkHeader">${esc(h.header)}</span>
          <span class="hunkStat">+${h.addedLines} -${h.removedLines}</span>
        </label>
        ${renderHunk(h)}
      </div>`).join('');
    return `
      <section class="file">
        <header>
          <h3>${esc(f.file)}</h3>
          <span class="hunkStat">${f.hunks.length} hunk${f.hunks.length === 1 ? '' : 's'}${f.binary ? ' · binary' : ''}</span>
        </header>
        ${hunks}
      </section>`;
  }).join('');

  return /* html */`<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 12px 16px; }
  h1 { font-size: 15px; margin: 0 0 4px 0; }
  .toolbar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); z-index: 2; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .toolbar button { padding: 4px 10px; }
  .file { margin: 12px 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
  .file > header { display: flex; justify-content: space-between; padding: 6px 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  .file h3 { margin: 0; font-size: 13px; font-family: var(--vscode-editor-font-family); }
  .hunkRow { padding: 6px 8px; }
  .hunkRow label { display: flex; gap: 8px; align-items: center; cursor: pointer; margin-bottom: 4px; }
  .hunkHeader { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); flex: 1; }
  .hunkStat { color: var(--vscode-descriptionForeground); font-size: 11px; }
  pre.hunk { font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 4px 0 0 24px; padding: 6px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; overflow-x: auto; white-space: pre; }
  pre.hunk span { display: block; padding: 0 4px; }
  pre.hunk .add { background: rgba(0, 200, 0, 0.10); }
  pre.hunk .del { background: rgba(255, 0, 0, 0.10); }
  pre.hunk .ctx { color: var(--vscode-descriptionForeground); }
  #summary { color: var(--vscode-descriptionForeground); }
  #note { width: 100%; margin-top: 8px; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: inherit; }
</style>
</head><body>
<h1>Diff review · ${esc(taskTitle)}</h1>
<div id="summary">${totalHunks} hunks across ${files.length} file${files.length === 1 ? '' : 's'} · <span id="acceptedCount">${totalHunks}</span> accepted</div>
<div class="toolbar">
  <button id="acceptAll">✓ Accept all</button>
  <button id="rejectAll">✗ Reject all</button>
  <button id="apply">Apply selection</button>
  <span style="flex:1"></span>
  <span class="hunkStat">Rejected hunks spawn a follow-up work item.</span>
</div>
<div>${filesHtml}</div>
<label class="hunkStat" style="display:block; margin-top:12px;">Reviewer note (optional; attached to the follow-up task):
  <textarea id="note" rows="2" placeholder="Why were these hunks rejected?"></textarea>
</label>
<script>
  const vscode = acquireVsCodeApi();
  const boxes = () => Array.from(document.querySelectorAll('.hunkCheck'));
  function updateSummary() {
    const total = boxes().length;
    const accepted = boxes().filter((b) => b.checked).length;
    document.getElementById('acceptedCount').textContent = String(accepted);
    document.getElementById('summary').innerHTML = total + ' hunks across ${files.length} file${files.length === 1 ? '' : 's'} · <span id="acceptedCount">' + accepted + '</span> accepted';
  }
  document.getElementById('acceptAll').addEventListener('click', () => { boxes().forEach((b) => b.checked = true); updateSummary(); });
  document.getElementById('rejectAll').addEventListener('click', () => { boxes().forEach((b) => b.checked = false); updateSummary(); });
  document.addEventListener('change', (e) => { if (e.target && e.target.classList && e.target.classList.contains('hunkCheck')) updateSummary(); });
  document.getElementById('apply').addEventListener('click', () => {
    const acceptedHunkIds = boxes().filter((b) => b.checked).map((b) => b.dataset.hunkId);
    const note = (document.getElementById('note').value || '').trim();
    vscode.postMessage({ type: 'apply', acceptedHunkIds, note });
  });
</script>
</body></html>`;
}
