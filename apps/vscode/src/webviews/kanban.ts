// 📋 Kanban webview — phase-card board for a dispatched brief.
//
// Opens automatically after a brief is dispatched. Shows the 3 pipeline
// phases (plan / implement / review) as cards across 3 columns: Inactive /
// Active / Completed. Plan spec column labels: Backlog · Plan · Implement ·
// Review · Done — those match the natural cardinal flow of Inactive plan →
// Active plan → completed plan → active implement → etc.
//
// In Auto mode the orchestrator releases phases automatically; cards just
// march left → right as work happens.
// In Manual mode the user drags a card from Inactive → Active to release
// that phase. The webview enforces forward-only movement (D3) and posts
// a `release` message to the extension, which calls the server.

import * as vscode from 'vscode';

// S3: 3-phase pipeline. Research is folded into plan; verify is folded into
// review — the merged prompts do both beats in one call.
const PHASES = ['plan', 'implement', 'review'] as const;
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

/** Close the Kanban tab if it's open. Called on consent loss so the panel
 *  doesn't keep polling for the just-deleted project. */
export function closeKanbanIfOpen(): boolean {
  if (!panel) return false;
  try { panel.dispose(); } catch {}
  panel = undefined;
  return true;
}
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
        // Auto-open the live chat tail so the user immediately sees the
        // agent at work. No-op if the panel is already open for this brief.
        vscode.commands.executeCommand('atrune.openLiveSessionTail', {
          workspaceId: args.workspaceId, briefId: args.briefId,
        });
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
      case 'retry': {
        // Hits /resume which un-blocks failed items + re-runs the pipeline.
        // Same path is used by "Resume brief pipeline" Quick Pick — one entry
        // point covers both crash recovery and explicit retry.
        await fetch(`${SERVER}/api/briefs/${args.briefId}/resume`, { method: 'POST' });
        vscode.commands.executeCommand('atrune.openLiveSessionTail', {
          workspaceId: args.workspaceId, briefId: args.briefId,
        });
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

  // 2. Brief detail — chunks include per-phase status events (started/completed/failed).
  const briefRes = await fetch(`${SERVER}/api/workspaces/${workspaceId}/briefs/${briefId}`);
  const briefJson = await briefRes.json() as {
    brief?: { id: string; status: string };
    chunks?: Array<{ kind: string; phase?: string; status?: string; ts?: number }>;
  };
  const brief = briefJson.brief ?? null;
  const chunks = briefJson.chunks ?? [];

  // 3. Compute per-phase status from the LAST phase event we saw for that
  //    phase. Order: failed > completed > started > inactive. Combined with
  //    gate state — a phase that has no event but its gate is released is
  //    "active" (about to run).
  const phaseStatus: Record<Phase, 'inactive' | 'active' | 'completed' | 'failed'> = {
    plan: 'inactive', implement: 'inactive', review: 'inactive',
  };
  const releasedSet = new Set(gatesJson.gates.filter((g) => g.released).map((g) => g.phase));

  // Walk chunks oldest → newest so the latest event wins.
  for (const c of chunks) {
    if (c.kind !== 'phase' || !c.phase || !PHASES.includes(c.phase as Phase)) continue;
    const p = c.phase as Phase;
    if (c.status === 'started') phaseStatus[p] = 'active';
    else if (c.status === 'completed') phaseStatus[p] = 'completed';
    else if (c.status === 'failed') phaseStatus[p] = 'failed';
    else if (c.status === 'paused') phaseStatus[p] = 'active'; // budget pause — still in-flight semantically
  }
  // Phases whose gate is released but no event yet → active.
  for (const p of PHASES) {
    if (phaseStatus[p] === 'inactive' && releasedSet.has(p)) phaseStatus[p] = 'active';
  }
  // Brief-level "done" → every phase is done. Brief "failed" doesn't blanket-
  // override — keep the per-phase signal so the failed phase is highlighted.
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
    --err: var(--vscode-errorForeground, #f48771);
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

  .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
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
  .card.active {
    border-color: var(--amber); box-shadow: 0 0 0 1px var(--amber);
    cursor: not-allowed;  /* locked while running */
  }
  .card.active:hover { border-color: var(--amber); }
  .card.failed {
    border-color: rgba(244, 135, 113, 0.5);
    background: rgba(244, 135, 113, 0.04);
  }
  /* Inactive cards whose prereqs aren't done — visually dimmed + not grabbable */
  .card.waiting {
    opacity: 0.45; cursor: not-allowed;
    border-style: dashed;
  }
  .card.waiting:hover { border-color: var(--line); }
  .card .phase-name {
    font-size: 13px; font-weight: 600; text-transform: capitalize; margin-bottom: 2px;
  }
  .card .phase-meta { font-size: 11px; color: var(--dim); }
  .card.completed .phase-meta { color: var(--ok); }
  .card.failed .phase-meta { color: var(--err); }

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
    <div class="col" id="col-failed">
      <h2>Failed <span class="count" id="count-failed">0</span></h2>
      <div class="cards" id="cards-failed"></div>
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

      // Bucket phases into 4 columns. Failure is per-phase: a single failed
      // phase doesn't blanket the others. Active cards are NEVER draggable —
      // you can't yank work out from under a running agent.
      const buckets = { inactive: [], active: [], completed: [], failed: [] };
      for (const p of PHASES) {
        const s = state.phaseStatus[p];
        if (s === 'failed') buckets.failed.push(p);
        else if (s === 'completed') buckets.completed.push(p);
        else if (s === 'active') buckets.active.push(p);
        else buckets.inactive.push(p);
      }

      // Sequential dependency: a phase is "releasable" only when every
      // earlier phase in PHASE_ORDER is completed. Non-releasable Inactive
      // cards stay visually waiting and are not draggable.
      const releasable = {};
      let blocker = null;
      for (const p of PHASES) {
        const s = state.phaseStatus[p];
        if (s === 'completed') { releasable[p] = false; continue; }
        if (blocker === null) {
          // first non-completed phase: it can run now
          releasable[p] = (s !== 'active'); // active = already running, no need to release again
          blocker = p;
        } else {
          // later phases wait for the blocker
          releasable[p] = false;
        }
      }
      const EMPTY_HINT = {
        inactive: 'nothing waiting',
        active: 'nothing running',
        completed: 'nothing done yet',
        failed: 'no failures 🎉',
      };
      for (const k of Object.keys(buckets)) {
        const wrap = $('cards-' + k);
        const count = $('count-' + k);
        wrap.innerHTML = '';
        count.textContent = String(buckets[k].length);
        if (buckets[k].length === 0) {
          wrap.innerHTML = '<div class="empty-col">' + EMPTY_HINT[k] + '</div>';
          continue;
        }
        for (const p of buckets[k]) {
          const card = document.createElement('div');
          const idx = PHASES.indexOf(p);
          const order = ['1', '2', '3', '4', '5'][idx];

          // Determine draggability + meta text. Phase ordering: a card is
          // releasable from Inactive ONLY when every prior phase is completed.
          // Active is locked. Completed/Failed are always draggable (reopen).
          let isDraggable = false;
          let meta = '';
          if (k === 'active') {
            meta = '⏳ running · locked while in flight';
          } else if (k === 'completed') {
            isDraggable = true;
            meta = '✓ done · drag back to Active to re-verify';
          } else if (k === 'failed') {
            isDraggable = true;
            meta = '🛑 failed · fixer agent diagnosis in chat · drag to Active to retry';
          } else {
            // inactive — only releasable if dependencies are met
            if (releasable[p]) {
              isDraggable = true;
              meta = '⏸ ready · drag to Active to release';
            } else {
              const prevPhase = PHASES[idx - 1];
              meta = '🔒 waiting for ' + (prevPhase || 'prereqs') + ' to complete';
            }
          }

          card.className = 'card ' + k + (!isDraggable && k === 'inactive' ? ' waiting' : '');
          card.draggable = isDraggable;
          card.dataset.phase = p;
          card.dataset.bucket = k;
          card.innerHTML = '<div class="phase-name">' + order + '. ' + p + '</div>' +
                           '<div class="phase-meta">' + meta + '</div>';

          if (card.draggable) {
            card.addEventListener('dragstart', (e) => {
              card.classList.add('dragging');
              e.dataTransfer.setData('text/phase', p);
              e.dataTransfer.setData('text/bucket', k);
            });
            card.addEventListener('dragend', () => card.classList.remove('dragging'));
          }

          wrap.appendChild(card);
        }
      }
    }

    // Drop target = Active column. Accepts:
    //   Inactive  → release (start the phase)
    //   Completed → reopen  (verify-and-repair)
    //   Failed    → reopen  (retry — same path, agent rechecks + fixes)
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
      if (!phase || !lastState) return;
      // Server-side guard against dependency violations: even if a card
      // somehow ends up here, only allow release when phaseStatus says ok.
      const phaseStatus = lastState.phaseStatus[phase];
      if (bucket === 'inactive') {
        // Ensure all prior phases are completed.
        const idx = PHASES.indexOf(phase);
        for (let i = 0; i < idx; i++) {
          if (lastState.phaseStatus[PHASES[i]] !== 'completed') return;
        }
        if (phaseStatus !== 'inactive') return;
        vscode.postMessage({ type: 'release', phase });
      } else if (bucket === 'failed') {
        // Retry — un-blocks failed work items + restarts pipeline. The
        // orchestrator's runPipeline skips phases whose artifact is already
        // on disk so completed earlier phases aren't redone.
        vscode.postMessage({ type: 'retry', phase });
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
