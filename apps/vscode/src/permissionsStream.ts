// SSE consumer that refreshes the Permissions view the moment a `tool`
// (status: pending) or `approval` chunk hits the workspace event log. Without
// this, users wait up to 5s (the extension poll interval) between a hook
// blocking and the sidebar showing the request.
//
// Uses Node 18+ fetch with streamed body — no EventSource dep. Auto-reconnects
// with backoff so a server restart doesn't leave the stream dead.

import * as vscode from 'vscode';

type OnPermissionEvent = () => void;

export class PermissionsStream {
  private abort: AbortController | null = null;
  private disposed = false;
  private currentWorkspaceId: string | null = null;

  constructor(
    private serverBase: () => string,
    private onEvent: OnPermissionEvent,
  ) {}

  /** Switch which workspace we're streaming from. Closes any existing stream. */
  setWorkspace(workspaceId: string | null): void {
    if (this.currentWorkspaceId === workspaceId) return;
    this.currentWorkspaceId = workspaceId;
    this.abort?.abort();
    if (workspaceId) void this.loop(workspaceId);
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
  }

  private async loop(workspaceId: string): Promise<void> {
    let backoffMs = 500;
    while (!this.disposed && this.currentWorkspaceId === workspaceId) {
      const ctl = new AbortController();
      this.abort = ctl;
      try {
        const since = Date.now(); // don't replay history — we only care about NEW events
        const url = `${this.serverBase()}/api/workspaces/${workspaceId}/events?since=${since}`;
        const r = await fetch(url, {
          signal: ctl.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!r.ok || !r.body) throw new Error(`stream http ${r.status}`);
        backoffMs = 500; // reset on successful connect
        await consumeSSE(r.body, (chunk) => {
          if (isPermissionRelevant(chunk)) this.onEvent();
        }, ctl.signal);
      } catch (err) {
        if (this.disposed || ctl.signal.aborted) return;
        // Backoff and retry — server may be restarting.
        await sleep(Math.min(backoffMs, 10_000));
        backoffMs = Math.min(backoffMs * 2, 10_000);
      }
    }
  }
}

async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onData: (parsed: any) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are delimited by a blank line. Each frame may have multiple
    // `data:` lines; we only care about the concatenated data payload.
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      try {
        onData(JSON.parse(dataLines.join('\n')));
      } catch {
        // Non-JSON payloads (heartbeats, event: ready) are ignored.
      }
    }
  }
}

function isPermissionRelevant(chunk: any): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.kind === 'approval') return true;
  if (chunk.kind === 'tool' && (chunk.status === 'pending' || chunk.status === 'auto-approved' || chunk.status === 'denied')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
