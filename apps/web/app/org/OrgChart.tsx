'use client';

import { useEffect, useState } from 'react';

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

// Fix the naive title-case for known acronyms.
const ACRONYMS = ['Qa', 'Api', 'Ai', 'Llm', 'Ml', 'Ci', 'Cd', 'Aws', 'Sql', 'Css', 'Html', 'Js', 'Ts', 'Php', 'Cpp', 'Iot', 'Ux', 'Ui', 'Seo'];
function prettyDisplay(name: string) {
  return name.split(' ').map((w) => {
    const up = w.toUpperCase();
    if (ACRONYMS.map((a) => a.toUpperCase()).includes(up)) return up;
    return w;
  }).join(' ');
}

function fmtUsd(n: number) {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function tintForWinRate(rate: number, hasTasks: boolean): string {
  if (!hasTasks) return 'border-line/50 bg-surface';
  if (rate >= 0.85) return 'border-accent/60 bg-accent/[0.06]';
  if (rate >= 0.6) return 'border-warn/60 bg-warn/[0.06]';
  return 'border-err/60 bg-err/[0.06]';
}

export function OrgChart({ workspaceId }: { workspaceId: string }) {
  const [stats, setStats] = useState<AgentStats[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentStats | null>(null);

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
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [workspaceId]);

  async function retire(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents/${id}`, { method: 'DELETE' });
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
      <main className="flex-1 min-w-0 overflow-y-auto p-4">
        <div className="mb-4 flex items-center gap-6 text-xs text-dim">
          <div>active: <span className="text-ink">{active.length}</span></div>
          <div>retired: <span className="text-ink">{retired.length}</span></div>
          <div>workspace spend: <span className="text-ink">{fmtUsd(totalUsd)}</span></div>
          <div>tokens: <span className="text-ink">{totalTokens.toLocaleString()}</span></div>
        </div>
        {active.length === 0 && (
          <div className="text-dim text-sm italic">No active agents. Go to <a className="text-accent underline" href="/hire">Hire</a> to add some.</div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {active.map((a) => {
            const hasTasks = a.tasksCompleted + a.tasksFailed > 0;
            return (
              <button
                key={a.id}
                onClick={() => setSelected(a)}
                className={`text-left border rounded p-3 transition-colors ${tintForWinRate(a.winRate, hasTasks)} ${selected?.id === a.id ? 'ring-2 ring-accent' : ''} hover:brightness-110`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-ink font-medium">{prettyDisplay(a.displayName)}</div>
                  <div className="text-dim text-[10px] font-mono">{a.status}</div>
                </div>
                <div className="text-dim text-xs mt-0.5">{a.role}</div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <Stat label="win" value={hasTasks ? `${Math.round(a.winRate * 100)}%` : '—'} />
                  <Stat label="tasks" value={hasTasks ? `${a.tasksCompleted}/${a.tasksCompleted + a.tasksFailed}` : '0'} />
                  <Stat label="rework" value={a.reworkCount} />
                  <Stat label="↓ in" value={a.tokensIn.toLocaleString()} />
                  <Stat label="↑ out" value={a.tokensOut.toLocaleString()} />
                  <Stat label="$" value={fmtUsd(a.usd)} />
                </div>
              </button>
            );
          })}
        </div>
        {retired.length > 0 && (
          <div className="mt-8">
            <div className="text-dim text-xs mb-2">Retired ({retired.length})</div>
            <div className="text-dim text-xs italic">
              {retired.map((a) => prettyDisplay(a.displayName)).join(', ')}
            </div>
          </div>
        )}
      </main>
      {selected && (
        <aside className="w-80 border-l border-line p-4 overflow-y-auto">
          <div className="text-ink font-medium">{prettyDisplay(selected.displayName)}</div>
          <div className="text-dim text-xs">{selected.role} · {selected.status}</div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <DetailStat label="Win rate" value={`${Math.round(selected.winRate * 100)}%`} />
            <DetailStat label="Tasks" value={`${selected.tasksCompleted} / ${selected.tasksCompleted + selected.tasksFailed}`} />
            <DetailStat label="Avg phase" value={selected.avgPhaseMs ? `${(selected.avgPhaseMs / 1000).toFixed(1)}s` : '—'} />
            <DetailStat label="Rework" value={selected.reworkCount} />
            <DetailStat label="Tokens ↓" value={selected.tokensIn.toLocaleString()} />
            <DetailStat label="Tokens ↑" value={selected.tokensOut.toLocaleString()} />
            <DetailStat label="Cost" value={fmtUsd(selected.usd)} />
            <DetailStat label="Last active" value={selected.lastActivity ? new Date(selected.lastActivity).toLocaleTimeString() : '—'} />
          </div>
          <button
            disabled={busy === selected.id}
            onClick={() => retire(selected.id)}
            className="mt-6 w-full px-3 py-2 rounded border border-err text-err text-sm disabled:opacity-40 hover:bg-err hover:text-bg"
          >
            retire
          </button>
        </aside>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-dim text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-ink font-mono">{value}</div>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-line bg-bg rounded p-2">
      <div className="text-dim text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-ink font-mono text-sm mt-0.5">{value}</div>
    </div>
  );
}
