// Live Claude session — a VS Code Pseudoterminal that streams the same
// output the orchestrator gets from the Claude CLI process, formatted with
// ANSI colors so it reads like running `claude` in your own shell.
//
// Wired from the Progress Tracker / Team sidebar: clicking a running task
// opens this terminal. Sub-second latency from chunk arrival to terminal
// write — the user watches Claude work in real time.

import * as vscode from 'vscode';
import { AtruneApi } from './api';

interface OpenArgs {
  workspaceId: string;
  briefId: string;
  phase: 'research' | 'plan' | 'implement' | 'review' | 'verify';
  role: string;
}

// ANSI colors (16-color, supported in every VS Code terminal theme).
const C = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m',     // Claude
  green: '\x1b[32m',    // User / brief
  yellow: '\x1b[33m',   // Tool call
  magenta: '\x1b[35m',  // Phase markers
  red: '\x1b[31m',      // Errors / failures
  grey: '\x1b[90m',     // Timestamps, meta
};

// One terminal per (briefId, phase, role) — same click reuses the panel.
const terminals = new Map<string, vscode.Terminal>();
const writers = new Map<string, vscode.EventEmitter<string>>();
const closers = new Map<string, () => void>();

function termKey(a: OpenArgs): string {
  return `${a.briefId}::${a.phase}::${a.role}`;
}

export async function openLiveClaudeSession(api: AtruneApi, args: OpenArgs): Promise<void> {
  const key = termKey(args);
  const existing = terminals.get(key);
  if (existing) {
    existing.show(true);
    return;
  }

  const writeEmitter = new vscode.EventEmitter<string>();
  let closed = false;
  let abort: AbortController | null = null;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    open: () => {
      writeEmitter.fire(`${C.bold}${C.cyan}Atrune · live Claude session${C.reset}\r\n`);
      writeEmitter.fire(`${C.grey}brief ${args.briefId} · phase ${args.phase} · role ${args.role}${C.reset}\r\n`);
      writeEmitter.fire(`${C.grey}${'─'.repeat(70)}${C.reset}\r\n\r\n`);
      writeEmitter.fire(`${C.dim}Connecting to event stream…${C.reset}\r\n\r\n`);
      // Start the SSE-backed feeder.
      void streamInto(api, args, (text) => writeEmitter.fire(text), (ctl) => { abort = ctl; });
    },
    close: () => {
      closed = true;
      try { abort?.abort(); } catch {}
      terminals.delete(key);
      writers.delete(key);
      closers.delete(key);
    },
  };

  const term = vscode.window.createTerminal({
    name: `Claude · ${args.role} · ${args.phase}`,
    pty,
    iconPath: new vscode.ThemeIcon('comment-discussion'),
  });
  terminals.set(key, term);
  writers.set(key, writeEmitter);
  closers.set(key, () => { try { abort?.abort(); } catch {} });
  term.show(true);
}

// ──────────────────────────────────────────────────────────────────────────
// Streaming loop. Backfills with a single GET against the brief endpoint,
// then opens a long-lived SSE connection against /api/workspaces/:id/events
// and routes every chunk that matches (phase, role) into the terminal.

async function streamInto(
  api: AtruneApi,
  args: OpenArgs,
  write: (text: string) => void,
  setAbort: (ctl: AbortController) => void,
): Promise<void> {
  const SERVER = process.env.ATRUNE_SERVER ?? 'http://localhost:4000';

  // Resolve the role → agentId so we can filter chunks tightly.
  let agentId: string | null = null;
  try {
    const list = await api.listAgents(args.workspaceId);
    agentId = list.find((a) => a.role === args.role)?.id ?? null;
  } catch {}

  // ── Backfill ────────────────────────────────────────────────────────────
  let lastTs = 0;
  let phaseStarted = false;
  let phaseEnded: 'completed' | 'failed' | null = null;
  try {
    const r = await fetch(`${SERVER}/api/workspaces/${args.workspaceId}/briefs/${args.briefId}`);
    if (r.ok) {
      const j = await r.json() as { chunks?: any[] };
      const chunks = j.chunks ?? [];
      const window = computePhaseWindow(chunks, args.phase);
      for (const c of chunks) {
        if (!matchesTask(c, args.phase, agentId, window)) continue;
        write(formatChunk(c));
        lastTs = Math.max(lastTs, c.ts ?? 0);
        if (c.kind === 'phase' && c.phase === args.phase) {
          if (c.status === 'started') phaseStarted = true;
          if (c.status === 'completed' || c.status === 'failed') phaseEnded = c.status;
        }
      }
      if (!phaseStarted) {
        write(`${C.dim}Waiting for ${args.phase} phase to start…${C.reset}\r\n\r\n`);
      }
    }
  } catch (e: any) {
    write(`${C.red}backfill failed: ${e?.message ?? e}${C.reset}\r\n`);
  }

  if (phaseEnded) {
    write(`\r\n${C.dim}${C.grey}── phase ${phaseEnded} · session closed${C.reset}\r\n`);
    return;
  }

  // ── Live SSE ────────────────────────────────────────────────────────────
  // Node ≥ 18 ships fetch. We read the response body as a ReadableStream and
  // parse SSE frames manually (no extra dep, no EventSource polyfill).
  const ctl = new AbortController();
  setAbort(ctl);
  const url = `${SERVER}/api/workspaces/${args.workspaceId}/events${lastTs ? `?since=${lastTs}` : ''}`;

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: ctl.signal,
    });
    if (!resp.ok || !resp.body) {
      write(`${C.red}SSE connect failed: HTTP ${resp.status}${C.reset}\r\n`);
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let phaseTerminal: 'completed' | 'failed' | null = null;

    while (true) {
      if (ctl.signal.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines.
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let parsed: any;
        try { parsed = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (!parsed || typeof parsed !== 'object') continue;

        const window = { start: 0, end: Infinity }; // already in flight; trust agentId+phase match
        if (!matchesTask(parsed, args.phase, agentId, window)) continue;
        write(formatChunk(parsed));

        if (parsed.kind === 'phase' && parsed.phase === args.phase) {
          if (parsed.status === 'completed' || parsed.status === 'failed') {
            phaseTerminal = parsed.status;
          }
        }
      }
      if (phaseTerminal) {
        write(`\r\n${C.dim}${C.grey}── phase ${phaseTerminal} · session closed${C.reset}\r\n`);
        try { ctl.abort(); } catch {}
        break;
      }
    }
  } catch (e: any) {
    if (!ctl.signal.aborted) {
      write(`\r\n${C.red}stream ended: ${e?.message ?? e}${C.reset}\r\n`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Filtering: keep chunks for THIS phase + role only.

interface PhaseWindow { start: number; end: number; }
function computePhaseWindow(chunks: any[], phase: string): PhaseWindow {
  let start = 0, end = Infinity;
  for (const c of chunks) {
    if (c?.kind !== 'phase' || c.phase !== phase) continue;
    if (c.status === 'started' && (start === 0 || c.ts < start)) start = c.ts;
    if ((c.status === 'completed' || c.status === 'failed') && c.ts > start) end = c.ts;
  }
  return { start, end };
}
function matchesTask(c: any, phase: string, agentId: string | null, w: PhaseWindow): boolean {
  if (!c || typeof c !== 'object') return false;
  const ts = c.ts ?? 0;
  if (ts < w.start || ts > w.end) return false;
  // Phase chunks for this phase always pass (so the user sees started/completed bars).
  if (c.kind === 'phase' && c.phase === phase) return true;
  // For other chunks, prefer agentId match. Fallback: include chunks with no
  // agentId in the window (covers narrator-ish system chunks).
  if (agentId && c.agentId) return c.agentId === agentId;
  return !c.agentId;
}

// ──────────────────────────────────────────────────────────────────────────
// Pretty-printing chunks for the terminal.

function ts(c: any): string {
  const t = c.ts ?? Date.now();
  const d = new Date(t);
  return d.toTimeString().slice(0, 8); // HH:MM:SS
}
function formatChunk(c: any): string {
  switch (c.kind) {
    case 'phase': {
      const mark = c.status === 'started' ? '▶'
        : c.status === 'completed' ? '✓'
        : c.status === 'failed' ? '🛑'
        : '·';
      return `\r\n${C.magenta}${'═'.repeat(20)} ${mark} ${c.phase} ${c.status} ${'═'.repeat(20)}${C.reset}\r\n\r\n`;
    }
    case 'user': {
      const lines = String(c.text ?? '').split('\n').map((l) => `  ${l}`).join('\r\n');
      return `${C.grey}[${ts(c)}]${C.reset} ${C.bold}${C.green}You:${C.reset}\r\n${lines}\r\n\r\n`;
    }
    case 'ai': {
      const usage = (c.tokensIn || c.tokensOut)
        ? ` ${C.dim}(${c.tokensIn ?? 0}↓ / ${c.tokensOut ?? 0}↑)${C.reset}`
        : '';
      const lines = String(c.text ?? '').split('\n').map((l) => `  ${l}`).join('\r\n');
      return `${C.grey}[${ts(c)}]${C.reset} ${C.bold}${C.cyan}Claude${C.reset}${usage}:\r\n${lines}\r\n\r\n`;
    }
    case 'tool': {
      const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}, null, 2);
      const result = c.result == null
        ? ''
        : (typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2));
      const argsLines = args.split('\n').map((l: string) => `    ${l}`).join('\r\n');
      const resultLines = result.split('\n').slice(0, 50).map((l: string) => `    ${l}`).join('\r\n');
      const head = `${C.grey}[${ts(c)}]${C.reset} ${C.bold}${C.yellow}$ ${c.tool ?? 'tool'}${C.reset}`;
      const body = `\r\n${C.dim}  ── input ──${C.reset}\r\n${argsLines}`;
      const tail = result
        ? `\r\n${C.dim}  ── result ──${C.reset}\r\n${resultLines}`
        : '';
      return `${head}${body}${tail}\r\n\r\n`;
    }
    case 'system': {
      const level = c.level ?? 'info';
      const color = level === 'error' ? C.red : level === 'warn' ? C.yellow : C.dim;
      return `${C.grey}[${ts(c)}]${C.reset} ${color}· ${c.text ?? ''}${C.reset}\r\n`;
    }
    case 'approval': {
      return `${C.grey}[${ts(c)}]${C.reset} ${C.yellow}⚖ approval: ${c.decision ?? '?'}${C.reset}\r\n\r\n`;
    }
    default:
      return '';
  }
}
