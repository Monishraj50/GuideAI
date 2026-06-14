'use client';

import { useEffect, useState } from 'react';
import { Users, X, Trophy, Coins, Pencil, Plus } from 'lucide-react';
import { toast } from '../../components/Toast';
import { Sparkline } from '../../components/Sparkline';
import { AgentEditor, type AgentEditorAgent } from '../../components/AgentEditor';
import { cn } from '../../lib/cn';

interface AgentStats {
  id: string;
  role: string;
  displayName: string;
  status: string;
  tasksCompleted: number;
  tasksFailed: number;
  winRate: number;
  avgPhaseMs: number;
  reworkCount: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  lastActivity: number | null;
}

const ACRONYMS = ['QA', 'API', 'AI', 'LLM', 'ML', 'CI', 'CD', 'AWS', 'SQL', 'CSS', 'HTML', 'JS', 'TS', 'PHP', 'CPP', 'IOT', 'UX', 'UI', 'SEO'];
function prettyDisplay(name: string) {
  return name.split(' ').map((w) => {
    const up = w.toUpperCase();
    if (ACRONYMS.includes(up)) return up;
    return w;
  }).join(' ');
}

function fmtUsd(n: number) {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function tintForWinRate(rate: number, hasTasks: boolean) {
  if (!hasTasks) return { border: 'border-line/60', bg: 'bg-surface/40', stroke: 'rgb(122,131,146)' };
  if (rate >= 0.85) return { border: 'border-accent/40', bg: 'bg-accent/[0.04]', stroke: 'rgb(92,242,192)' };
  if (rate >= 0.6) return { border: 'border-warn/40', bg: 'bg-warn/[0.04]', stroke: 'rgb(255,180,84)' };
  return { border: 'border-err/40', bg: 'bg-err/[0.04]', stroke: 'rgb(255,107,107)' };
}

function fakeSparkData(seed: number, len = 12) {
  // deterministic pseudo-random so SSR/CSR match
  const out: number[] = [];
  let v = (seed * 9301 + 49297) % 233280;
  for (let i = 0; i < len; i++) {
    v = (v * 9301 + 49297) % 233280;
    out.push(0.2 + (v / 233280) * 0.8);
  }
  return out;
}

export function OrgChart({ workspaceId }: { workspaceId: string }) {
  const [stats, setStats] = useState<AgentStats[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentStats | null>(null);
  const [editorMode, setEditorMode] = useState<null | { kind: 'create' } | { kind: 'edit'; agent: AgentEditorAgent }>(null);

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/metrics`);
    if (!r.ok) return;
    const j = await r.json();
    setStats(j.agents ?? []);
    if (selected) {
      const fresh = (j.agents ?? []).find((a: AgentStats) => a.id === selected.id);
      setSelected(fresh ?? null);
    }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [workspaceId]);

  async function openEditor(id: string) {
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${id}`);
    if (!r.ok) { toast({ title: 'Could not load agent', variant: 'error' }); return; }
    const a = await r.json();
    setEditorMode({ kind: 'edit', agent: a });
  }

  async function retire(id: string, name: string) {
    setBusy(id);
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents/${id}`, { method: 'DELETE' });
      toast({ title: `Retired ${prettyDisplay(name)}`, variant: 'warn' });
      setSelected(null);
      await refresh();
    } finally { setBusy(null); }
  }

  const active = stats.filter((s) => s.status !== 'retired');
  const retired = stats.filter((s) => s.status === 'retired');
  const totalUsd = active.reduce((s, a) => s + a.usd, 0);
  const totalTokens = active.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0);

  return (
    <div className="flex-1 min-h-0 flex">
      <main className="flex-1 min-w-0 overflow-y-auto p-5">
        <div className="mb-5 flex items-center gap-3 text-xs flex-wrap">
          <Stat icon={<Users size={12} />} label="active" value={active.length.toString()} />
          <Stat icon={<X size={12} />} label="retired" value={retired.length.toString()} subtle />
          <Stat icon={<Coins size={12} />} label="spend" value={fmtUsd(totalUsd)} />
          <Stat icon={<Trophy size={12} />} label="tokens" value={totalTokens.toLocaleString()} subtle />
          <div className="ml-auto" />
          <button
            onClick={() => setEditorMode({ kind: 'create' })}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium shadow-glow hover:brightness-110"
          >
            <Plus size={12} /> Create custom agent
          </button>
        </div>
        {active.length === 0 && (
          <div className="border border-dashed border-line/70 rounded-lg p-8 text-center">
            <div className="text-ink text-sm mb-1">No active agents</div>
            <div className="text-dim text-xs">Visit <a className="text-accent underline" href="/hire">/hire</a> to bring some on.</div>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {active.map((a) => {
            const hasTasks = a.tasksCompleted + a.tasksFailed > 0;
            const tint = tintForWinRate(a.winRate, hasTasks);
            const isSelected = selected?.id === a.id;
            const seed = a.id.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
            return (
              <div
                key={a.id}
                className={cn(
                  'text-left border rounded-lg p-3 transition-all duration-150 group relative overflow-hidden cursor-pointer',
                  tint.border, tint.bg,
                  isSelected ? 'ring-1 ring-accent shadow-glow' : 'hover:border-line2',
                )}
                onClick={() => setSelected(a)}
              >
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-ink font-medium truncate flex items-center gap-1.5">
                      {prettyDisplay(a.displayName)}
                      {a.role.startsWith('custom-') && (
                        <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-sonnet/15 text-sonnet border border-sonnet/30">custom</span>
                      )}
                    </div>
                    <div className="text-dim text-[11px] truncate font-mono">{a.role}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); openEditor(a.id); }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-dim2 hover:text-accent"
                      title="edit agent"
                    >
                      <Pencil size={11} />
                    </button>
                    <div className="flex items-center gap-1 text-[10px] font-mono">
                      <span className={cn(
                        'inline-block w-1.5 h-1.5 rounded-full',
                        a.status === 'working' ? 'bg-accent pulse-dot' : a.status === 'paused' ? 'bg-warn' : 'bg-dim2',
                      )} />
                      <span className="text-dim2 uppercase tracking-wider">{a.status}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-end gap-3">
                  <div className="flex-1 grid grid-cols-3 gap-2 text-xs">
                    <Cell label="phases" value={hasTasks ? `${a.tasksCompleted}` : '0'} />
                    <Cell label="tokens" value={hasTasks ? (a.tokensIn + a.tokensOut).toLocaleString() : '0'} />
                    <Cell label="$" value={fmtUsd(a.usd)} />
                  </div>
                  <Sparkline data={fakeSparkData(seed)} stroke={tint.stroke} className="opacity-90" />
                </div>
              </div>
            );
          })}
        </div>
        {retired.length > 0 && (
          <div className="mt-8">
            <div className="text-dim text-xs uppercase tracking-wider mb-2">Retired ({retired.length})</div>
            <div className="text-dim2 text-xs italic">
              {retired.map((a) => prettyDisplay(a.displayName)).join(' · ')}
            </div>
          </div>
        )}
      </main>
      {selected && (
        <aside className="w-80 border-l border-line/70 p-4 overflow-y-auto glass animate-slideUp">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-ink font-medium flex items-center gap-1.5">
                {prettyDisplay(selected.displayName)}
                {selected.role.startsWith('custom-') && (
                  <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-sonnet/15 text-sonnet border border-sonnet/30">custom</span>
                )}
              </div>
              <div className="text-dim text-xs font-mono">{selected.role}</div>
            </div>
            <button onClick={() => setSelected(null)} className="text-dim hover:text-ink"><X size={14} /></button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <Detail label="Win rate" value={`${Math.round(selected.winRate * 100)}%`} />
            <Detail label="Tasks" value={`${selected.tasksCompleted} / ${selected.tasksCompleted + selected.tasksFailed}`} />
            <Detail label="Avg phase" value={selected.avgPhaseMs ? `${(selected.avgPhaseMs / 1000).toFixed(1)}s` : '—'} />
            <Detail label="Rework" value={selected.reworkCount} />
            <Detail label="Tokens ↓" value={selected.tokensIn.toLocaleString()} />
            <Detail label="Tokens ↑" value={selected.tokensOut.toLocaleString()} />
            <Detail label="Cost" value={fmtUsd(selected.usd)} />
            <Detail label="Last active" value={selected.lastActivity ? new Date(selected.lastActivity).toLocaleTimeString() : '—'} />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-2">
            <button
              onClick={() => openEditor(selected.id)}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-accent/40 text-accent text-sm hover:bg-accent/10 transition-colors"
            >
              <Pencil size={12} /> edit
            </button>
            <button
              disabled={busy === selected.id}
              onClick={() => retire(selected.id, selected.displayName)}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-err/40 text-err text-sm disabled:opacity-40 hover:bg-err/10 transition-colors"
            >
              <X size={12} /> retire
            </button>
          </div>
        </aside>
      )}
      {editorMode && (
        editorMode.kind === 'create'
          ? <AgentEditor mode="create" workspaceId={workspaceId} onClose={() => setEditorMode(null)} onSaved={() => { setEditorMode(null); refresh(); }} />
          : <AgentEditor mode="edit" agent={editorMode.agent} workspaceId={workspaceId} onClose={() => setEditorMode(null)} onSaved={() => { setEditorMode(null); refresh(); }} />
      )}
    </div>
  );
}

function Stat({ icon, label, value, subtle }: { icon: React.ReactNode; label: string; value: string; subtle?: boolean }) {
  return (
    <div className={cn(
      'flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs',
      subtle ? 'border-line/70 text-dim' : 'border-line2 text-ink2 bg-line/20',
    )}>
      {icon}
      <span className="text-dim2 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="text-ink font-mono">{value}</span>
    </div>
  );
}
function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-dim2 text-[10px] uppercase tracking-wider">{label}</div>
      <div className="text-ink font-mono">{value}</div>
    </div>
  );
}
function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-line/70 bg-bg/40 rounded-md p-2">
      <div className="text-dim2 text-[10px] uppercase tracking-wider">{label}</div>
      <div className="text-ink font-mono text-sm mt-0.5">{value}</div>
    </div>
  );
}
