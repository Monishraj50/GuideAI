'use client';

import { useEffect, useState } from 'react';
import { Search, ChevronDown, Activity, Zap, DollarSign, Skull } from 'lucide-react';
import { cn } from '../lib/cn';

interface CapsResp {
  caps: { concurrency: { maxAgentsPerWorkspace: number } };
}
interface KillswitchStatus { running: { agentId: string; pid: number }[] }
interface AgentStats {
  id: string;
  status: string;
  tasksCompleted: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

function fmtUsd(n: number) {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function TopBar() {
  const [running, setRunning] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [usd, setUsd] = useState(0);
  const [activeAgents, setActiveAgents] = useState(0);

  useEffect(() => {
    const refresh = async () => {
      try {
        const [ks, metrics] = await Promise.all([
          fetch('/api/killswitch/status').then((r) => r.json() as Promise<KillswitchStatus>).catch(() => ({ running: [] as KillswitchStatus['running'] })),
          fetch('/api/workspaces/demo/metrics').then((r) => r.json()).catch(() => ({ agents: [] })),
        ]);
        setRunning(ks.running?.length ?? 0);
        const agents = (metrics.agents ?? []) as AgentStats[];
        const live = agents.filter((a) => a.status !== 'retired');
        setActiveAgents(live.length);
        setTokens(live.reduce((s, a) => s + (a.tokensIn ?? 0) + (a.tokensOut ?? 0), 0));
        setUsd(live.reduce((s, a) => s + (a.usd ?? 0), 0));
      } catch {}
    };
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  function openPalette() {
    window.dispatchEvent(new CustomEvent('guideai:open-palette'));
  }

  return (
    <header className="h-12 border-b border-line/70 flex items-center px-4 gap-4 glass shadow-soft">
      {/* workspace */}
      <div className="flex items-center gap-2 text-xs text-dim">
        <span className="uppercase tracking-wider text-dim2">Workspace</span>
        <button className="flex items-center gap-1 px-2 py-1 rounded-md bg-line/40 hover:bg-line text-ink transition-colors">
          <span className="font-mono">demo</span>
          <ChevronDown size={12} />
        </button>
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
  accent?: 'idle' | 'live' | 'warn';
  tail?: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-mono',
      accent === 'idle' && 'border-line/70 text-dim',
      accent === 'live' && 'border-accent/40 text-accent bg-accent/[0.04]',
      accent === 'warn' && 'border-warn/40 text-warn bg-warn/[0.04]',
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
