'use client';

import { useEffect, useMemo, useState } from 'react';

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

  if (!trace) return <div className="p-6 text-dim text-sm">loading…</div>;

  const current = trace.chunks[cursor];
  const visible = trace.chunks.slice(0, cursor + 1);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Top: brief + flame graph */}
      <section className="border-b border-line p-4">
        <div className="text-ink text-sm">{trace.brief.body}</div>
        <div className="text-dim text-xs mt-1">
          {new Date(trace.brief.createdAt).toLocaleString()} · {trace.brief.status} · total {fmtMs(totalDuration)}
        </div>
        <div className="relative mt-4 h-7 bg-bg border border-line rounded overflow-hidden">
          {phaseBars.map((b, i) => (
            <div
              key={i}
              title={`${b.phase} · ${fmtMs(b.durationMs)} · ${b.tokensIn}↓/${b.tokensOut}↑`}
              style={{ left: `${b.offset}%`, width: `${b.width}%` }}
              className={`absolute top-0 bottom-0 ${PHASE_COLOR[b.phase] ?? 'bg-line'} border-r border-bg/40 flex items-center justify-center text-[10px] text-bg font-mono`}
            >
              {b.width > 6 ? b.phase : ''}
            </div>
          ))}
        </div>
      </section>

      {/* Scrubber */}
      <section className="border-b border-line p-4">
        <div className="flex items-center gap-3 text-xs">
          <button
            onClick={() => setCursor(0)}
            className="px-2 py-0.5 rounded border border-line text-dim hover:text-ink"
          >⏮</button>
          <button
            onClick={() => setCursor((c) => Math.max(0, c - 1))}
            className="px-2 py-0.5 rounded border border-line text-dim hover:text-ink"
          >←</button>
          <input
            type="range"
            min={0}
            max={Math.max(0, trace.chunks.length - 1)}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <button
            onClick={() => setCursor((c) => Math.min(trace.chunks.length - 1, c + 1))}
            className="px-2 py-0.5 rounded border border-line text-dim hover:text-ink"
          >→</button>
          <button
            onClick={() => setCursor(trace.chunks.length - 1)}
            className="px-2 py-0.5 rounded border border-line text-dim hover:text-ink"
          >⏭</button>
          <span className="text-dim font-mono w-20 text-right">{cursor + 1} / {trace.chunks.length}</span>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className={`px-2 py-0.5 rounded text-xs ${showRaw ? 'bg-accent text-bg' : 'border border-line text-dim hover:text-ink'}`}
          >raw</button>
        </div>
        {current && (
          <div className="mt-2 text-xs">
            <span className="text-dim font-mono mr-2">{new Date(current.ts).toLocaleTimeString()}</span>
            <span className={`uppercase mr-2 ${current.kind === 'system' && current.level === 'error' ? 'text-err' : current.kind === 'ai' ? 'text-accent' : current.kind === 'approval' ? 'text-warn' : 'text-dim'}`}>
              {current.kind}
            </span>
            <span className="text-dim mr-2">{current.agentId ?? '—'}</span>
            <span className="text-ink">{shortPreview(current)}</span>
          </div>
        )}
      </section>

      {/* Body: feed (left) + artifacts (right) + raw drawer */}
      <div className="flex-1 min-h-0 flex">
        <ol className="flex-1 min-w-0 overflow-y-auto font-mono text-[12px]">
          {visible.map((c, i) => (
            <li
              key={c.id}
              onClick={() => setCursor(i)}
              className={`px-4 py-1 cursor-pointer hover:bg-line ${i === cursor ? 'bg-line' : ''}`}
            >
              <span className="text-dim mr-2">{new Date(c.ts).toLocaleTimeString()}</span>
              <span className="text-dim mr-2 w-12 inline-block">{c.kind}</span>
              <span className="text-ink">{shortPreview(c).slice(0, 120)}</span>
            </li>
          ))}
        </ol>

        <aside className="w-80 border-l border-line overflow-y-auto">
          <div className="p-3 border-b border-line text-ink font-medium text-sm">Artifacts</div>
          {Object.values(trace.artifacts).length === 0 && (
            <div className="p-3 text-dim text-xs italic">No artifacts written.</div>
          )}
          {Object.entries(trace.artifacts).map(([phase, art]) => (
            <div key={phase} className="border-b border-line">
              <button
                onClick={() => setOpenArtifact((v) => v === phase ? null : phase)}
                className="w-full text-left p-3 text-sm text-ink hover:bg-line flex items-center justify-between"
              >
                <span className="font-mono">{phase}.md</span>
                <span className="text-dim text-xs">{openArtifact === phase ? '−' : '+'}</span>
              </button>
              {openArtifact === phase && (
                <pre className="p-3 text-[11px] text-dim whitespace-pre-wrap font-mono bg-bg max-h-96 overflow-y-auto">{art.body.slice(0, 4000)}{art.body.length > 4000 ? '\n…' : ''}</pre>
              )}
            </div>
          ))}
        </aside>
      </div>

      {/* Raw JSONL drawer */}
      {showRaw && (
        <div className="border-t border-line bg-bg max-h-72 overflow-y-auto p-3">
          <pre className="text-[10px] text-dim font-mono whitespace-pre-wrap">
            {visible.map((c) => JSON.stringify(c)).join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
}
