'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Hash, AtSign, FileText, Sparkles, ShieldAlert, AlertTriangle, GitBranch, Users,
} from 'lucide-react';
import { cn } from '../../lib/cn';

interface Channel {
  id: string;
  name: string;
  kind: 'general' | 'routing' | 'approvals' | 'briefs' | 'errors' | 'agent' | 'brief';
  description: string;
  lastTs?: number;
  count?: number;
}

interface Chunk {
  id: string;
  ts: number;
  workspaceId: string;
  kind: string;
  agentId?: string;
  text?: string;
  tool?: string;
  args?: unknown;
  status?: string;
  level?: string;
  phase?: string;
  decision?: string;
  taskId?: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

const KIND_ICON: Record<Channel['kind'], React.ComponentType<{ size?: number }>> = {
  general:   Hash,
  routing:   GitBranch,
  approvals: ShieldAlert,
  briefs:    FileText,
  errors:    AlertTriangle,
  agent:     AtSign,
  brief:     FileText,
};

function fmtTs(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function preview(c: Chunk): string {
  if (c.text) return c.text;
  if (c.kind === 'tool') return `${c.tool ?? '?'}(${JSON.stringify(c.args ?? {}).slice(0, 80)})`;
  if (c.kind === 'phase') return `${c.phase ?? '?'} → ${c.status ?? '?'}`;
  if (c.kind === 'approval') return `decision: ${c.decision ?? '?'}`;
  return JSON.stringify(c).slice(0, 120);
}

const KIND_COLOR: Record<string, string> = {
  user:     'text-info',
  ai:       'text-accent',
  system:   'text-dim',
  tool:     'text-warn',
  phase:    'text-sonnet',
  approval: 'text-accent',
};

export function ChannelsView({ workspaceId }: { workspaceId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<string>('general');
  const [events, setEvents] = useState<Chunk[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load channel list.
  async function loadChannels() {
    const r = await fetch(`/api/workspaces/${workspaceId}/channels`);
    if (r.ok) setChannels((await r.json()).channels ?? []);
  }
  useEffect(() => { loadChannels(); const t = setInterval(loadChannels, 6000); return () => clearInterval(t); }, [workspaceId]);

  // Load events for the active channel.
  async function loadEvents() {
    setLoadingEvents(true);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/channels/${encodeURIComponent(active)}/events?limit=200`);
      if (r.ok) setEvents((await r.json()).events ?? []);
    } finally { setLoadingEvents(false); }
  }
  useEffect(() => { loadEvents(); }, [workspaceId, active]);

  // Subscribe to the workspace's live SSE so the channel auto-refreshes when
  // new events arrive matching the current filter.
  useEffect(() => {
    const es = new EventSource(`/api/workspaces/${workspaceId}/events`);
    es.onmessage = () => { loadEvents(); };
    return () => es.close();
  }, [workspaceId, active]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [events.length]);

  // Keyboard nav: j/k cycles channels.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = channels.findIndex((c) => c.id === active);
      if (i < 0) return;
      const next = e.key === 'j' ? Math.min(channels.length - 1, i + 1) : Math.max(0, i - 1);
      setActive(channels[next]!.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [channels, active]);

  const grouped = useMemo(() => {
    const builtIn = channels.filter((c) => !c.id.startsWith('a:') && !c.id.startsWith('b:'));
    const agents = channels.filter((c) => c.id.startsWith('a:'));
    const briefs = channels.filter((c) => c.id.startsWith('b:'));
    return { builtIn, agents, briefs };
  }, [channels]);

  const activeCh = channels.find((c) => c.id === active);

  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="w-60 border-r border-line/70 overflow-y-auto glass p-2 flex flex-col gap-3">
        <ChannelGroup label="" items={grouped.builtIn} active={active} onPick={setActive} />
        {grouped.agents.length > 0 && (
          <ChannelGroup
            label={<><Users size={11} className="text-dim2" /> Direct agents</>}
            items={grouped.agents}
            active={active}
            onPick={setActive}
          />
        )}
        {grouped.briefs.length > 0 && (
          <ChannelGroup
            label={<><Sparkles size={11} className="text-dim2" /> Briefs</>}
            items={grouped.briefs}
            active={active}
            onPick={setActive}
          />
        )}
        <div className="mt-auto px-2 py-2 text-dim2 text-[10px] uppercase tracking-wider">
          <kbd className="px-1 py-0.5 rounded bg-bg/60 border border-line/70">j</kbd>{' '}/{' '}
          <kbd className="px-1 py-0.5 rounded bg-bg/60 border border-line/70">k</kbd>{' '}to cycle
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-line/70 px-5 py-2 glass flex items-center gap-3">
          {activeCh && (() => {
            const Icon = KIND_ICON[activeCh.kind] ?? Hash;
            return (
              <>
                <Icon size={14} />
                <div>
                  <div className="text-ink font-medium text-sm">{activeCh.name}</div>
                  <div className="text-dim2 text-[11px] truncate">{activeCh.description}</div>
                </div>
                <div className="ml-auto text-dim2 text-[11px] font-mono">
                  {loadingEvents ? '…' : `${events.length} events`}
                </div>
              </>
            );
          })()}
        </header>

        <ol className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[12.5px]">
          {events.length === 0 && (
            <li className="px-6 py-12 text-center text-dim2 italic text-sm">No events in this channel yet.</li>
          )}
          {events.map((c) => (
            <li
              key={c.id}
              className="grid grid-cols-[88px_60px_120px_1fr] gap-3 px-2 py-0.5 rounded hover:bg-line/30"
            >
              <span className="text-dim2 self-center">{fmtTs(c.ts)}</span>
              <span className={cn(
                'self-center text-[10px] uppercase tracking-wider',
                KIND_COLOR[c.kind] ?? 'text-dim',
              )}>
                {c.kind}
              </span>
              <span className="text-dim text-[11px] truncate self-center">{c.agentId ?? <span className="text-dim2 italic">—</span>}</span>
              <span className={cn(
                'self-center truncate',
                c.kind === 'system' && c.level === 'error' && 'text-err',
                c.kind === 'system' && c.level === 'warn'  && 'text-warn',
                c.kind === 'ai'     && 'text-ink',
                c.kind !== 'system' && c.kind !== 'ai' && 'text-ink2',
                c.kind === 'system' && !c.level && 'text-dim',
              )}>
                {preview(c)}
              </span>
            </li>
          ))}
          <div ref={bottomRef} />
        </ol>
      </main>
    </div>
  );
}

function ChannelGroup({
  label, items, active, onPick,
}: {
  label: React.ReactNode;
  items: Channel[];
  active: string;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      {label && (
        <div className="px-2 mb-1 text-dim2 text-[10px] uppercase tracking-wider flex items-center gap-1">
          {label}
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {items.map((c) => {
          const Icon = KIND_ICON[c.kind] ?? Hash;
          const isActive = c.id === active;
          return (
            <li key={c.id}>
              <button
                onClick={() => onPick(c.id)}
                className={cn(
                  'w-full text-left flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors',
                  isActive ? 'bg-line2/60 text-ink' : 'text-ink2 hover:bg-line/40',
                )}
              >
                <Icon size={12} />
                <span className="flex-1 truncate font-mono">{c.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
