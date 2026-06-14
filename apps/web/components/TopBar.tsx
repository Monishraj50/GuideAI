'use client';

import { useEffect, useState } from 'react';
import { Search, Activity, Zap, DollarSign, Skull, Gauge, Wallet } from 'lucide-react';
import { useWorkspaceId } from './WorkspaceProvider';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { cn } from '../lib/cn';

interface KillswitchStatus { running: { agentId: string; pid: number }[] }
interface AgentStats {
  id: string;
  status: string;
  tasksCompleted: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}
interface BudgetState {
  config: { dailyUsdCap?: number; tokensPer5hCap?: number; behavior: string };
  usage:  { todayUsd: number; tokens5h: number; windowResetTs: number };
}

function fmtUsd(n: number) {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function TopBar() {
  const workspaceId = useWorkspaceId();
  const [running, setRunning] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [usd, setUsd] = useState(0);
  const [activeAgents, setActiveAgents] = useState(0);
  const [budget, setBudget] = useState<BudgetState | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const [ks, metrics, budgetResp] = await Promise.all([
          fetch('/api/killswitch/status').then((r) => r.json() as Promise<KillswitchStatus>).catch(() => ({ running: [] as KillswitchStatus['running'] })),
          fetch(`/api/workspaces/${workspaceId}/metrics`).then((r) => r.json()).catch(() => ({ agents: [] })),
          fetch(`/api/workspaces/${workspaceId}/budget`).then((r) => r.json()).catch(() => null),
        ]);
        setRunning(ks.running?.length ?? 0);
        const agents = (metrics.agents ?? []) as AgentStats[];
        const live = agents.filter((a) => a.status !== 'retired');
        setActiveAgents(live.length);
        setTokens(live.reduce((s, a) => s + (a.tokensIn ?? 0) + (a.tokensOut ?? 0), 0));
        setUsd(live.reduce((s, a) => s + (a.usd ?? 0), 0));
        if (budgetResp?.usage) setBudget(budgetResp);
      } catch {}
    };
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [workspaceId]);

  function budgetTint(pct: number | null): 'idle' | 'live' | 'warn' | 'err' {
    if (pct === null) return 'idle';
    if (pct >= 90) return 'err';
    if (pct >= 60) return 'warn';
    return 'live';
  }

  const dailyPct = budget?.config.dailyUsdCap ? (budget.usage.todayUsd / budget.config.dailyUsdCap) * 100 : null;
  const tokenPct = budget?.config.tokensPer5hCap ? (budget.usage.tokens5h / budget.config.tokensPer5hCap) * 100 : null;

  function openPalette() {
    window.dispatchEvent(new CustomEvent('guideai:open-palette'));
  }

  return (
    <header className="relative z-30 h-12 border-b border-line/70 flex items-center px-4 gap-4 glass shadow-soft">
      {/* workspace switcher */}
      <div className="flex items-center gap-2 text-xs text-dim">
        <span className="uppercase tracking-wider text-dim2">Project</span>
        <WorkspaceSwitcher />
      </div>

      {/* HUD meters */}
      <div className="flex items-center gap-3 ml-2">
        <Meter
          icon={<Activity size={12} />}
          label="agents"
          value={`${activeAgents}`}
          accent={running > 0 ? 'live' : 'idle'}
          tail={running > 0 ? <LivePulse /> : null}
        />
        <Meter
          icon={<Zap size={12} />}
          label="tokens"
          value={tokens.toLocaleString()}
        />
        <Meter
          icon={<DollarSign size={12} />}
          label="spend"
          value={fmtUsd(usd)}
        />
        {budget && (
          <Meter
            icon={<Wallet size={12} />}
            label="today"
            value={dailyPct !== null
              ? `${fmtUsd(budget.usage.todayUsd)} / ${fmtUsd(budget.config.dailyUsdCap!)}`
              : fmtUsd(budget.usage.todayUsd)}
            accent={budgetTint(dailyPct) as any}
          />
        )}
        {budget && budget.config.tokensPer5hCap && (
          <Meter
            icon={<Gauge size={12} />}
            label="5h"
            value={`${budget.usage.tokens5h.toLocaleString()} / ${budget.config.tokensPer5hCap.toLocaleString()}`}
            accent={budgetTint(tokenPct) as any}
          />
        )}
        {running > 0 && (
          <Meter
            icon={<Skull size={12} />}
            label="running"
            value={`${running}`}
            accent="warn"
            tail={<LivePulse color="bg-warn" />}
          />
        )}
      </div>

      {/* spacer */}
      <div className="flex-1" />

      {/* search / command */}
      <button
        onClick={openPalette}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-line/40 hover:bg-line border border-line/70 text-dim hover:text-ink transition-colors text-xs group"
      >
        <Search size={12} />
        <span>Search</span>
        <kbd className="ml-3 px-1.5 py-0.5 rounded bg-bg/80 border border-line/70 text-[10px] font-mono group-hover:text-ink">⌘K</kbd>
      </button>
    </header>
  );
}

function Meter({
  icon, label, value, accent = 'idle', tail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: 'idle' | 'live' | 'warn' | 'err';
  tail?: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-mono',
      accent === 'idle' && 'border-line/70 text-dim',
      accent === 'live' && 'border-accent/40 text-accent bg-accent/[0.04]',
      accent === 'warn' && 'border-warn/40 text-warn bg-warn/[0.04]',
      accent === 'err'  && 'border-err/40 text-err bg-err/[0.06]',
    )}>
      {icon}
      <span className="text-dim2 text-[10px] uppercase tracking-wider">{label}</span>
      <span className="text-ink">{value}</span>
      {tail}
    </div>
  );
}

function LivePulse({ color = 'bg-accent' }: { color?: string }) {
  return (
    <span className={cn('inline-block w-1.5 h-1.5 rounded-full pulse-dot', color)} />
  );
}
