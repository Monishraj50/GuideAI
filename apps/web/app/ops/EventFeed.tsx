'use client';

import { useEffect, useRef, useState } from 'react';

type Chunk = {
  id: string;
  ts: number;
  workspaceId: string;
  kind: 'user' | 'ai' | 'system' | 'tool' | 'phase' | 'approval';
  agentId?: string;
  text?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  level?: string;
  phase?: string;
  decision?: string;
};

const KIND_GLYPH: Record<Chunk['kind'], string> = {
  user: '🔵',
  ai: '🟢',
  system: '·',
  tool: '🛠',
  phase: '▸',
  approval: '✓',
};

function formatTs(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function preview(c: Chunk): string {
  if (c.text) return c.text;
  if (c.kind === 'tool') return `${c.tool}(${JSON.stringify(c.args ?? {}).slice(0, 80)})`;
  if (c.kind === 'phase') return `${c.phase ?? '?'} → ${c.status ?? '?'}`;
  if (c.kind === 'approval') return `decision: ${c.decision}`;
  return JSON.stringify(c).slice(0, 120);
}

export function EventFeed({ workspaceId }: { workspaceId: string }) {
  const [events, setEvents] = useState<Chunk[]>([]);
  const [connected, setConnected] = useState(false);
  const [replayed, setReplayed] = useState<number | null>(null);
  const [tokensIn, setTokensIn] = useState(0);
  const [tokensOut, setTokensOut] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/workspaces/${workspaceId}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        if (typeof obj === 'object' && obj && 'replayed' in obj && !('kind' in obj)) {
          setReplayed(obj.replayed);
          return;
        }
        const c = obj as Chunk;
        setEvents((prev) => [...prev, c].slice(-500));
        if (c.kind === 'ai') {
          setTokensIn((n) => n + (c.tokensIn ?? 0));
          setTokensOut((n) => n + (c.tokensOut ?? 0));
        }
      } catch {}
    };
    return () => es.close();
  }, [workspaceId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-line px-4 py-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-3">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-accent' : 'bg-warn'}`} />
          <span className="text-dim">{connected ? 'connected' : 'connecting…'}</span>
          {replayed !== null && (
            <span className="text-dim">backlog: <span className="text-ink">{replayed}</span></span>
          )}
        </div>
        <div className="flex items-center gap-4 text-dim font-mono">
          <span>events: <span className="text-ink">{events.length}</span></span>
          <span>↓ in: <span className="text-ink">{tokensIn.toLocaleString()}</span></span>
          <span>↑ out: <span className="text-ink">{tokensOut.toLocaleString()}</span></span>
        </div>
      </div>
      <ol className="flex-1 min-h-0 overflow-y-auto px-4 py-2 font-mono text-[13px] leading-relaxed">
        {events.length === 0 && (
          <li className="text-dim italic py-4">
            Waiting for events. Try:<br />
            <code className="text-ink">curl -X POST -H 'content-type: application/json' \</code><br />
            <code className="text-ink">&nbsp;&nbsp;-d '{`{"id":"t1","ts":${Date.now()},"workspaceId":"${workspaceId}","kind":"system","text":"hello","level":"info"}`}' \</code><br />
            <code className="text-ink">&nbsp;&nbsp;http://localhost:3000/api/workspaces/{workspaceId}/events</code>
          </li>
        )}
        {events.map((c) => (
          <li key={c.id} className="grid grid-cols-[auto_auto_auto_1fr_auto] gap-3 py-0.5">
            <span className="text-dim w-[112px]">{formatTs(c.ts)}</span>
            <span className="w-4 text-center">{KIND_GLYPH[c.kind]}</span>
            <span className="text-dim w-24 truncate">{c.agentId ?? '—'}</span>
            <span className={`min-w-0 truncate ${c.kind === 'system' && c.level === 'error' ? 'text-err' : c.kind === 'system' && c.level === 'warn' ? 'text-warn' : 'text-ink'}`}>
              {preview(c)}
            </span>
            <span className="text-dim text-xs whitespace-nowrap">
              {c.kind === 'ai' && (c.tokensIn || c.tokensOut)
                ? `${c.tokensIn ?? 0}↓/${c.tokensOut ?? 0}↑${c.model ? ' · ' + c.model.replace('claude-', '') : ''}`
                : ''}
            </span>
          </li>
        ))}
        <div ref={bottomRef} />
      </ol>
    </div>
  );
}
