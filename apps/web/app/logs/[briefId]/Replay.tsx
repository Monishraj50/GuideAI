'use client';

import { useEffect, useMemo, useState } from 'react';
import { SkipBack, ChevronLeft, ChevronRight, SkipForward, Code2, ChevronDown, ChevronRight as ChevronR } from 'lucide-react';
import { cn } from '../../../lib/cn';

interface TaskRow {
  id: string;
  briefId: string;
  agentId: string | null;
  phase: string;
  status: string;
  artifactPath: string | null;
  tokensIn: number;
  tokensOut: number;
  startedAt: number | null;
  endedAt: number | null;
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
  phase?: string;
  taskId?: string;
  decision?: string;
  level?: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}
interface TraceResp {
  brief: { id: string; body: string; status: string; createdAt: number };
  tasks: TaskRow[];
  chunks: Chunk[];
  artifacts: Record<string, { phase: string; path: string; body: string }>;
  window: { startTs: number; endTs: number };
}

const PHASE_COLOR: Record<string, string> = {
  research:  'bg-haiku',
  plan:      'bg-sonnet',
  implement: 'bg-sonnet',
  review:    'bg-opus',
  verify:    'bg-haiku',
};

function fmtMs(n: number) {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}
function shortPreview(c: Chunk): string {
  if (c.text) return c.text;
  if (c.kind === 'tool') return `${c.tool}(${JSON.stringify(c.args ?? {}).slice(0, 60)})`;
  if (c.kind === 'phase') return `${c.phase ?? '?'} → ${c.status ?? '?'}`;
  if (c.kind === 'approval') return `decision: ${c.decision}`;
  return JSON.stringify(c).slice(0, 80);
}

export function Replay({ workspaceId, briefId }: { workspaceId: string; briefId: string }) {
  const [trace, setTrace] = useState<TraceResp | null>(null);
  const [cursor, setCursor] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/briefs/${briefId}`).then((r) => r.json()).then((j) => {
      setTrace(j);
      setCursor(Math.max(0, (j.chunks?.length ?? 1) - 1));
    });
  }, [workspaceId, briefId]);

  const { totalDuration, phaseBars } = useMemo(() => {
    if (!trace) return { totalDuration: 0, phaseBars: [] as Array<{ phase: string; offset: number; width: number; durationMs: number; tokensIn: number; tokensOut: number; status: string }> };
    const start = trace.window.startTs;
    const end = trace.window.endTs;
    const total = Math.max(1, end - start);
    const bars = trace.tasks.map((t) => {
      const s = t.startedAt ?? start;
      const e = t.endedAt ?? end;
      return {
        phase: t.phase,
        offset: ((s - start) / total) * 100,
        width: Math.max(2, ((e - s) / total) * 100),
        durationMs: e - s,
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        status: t.status,
      };
    });
    return { totalDuration: total, phaseBars: bars };
  }, [trace]);

  if (!trace) {
    return <div className="p-6 space-y-2"><div className="h-4 w-40 shimmer bg-line/30 rounded" /><div className="h-3 w-80 shimmer bg-line/20 rounded" /></div>;
  }

  const current = trace.chunks[cursor];
  const visible = trace.chunks.slice(0, cursor + 1);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Top: brief + flame graph */}
      <section className="border-b border-line/70 p-5">
        <div className="text-ink text-sm">{trace.brief.body}</div>
        <div className="text-dim2 text-[11px] mt-1">
          {new Date(trace.brief.createdAt).toLocaleString()} · {trace.brief.status} · total <span className="text-ink font-mono">{fmtMs(totalDuration)}</span>
        </div>
        <div className="relative mt-4 h-8 bg-bg/70 border border-line/70 rounded-md overflow-hidden">
          {phaseBars.map((b, i) => (
            <div
              key={i}
              title={`${b.phase} · ${fmtMs(b.durationMs)} · ${b.tokensIn}↓/${b.tokensOut}↑`}
              style={{ left: `${b.offset}%`, width: `${b.width}%` }}
              className={cn(
                'absolute top-0 bottom-0 border-r border-bg/60 flex items-center justify-center text-[10px] text-bg font-mono font-medium transition-opacity hover:opacity-90',
                PHASE_COLOR[b.phase] ?? 'bg-line',
              )}
            >
              {b.width > 6 ? b.phase : ''}
            </div>
          ))}
        </div>
      </section>

      {/* Scrubber */}
      <section className="border-b border-line/70 p-4">
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setCursor(0)} className="p-1 rounded border border-line/70 text-dim hover:text-ink hover:border-line2"><SkipBack size={12} /></button>
          <button onClick={() => setCursor((c) => Math.max(0, c - 1))} className="p-1 rounded border border-line/70 text-dim hover:text-ink hover:border-line2"><ChevronLeft size={12} /></button>
          <input
            type="range"
            min={0}
            max={Math.max(0, trace.chunks.length - 1)}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <button onClick={() => setCursor((c) => Math.min(trace.chunks.length - 1, c + 1))} className="p-1 rounded border border-line/70 text-dim hover:text-ink hover:border-line2"><ChevronRight size={12} /></button>
          <button onClick={() => setCursor(trace.chunks.length - 1)} className="p-1 rounded border border-line/70 text-dim hover:text-ink hover:border-line2"><SkipForward size={12} /></button>
          <span className="text-dim2 font-mono w-20 text-right">{cursor + 1} / {trace.chunks.length}</span>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-md text-xs',
              showRaw ? 'bg-accent text-bg' : 'border border-line/70 text-dim hover:text-ink',
            )}
          >
            <Code2 size={12} /> raw
          </button>
        </div>
        {current && (
          <div className="mt-2 text-xs flex items-center gap-2">
            <span className="text-dim2 font-mono">{new Date(current.ts).toLocaleTimeString()}</span>
            <span className={cn(
              'uppercase font-mono text-[10px] px-1.5 py-0.5 rounded-full border',
              current.kind === 'ai' && 'border-accent/40 text-accent bg-accent/10',
              current.kind === 'tool' && 'border-warn/40 text-warn bg-warn/10',
              current.kind === 'approval' && 'border-accent/40 text-accent bg-accent/10',
              current.kind === 'phase' && 'border-sonnet/40 text-sonnet bg-sonnet/10',
              current.kind === 'system' && 'border-line/70 text-dim',
              current.kind === 'user' && 'border-info/40 text-info bg-info/10',
            )}>{current.kind}</span>
            <span className="text-dim2">{current.agentId ?? '—'}</span>
            <span className="text-ink truncate">{shortPreview(current)}</span>
          </div>
        )}
      </section>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        <ol className="flex-1 min-w-0 overflow-y-auto font-mono text-[12px]">
          {visible.map((c, i) => (
            <li
              key={c.id}
              onClick={() => setCursor(i)}
              className={cn(
                'px-5 py-1 cursor-pointer transition-colors',
                i === cursor ? 'bg-accent/[0.08] border-l-2 border-accent' : 'hover:bg-line/20 border-l-2 border-transparent',
              )}
            >
              <span className="text-dim2 mr-2">{new Date(c.ts).toLocaleTimeString()}</span>
              <span className="text-dim2 mr-2 w-14 inline-block uppercase text-[10px]">{c.kind}</span>
              <span className="text-ink2">{shortPreview(c).slice(0, 120)}</span>
            </li>
          ))}
        </ol>

        <aside className="w-80 border-l border-line/70 overflow-y-auto glass">
          <div className="px-3 py-2 border-b border-line/70 text-dim2 text-[10px] uppercase tracking-wider">Artifacts</div>
          {Object.values(trace.artifacts).length === 0 && (
            <div className="p-3 text-dim2 text-xs italic">No artifacts written.</div>
          )}
          {Object.entries(trace.artifacts).map(([phase, art]) => {
            const open = openArtifact === phase;
            return (
              <div key={phase} className="border-b border-line/40">
                <button
                  onClick={() => setOpenArtifact((v) => v === phase ? null : phase)}
                  className="w-full text-left p-3 text-sm text-ink2 hover:bg-line/20 flex items-center justify-between transition-colors"
                >
                  <span className="font-mono">{phase}.md</span>
                  {open ? <ChevronDown size={12} className="text-dim" /> : <ChevronR size={12} className="text-dim" />}
                </button>
                {open && (
                  <pre className="px-3 pb-3 text-[11px] text-dim2 whitespace-pre-wrap font-mono bg-bg/60 max-h-96 overflow-y-auto animate-fadeIn">{art.body.slice(0, 4000)}{art.body.length > 4000 ? '\n…' : ''}</pre>
                )}
              </div>
            );
          })}
        </aside>
      </div>

      {showRaw && (
        <div className="border-t border-line/70 bg-bg/80 max-h-72 overflow-y-auto p-3 animate-slideUp">
          <pre className="text-[10px] text-dim2 font-mono whitespace-pre-wrap">
            {visible.map((c) => JSON.stringify(c)).join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
}
