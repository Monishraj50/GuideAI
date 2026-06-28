// Live chat tab for a brief's Claude session.
//
// The orchestrator runs `claude --session-id <uuid> ...` headlessly. Claude
// writes each user/assistant/tool turn as a line into
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// We watch that file, parse each new line, and post it to a VS Code Webview
// Panel that renders bubbles like Claude Code's chat. The same panel is
// reused across phases of the same brief (one Claude session per brief →
// all task work appears in one rolling chat).
//
// We do NOT push into Claude Code's own sidebar chat (no public API). The
// chat shape is identical (user / assistant / tool_use / tool_result) so the
// visual is the same — just hosted by Atrune.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AtruneApi } from './api';

// keyed by session UUID — one panel per Claude session, NOT per brief.
// Different roles within a brief have different sessions and each opens its
// own tab.
const panels = new Map<string, vscode.WebviewPanel>();
const streamers = new Map<string, SessionStreamer>();

export async function openLiveSessionTail(api: AtruneApi, args: {
  workspaceId: string;
  briefId?: string;   // optional: if no taskId, open the most-recent task's session for the brief
  taskId?: string;    // preferred: opens THIS work item's session
}): Promise<void> {
  // Resolve the (sessionId, label) for the requested context.
  // Sessions are per-(feature_tag, role) → stamped onto work_items.
  const allItems = await api.listWorkItems(args.workspaceId);
  let sessionId: string | null = null;
  let label = '';
  let subtitle = '';
  if (args.taskId) {
    const item = allItems.find((w) => w.id === args.taskId);
    sessionId = item?.claudeSessionId ?? null;
    label = item?.assignedRole ?? args.taskId.slice(-6);
    subtitle = `${item?.phase ?? ''} · ${item?.assignedRole ?? ''}`;
  } else if (args.briefId) {
    // Pick the most-recently-updated work item for this brief that has a session.
    const briefItems = allItems
      .filter((w) => w.briefId === args.briefId && w.claudeSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const item = briefItems[0];
    sessionId = item?.claudeSessionId ?? null;
    label = item?.assignedRole ?? args.briefId.slice(-6);
    subtitle = `${item?.phase ?? ''} · ${item?.assignedRole ?? ''}`;
  }
  if (!sessionId) {
    vscode.window.showInformationMessage(
      'No Claude session yet for this task. Drag a phase card to Active to start the agent.',
    );
    return;
  }

  const existing = panels.get(sessionId);
  if (existing) { existing.reveal(vscode.ViewColumn.Active, false); return; }

  const panel = vscode.window.createWebviewPanel(
    'atrune.liveChat',
    `chat · ${label}`,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = new vscode.ThemeIcon('comment-discussion');
  panel.webview.html = renderHtml(subtitle || label, sessionId);

  const streamer = new SessionStreamer(sessionId, (chunk) => {
    panel.webview.postMessage({ type: 'chunk', chunk });
  }, (status) => {
    panel.webview.postMessage({ type: 'status', text: status });
  });
  streamers.set(sessionId, streamer);
  streamer.start();

  panel.onDidDispose(() => {
    streamer.stop();
    streamers.delete(sessionId!);
    panels.delete(sessionId!);
  });
  panels.set(sessionId, panel);
}

interface ChatChunk {
  role: 'user' | 'assistant' | 'tool' | 'tool-result' | 'system';
  text?: string;
  toolName?: string;
  toolArgs?: string;
}

class SessionStreamer {
  private offset = 0;
  private watcher: fs.FSWatcher | null = null;
  private existencePoll: NodeJS.Timeout | null = null;
  private file: string | null = null;
  private stopped = false;

  constructor(
    private sessionId: string,
    private onChunk: (c: ChatChunk) => void,
    private onStatus: (s: string) => void,
  ) {}

  start(): void {
    this.file = findSessionJsonl(this.sessionId);
    if (this.file) { this.onStatus('● live · streaming'); this.attach(); return; }
    this.onStatus('⏳ waiting for agent to write first turn…');
    let waited = 0;
    this.existencePoll = setInterval(() => {
      if (this.stopped) return;
      waited += 500;
      const found = findSessionJsonl(this.sessionId);
      if (found) {
        clearInterval(this.existencePoll!); this.existencePoll = null;
        this.file = found;
        this.onStatus('● live · streaming');
        this.attach();
      } else if (waited >= 60_000) {
        clearInterval(this.existencePoll!); this.existencePoll = null;
        this.onStatus('⚠ timed out — orchestrator did not spawn Claude yet');
      }
    }, 500);
  }

  private attach(): void {
    if (!this.file) return;
    this.consume();
    try {
      this.watcher = fs.watch(this.file, () => this.consume());
    } catch (err: any) {
      this.onStatus(`watcher failed: ${err?.message ?? err}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.existencePoll) { clearInterval(this.existencePoll); this.existencePoll = null; }
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
  }

  private consume(): void {
    if (!this.file) return;
    try {
      const stat = fs.statSync(this.file);
      if (stat.size <= this.offset) { if (stat.size < this.offset) this.offset = 0; return; }
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(stat.size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        this.renderLine(line);
      }
    } catch {}
  }

  private renderLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    const t = obj?.type;
    if (t === 'user') {
      const content = obj.message?.content;
      if (typeof content === 'string') {
        this.onChunk({ role: 'user', text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'tool_result') {
            const raw = typeof part.content === 'string' ? part.content
              : Array.isArray(part.content) ? part.content.map((p: any) => p?.text ?? '').join('') : '';
            this.onChunk({ role: 'tool-result', text: truncate(raw, 4000) });
          }
        }
      }
      return;
    }
    if (t === 'assistant') {
      const content = obj.message?.content;
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part?.type === 'text') {
          const txt = String(part.text ?? '').trim();
          if (txt) this.onChunk({ role: 'assistant', text: txt });
        } else if (part?.type === 'tool_use') {
          this.onChunk({
            role: 'tool',
            toolName: part.name ?? '?',
            toolArgs: summarizeToolArgs(part.name, part.input),
          });
        }
      }
    }
  }
}

function summarizeToolArgs(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Read': case 'Write': case 'Edit': return String(input.file_path ?? '');
    case 'Bash':       return truncate(String(input.command ?? ''), 140);
    case 'Glob':       return String(input.pattern ?? '');
    case 'Grep':       return String(input.pattern ?? '');
    case 'WebFetch':   return String(input.url ?? '');
    case 'WebSearch':  return truncate(String(input.query ?? ''), 100);
    default: {
      const keys = Object.keys(input).slice(0, 3);
      return keys.map((k) => `${k}=${truncate(String(input[k] ?? ''), 30)}`).join(' ');
    }
  }
}

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function findSessionJsonl(sessionId: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const f = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function renderHtml(briefId: string, sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --userBg: var(--vscode-list-hoverBackground);
    --aiBg: var(--vscode-editor-inactiveSelectionBackground);
    --toolBg: var(--vscode-textBlockQuote-background);
    --accent: var(--vscode-textLink-foreground);
  }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .header { position: sticky; top: 0; z-index: 1; padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--bg); display: flex; align-items: center; gap: 12px; }
  .header .title { font-weight: 600; }
  .header .sub { color: var(--muted); font-size: 11px; font-family: var(--vscode-editor-font-family); }
  .status { margin-left: auto; color: var(--muted); font-size: 12px; }
  .chat { padding: 16px; max-width: 920px; margin: 0 auto; }
  .turn { margin-bottom: 18px; }
  .role { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600;
    color: var(--muted); margin-bottom: 6px; }
  .role .dot { width: 8px; height: 8px; border-radius: 50%; }
  .turn.user .role .dot { background: #4ec9b0; }
  .turn.assistant .role .dot { background: #569cd6; }
  .turn.tool .role .dot { background: #dcdcaa; }
  .turn.tool-result .role .dot { background: var(--muted); }
  .bubble { padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border);
    white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; }
  .turn.user .bubble { background: var(--userBg); }
  .turn.assistant .bubble { background: var(--aiBg); }
  .turn.tool .bubble { background: var(--toolBg); font-family: var(--vscode-editor-font-family);
    font-size: 12.5px; padding: 8px 12px; }
  .turn.tool .name { color: var(--accent); font-weight: 600; }
  .turn.tool .args { color: var(--muted); margin-left: 8px; }
  .turn.tool-result .bubble { background: transparent; border-style: dashed; color: var(--muted);
    font-family: var(--vscode-editor-font-family); font-size: 12px;
    max-height: 200px; overflow: auto; }
  .system { color: var(--muted); font-style: italic; padding: 8px 16px;
    border-left: 2px solid var(--border); margin: 12px 0; }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }
</style></head>
<body>
  <div class="header">
    <div>
      <div class="title">Live chat</div>
      <div class="sub">brief ${briefId} · session ${sessionId.slice(0, 8)}…</div>
    </div>
    <div class="status" id="status">⏳ connecting…</div>
  </div>
  <div class="chat" id="chat">
    <div class="empty" id="empty">waiting for the agent to write the first turn…</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const chat = document.getElementById('chat');
    const empty = document.getElementById('empty');
    const status = document.getElementById('status');

    function esc(s) {
      return String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    }

    function append(chunk) {
      if (empty) { empty.remove(); }
      const turn = document.createElement('div');
      turn.className = 'turn ' + chunk.role;
      const role = document.createElement('div');
      role.className = 'role';
      const dot = document.createElement('span'); dot.className = 'dot'; role.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = ({
        'user': 'You', 'assistant': 'Claude', 'tool': 'tool call', 'tool-result': 'tool result', 'system': 'system'
      })[chunk.role] || chunk.role;
      role.appendChild(label);
      turn.appendChild(role);

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (chunk.role === 'tool') {
        bubble.innerHTML = '<span class="name">' + esc(chunk.toolName || '?') + '</span>'
          + (chunk.toolArgs ? '<span class="args">' + esc(chunk.toolArgs) + '</span>' : '');
      } else {
        bubble.textContent = chunk.text || '';
      }
      turn.appendChild(bubble);
      chat.appendChild(turn);
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg?.type === 'chunk') append(msg.chunk);
      else if (msg?.type === 'status') status.textContent = msg.text;
    });
  </script>
</body></html>`;
}
