'use client';

import { useEffect, useRef, useState } from 'react';
import {
  User, Bot, Circle, Wrench, ArrowRightCircle, ShieldCheck, AlertTriangle, ChevronDown,
} from 'lucide-react';
import { cn } from '../../lib/cn';

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

const KIND_META: Record<Chunk['kind'], { icon: React.ComponentType<{ size?: number }>; color: string; bg: string }> = {
  user:     { icon: User,            color: 'text-info',   bg: 'bg-info/[0.08]' },
  ai:       { icon: Bot,             color: 'text-accent', bg: 'bg-accent/[0.06]' },
  system:   { icon: Circle,          color: 'text-dim',    bg: 'bg-transparent' },
  tool:     { icon: Wrench,          color: 'text-warn',   bg: 'bg-warn/[0.06]' },
  phase:    { icon: ArrowRightCircle, color: 'text-sonnet', bg: 'bg-sonnet/[0.06]' },
  approval: { icon: ShieldCheck,     color: 'text-accent', bg: 'bg-accent/[0.06]' },
};

function modelTier(model?: string) {
  if (!model) return null;
  if (/haiku/i.test(model)) return 'haiku';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  return null;
}

function formatTs(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function preview(c: Chunk): string {
  if (c.text) return c.text;
  if (c.kind === 'tool') return `${c.tool}(${JSON.stringify(c.args ?? {}).slice(0, 80)})`;
  if (c.kind === 'phase') return `${c.phase ?? '?'} → ${c.status ?? '?'}`;
  if (c.kind === 'approval') return `decision: ${c.decision}`;
  return JSON.stringify(c).slice(0, 120);
}

const ROUTING_RE = /^(routing plan:|dispatch:)/;
function isRoutingNote(c: Chunk): boolean {
  return c.kind === 'system' && !!c.text && ROUTING_RE.test(c.text);
}

export function EventFeed({ workspaceId }: { workspaceId: string }) {
  const [events, setEvents] = useState<Chunk[]>([]);
  const [connected, setConnected] = useState(false);
  const [replayed, setReplayed] = useState<number | null>(null);
  const [tokensIn, setTokensIn] = useState(0);
  const [tokensOut, setTokensOut] = useState(0);
  const [autoscroll, setAutoscroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

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
        setEvents((prev) => [...prev, c].slice(-1000));
        if (c.kind === 'ai') {
          setTokensIn((n) => n + (c.tokensIn ?? 0));
          setTokensOut((n) => n + (c.tokensOut ?? 0));
        }
      } catch {}
    };
    return () => es.close();
  }, [workspaceId]);

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, autoscroll]);

  function onScroll() {
    const el = listRef.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoscroll(atBottom);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-line/70 px-5 py-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className={cn('inline-block w-1.5 h-1.5 rounded-full', connected ? 'bg-accent pulse-dot' : 'bg-warn')} />
            <span className="text-dim">{connected ? 'connected' : 'connecting…'}</span>
          </span>
          {replayed !== null && (
            <span className="text-dim2">backlog <span className="text-ink2 font-mono">{replayed}</span></span>
          )}
        </div>
        <div className="flex items-center gap-3 text-dim font-mono">
          <span><span className="text-dim2 text-[10px] uppercase mr-1">events</span><span className="text-ink">{events.length}</span></span>
          <span><span className="text-dim2 text-[10px] uppercase mr-1">↓in</span><span className="text-ink">{tokensIn.toLocaleString()}</span></span>
          <span><span className="text-dim2 text-[10px] uppercase mr-1">↑out</span><span className="text-ink">{tokensOut.toLocaleString()}</span></span>
        </div>
      </div>
      <ol
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2 font-mono text-[12.5px] relative"
      >
        {events.length === 0 && (
          <EmptyState workspaceId={workspaceId} />
        )}
        {events.map((c) => {
          const meta = KIND_META[c.kind];
          const Icon = meta.icon;
          const tier = modelTier(c.model);
          return (
            <li
              key={c.id}
              className={cn(
                'group grid grid-cols-[88px_22px_120px_1fr_auto] gap-3 px-3 py-1 rounded transition-colors hover:bg-line/30',
                meta.bg,
              )}
            >
              <span className="text-dim2 text-[11px] self-center">{formatTs(c.ts)}</span>
              <span className={cn('self-center flex items-center justify-center', meta.color)}>
                <Icon size={12} />
              </span>
              <span className="text-dim text-[11px] truncate self-center">{c.agentId ?? <span className="text-dim2 italic">—</span>}</span>
              <span className={cn(
                'self-center truncate',
                c.kind === 'system' && c.level === 'error' && 'text-err',
                c.kind === 'system' && c.level === 'warn'  && 'text-warn',
                c.kind === 'ai'     && 'text-ink',
                c.kind !== 'system' && c.kind !== 'ai' && 'text-ink2',
                c.kind === 'system' && !c.level && 'text-dim',
                isRoutingNote(c) && 'text-sonnet',
              )}>
                {preview(c)}
              </span>
              <span className="text-[11px] whitespace-nowrap self-center">
                {c.kind === 'ai' && (c.tokensIn || c.tokensOut) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="text-dim2">{c.tokensIn ?? 0}↓/{c.tokensOut ?? 0}↑</span>
                    {tier && (
                      <span className={cn(
                        'px-1.5 py-0.5 rounded-full text-[9px] font-medium border',
                        tier === 'haiku'  && 'border-haiku/40 text-haiku bg-haiku/10',
                        tier === 'sonnet' && 'border-sonnet/40 text-sonnet bg-sonnet/10',
                        tier === 'opus'   && 'border-opus/40 text-opus bg-opus/10',
                      )}>
                        {tier}
                      </span>
                    )}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
        <div ref={bottomRef} />
        {!autoscroll && events.length > 0 && (
          <button
            onClick={() => { setAutoscroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
            className="sticky bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent text-bg text-xs font-medium shadow-glow"
          >
            <ChevronDown size={12} />
            jump to live
          </button>
        )}
      </ol>
    </div>
  );
}

function EmptyState({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="px-6 py-12 flex flex-col items-center text-center gap-3 animate-fadeIn">
      <div className="w-12 h-12 rounded-full bg-line/40 border border-line2 flex items-center justify-center">
        <AlertTriangle size={18} className="text-dim" />
      </div>
      <div className="text-ink text-sm">Waiting for events</div>
      <div className="text-dim text-xs max-w-md">
        Submit a brief on the right, or push a synthetic chunk:
      </div>
      <pre className="text-[11px] text-dim2 bg-bg/60 border border-line/70 rounded px-3 py-2 text-left overflow-x-auto max-w-md">{`curl -X POST http://localhost:3000/api/workspaces/${workspaceId}/events \\
  -H 'content-type: application/json' \\
  -d '{"id":"x1","ts":0,"workspaceId":"${workspaceId}","kind":"system","text":"hello","level":"info"}'`}</pre>
    </div>
  );
}
