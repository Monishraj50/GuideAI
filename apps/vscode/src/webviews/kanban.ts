// 📋 Kanban webview — phase-card board for a dispatched brief.
//
// Opens automatically after a brief is dispatched. Shows the 5 pipeline
// phases (research / plan / implement / review / verify) as cards across
// 3 columns: Inactive / Active / Completed.
//
// In Auto mode the orchestrator releases phases automatically; cards just
// march left → right as work happens.
// In Manual mode the user drags a card from Inactive → Active to release
// that phase. The webview enforces forward-only movement (D3) and posts
// a `release` message to the extension, which calls the server.

import * as vscode from 'vscode';

const PHASES = ['research', 'plan', 'implement', 'review', 'verify'] as const;
type Phase = typeof PHASES[number];

interface GateState { phase: string; released: boolean }
interface BriefStatus { id: string; status: string }
interface KanbanState {
  briefId: string;
  workspaceId: string;
  mode: 'auto' | 'manual';
  gates: GateState[];
  briefStatus: string;
  phaseStatus: Record<Phase, 'inactive' | 'active' | 'completed' | 'failed'>;
}

let panel: vscode.WebviewPanel | undefined;
let pollTimer: NodeJS.Timeout | undefined;

const panels: Map<string, vscode.WebviewPanel> = new Map(); // briefId → panel

const SERVER = process.env.ATRUNE_SERVER ?? 'http://localhost:4000';

export async function openKanban(args: { workspaceId: string; briefId: string }) {
  const existing = panels.get(args.briefId);
  if (existing) { existing.reveal(vscode.ViewColumn.Two); return; }

  panel = vscode.window.createWebviewPanel(
    'atrune.kanban',
    `Atrune · ${args.briefId}`,
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panels.set(args.briefId, panel);
  panel.webview.html = renderHtml(args.briefId);

  const post = (msg: unknown) => panel?.webview.postMessage(msg);

  // Start polling.
  const tick = async () => {
    try {
      const state = await fetchState(args.workspaceId, args.briefId);
      post({ type: 'state', state });
    } catch {}
  };
  pollTimer = setInterval(tick, 1500);
  void tick();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'release': {
        const phase = String(msg.phase ?? '');
        if (!PHASES.includes(phase as Phase)) return;
        await fetch(`${SERVER}/api/briefs/${args.briefId}/phases/${phase}/release`, { method: 'POST' });
        void tick();
        return;
      }
      case 'reopen': {
        const phase = String(msg.phase ?? '');
        if (!PHASES.includes(phase as Phase)) return;
        const r = await fetch(`${SERVER}/api/briefs/${args.briefId}/phases/${phase}/reopen`, { method: 'POST' });
        const j = await r.json() as { note?: string };
        if (j?.note) {
          vscode.window.showInformationMessage(`Reopened ${phase} — ${j.note}`);
        }
        void tick();
        return;
      }
      case 'releaseAll': {
        await fetch(`${SERVER}/api/briefs/${args.briefId}/release-all`, { method: 'POST' });
        void tick();
        return;
      }
      case 'close': {
        panel?.dispose();
        return;
      }
    }
  });

  panel.onDidDispose(() => {
    panels.delete(args.briefId);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    panel = undefined;
  });
}

async function fetchState(workspaceId: string, briefId: string): Promise<KanbanState> {
  // 1. Gate state — released vs. not.
  const gatesRes = await fetch(`${SERVER}/api/briefs/${briefId}/gates`);
  const gatesJson = await gatesRes.json() as { briefId: string; mode: 'auto' | 'manual'; gates: GateState[] };

  // 2. Brief status to know overall progress.
  const planRes = await fetch(`${SERVER}/api/workspaces/${workspaceId}/plan`);
  const planJson = await planRes.json() as { briefs?: BriefStatus[] };
  const brief = planJson.briefs?.find((b) => b.id === briefId);

  // 3. Phase artifacts to detect completion. Read the briefs/<id> dir
  //    via events stream. For simplicity, derive phase status from gates:
  //    not released → inactive
  //    released but not done → active
  //    Completion is reported via plan endpoint's phase chunks (kept simple
  //    here: rely on brief status === 'done' to mark all as completed).
  const phaseStatus: Record<Phase, 'inactive' | 'active' | 'completed' | 'failed'> = {
    research: 'inactive', plan: 'inactive', implement: 'inactive', review: 'inactive', verify: 'inactive',
  };
  const releasedSet = new Set(gatesJson.gates.filter((g) => g.released).map((g) => g.phase));

  // Naive: if a later phase is released, all earlier ones are completed.
  let furthest = -1;
  for (let i = PHASES.length - 1; i >= 0; i--) {
    if (releasedSet.has(PHASES[i]!)) { furthest = i; break; }
  }
  for (let i = 0; i < PHASES.length; i++) {
    const p = PHASES[i]!;
    if (i < furthest) phaseStatus[p] = 'completed';
    else if (i === furthest) phaseStatus[p] = 'active';
    else phaseStatus[p] = 'inactive';
  }
  if (brief?.status === 'done') {
    for (const p of PHASES) phaseStatus[p] = 'completed';
  }

  return {
    briefId, workspaceId, mode: gatesJson.mode,
    gates: gatesJson.gates, briefStatus: brief?.status ?? 'unknown', phaseStatus,
  };
}

function renderHtml(briefId: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://localhost:4000;" />
<title>Atrune · Kanban</title>
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
    --amber: #f5c451;
    --ok:  #5cf2c0;
    --inactive: #6b7280;
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
  body { padding: 20px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  .brief-id { font-family: ui-monospace, monospace; font-size: 12px; color: var(--dim); }
  .mode-badge {
    display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .mode-badge.auto   { background: rgba(20, 184, 166, 0.15); color: var(--teal); border: 1px solid var(--teal); }
  .mode-badge.manual { background: rgba(245, 196, 81, 0.15); color: var(--amber); border: 1px solid var(--amber); }
  .status-text { font-size: 12px; color: var(--dim); }
  .spacer { flex: 1; }
  button {
    padding: 5px 11px; border-radius: 4px; border: 1px solid var(--line);
    background: transparent; color: var(--ink); font: inherit; font-size: 12px; cursor: pointer;
  }
  button:hover { border-color: var(--teal); }
  button.primary { background: var(--accent); color: var(--accent-fg); border: 0; }

  .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .col {
    background: var(--soft); border: 1px solid var(--line); border-radius: 6px;
    padding: 12px; min-height: 360px;
  }
  .col h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--dim); margin: 0 0 10px; font-weight: 600;
    display: flex; justify-content: space-between; align-items: center;
  }
  .col .count {
    background: rgba(125, 125, 125, 0.15); padding: 1px 8px; border-radius: 999px;
    font-size: 10px; font-weight: 700; color: var(--ink);
  }
  .col.drop-target { outline: 2px dashed var(--teal); outline-offset: -2px; }

  .card {
    background: var(--bg); border: 1px solid var(--line); border-radius: 5px;
    padding: 10px 12px; margin-bottom: 8px; cursor: grab;
    transition: border-color 0.2s, transform 0.15s;
  }
  .card:hover { border-color: var(--teal); }
  .card.dragging { opacity: 0.4; cursor: grabbing; }
  .card.completed { border-color: rgba(92, 242, 192, 0.3); }
  .card.active { border-color: var(--amber); box-shadow: 0 0 0 1px var(--amber); }
  .card .phase-name {
    font-size: 13px; font-weight: 600; text-transform: capitalize; margin-bottom: 2px;
  }
  .card .phase-meta { font-size: 11px; color: var(--dim); }
  .card.completed .phase-meta { color: var(--ok); }

  .empty-col { font-size: 11px; color: var(--dim); padding: 24px 12px; text-align: center; opacity: 0.7; }

  .actions-row { display: flex; gap: 8px; margin-top: 16px; }
</style>
</head>
<body>
  <header>
    <h1>📋 Kanban</h1>
    <span class="brief-id">${briefId}</span>
    <span class="mode-badge" id="mode-badge">…</span>
    <span class="spacer"></span>
    <span class="status-text" id="status-text">connecting…</span>
    <button id="release-all-btn" style="display:none">⏩ Release all</button>
    <button id="close-btn">Close</button>
  </header>

  <div class="board">
    <div class="col" id="col-inactive">
      <h2>Inactive <span class="count" id="count-inactive">0</span></h2>
      <div class="cards" id="cards-inactive"></div>
    </div>
    <div class="col" id="col-active">
      <h2>Active <span class="count" id="count-active">0</span></h2>
      <div class="cards" id="cards-active"></div>
    </div>
    <div class="col" id="col-completed">
      <h2>Completed <span class="count" id="count-completed">0</span></h2>
      <div class="cards" id="cards-completed"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const PHASES = ${JSON.stringify(PHASES)};
    let lastState = null;

    function $(id) { return document.getElementById(id); }

    function render(state) {
      lastState = state;
      const badge = $('mode-badge');
      badge.textContent = state.mode;
      badge.className = 'mode-badge ' + state.mode;

      $('status-text').textContent = state.briefStatus === 'done'
        ? '✅ brief complete'
        : (state.mode === 'manual' ? '🖐 manual — drag a phase to release' : '▶ auto-running');

      $('release-all-btn').style.display = state.mode === 'manual' && state.briefStatus !== 'done' ? '' : 'none';

      // Bucket phases.
      const buckets = { inactive: [], active: [], completed: [] };
      for (const p of PHASES) {
        const s = state.phaseStatus[p];
        if (s === 'completed') buckets.completed.push(p);
        else if (s === 'active') buckets.active.push(p);
        else buckets.inactive.push(p);
      }
      for (const k of Object.keys(buckets)) {
        const wrap = $('cards-' + k);
        const count = $('count-' + k);
        wrap.innerHTML = '';
        count.textContent = String(buckets[k].length);
        if (buckets[k].length === 0) {
          wrap.innerHTML = '<div class="empty-col">' + (k === 'inactive' ? 'nothing waiting' : k === 'active' ? 'nothing running' : 'nothing done yet') + '</div>';
          continue;
        }
        for (const p of buckets[k]) {
          const card = document.createElement('div');
          card.className = 'card ' + k;
          card.draggable = k === 'inactive' || k === 'completed'; // forward-only EXCEPT completed → active (verify-and-repair)
          card.dataset.phase = p;
          card.dataset.bucket = k;
          const idx = PHASES.indexOf(p);
          const order = ['1', '2', '3', '4', '5'][idx];
          card.innerHTML = '<div class="phase-name">' + order + '. ' + p + '</div>' +
                           '<div class="phase-meta">' + (k === 'completed' ? '✓ done · drag back to re-verify' : (k === 'active' ? '⏳ running' : '⏸ waiting')) + '</div>';

          card.addEventListener('dragstart', (e) => {
            card.classList.add('dragging');
            e.dataTransfer.setData('text/phase', p);
            e.dataTransfer.setData('text/bucket', k);
          });
          card.addEventListener('dragend', () => card.classList.remove('dragging'));

          wrap.appendChild(card);
        }
      }
    }

    // Drop target = Active column. Only accepts cards from Inactive.
    const activeCol = $('col-active');
    activeCol.addEventListener('dragover', (e) => {
      e.preventDefault();
      activeCol.classList.add('drop-target');
    });
    activeCol.addEventListener('dragleave', () => activeCol.classList.remove('drop-target'));
    activeCol.addEventListener('drop', (e) => {
      e.preventDefault();
      activeCol.classList.remove('drop-target');
      const phase = e.dataTransfer.getData('text/phase');
      const bucket = e.dataTransfer.getData('text/bucket');
      if (!phase) return;
      if (bucket === 'inactive') {
        vscode.postMessage({ type: 'release', phase });
      } else if (bucket === 'completed') {
        vscode.postMessage({ type: 'reopen', phase });
      }
    });

    $('release-all-btn').addEventListener('click', () => vscode.postMessage({ type: 'releaseAll' }));
    $('close-btn').addEventListener('click', () => vscode.postMessage({ type: 'close' }));

    window.addEventListener('message', (e) => {
      const m = e.data; if (!m || m.type !== 'state' || !m.state) return;
      render(m.state);
    });
  </script>
</body></html>`;
}
