'use client';

import { useEffect, useState } from 'react';
import {
  Wallet, Gauge, AlertTriangle, Save, RefreshCw, Pause, ArrowDownToLine, Megaphone,
} from 'lucide-react';
import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

type Behavior = 'warn' | 'downgrade' | 'pause';

interface BudgetConfig {
  workspaceId: string;
  dailyUsdCap?: number;
  monthlyUsdCap?: number;
  tokensPer5hCap?: number;
  behavior: Behavior;
}

interface Usage {
  todayUsd: number;
  monthUsd: number;
  tokens5h: number;
  lastTs: number | null;
  windowResetTs: number;
}

const BEHAVIOR_META: Record<Behavior, { label: string; description: string; icon: React.ComponentType<{ size?: number; className?: string }>; tint: string }> = {
  warn:      { label: 'Warn',      description: 'Proceed but emit a warning when over a cap.',                                icon: Megaphone,       tint: 'border-warn/40 text-warn bg-warn/10' },
  downgrade: { label: 'Downgrade', description: 'Drop one model tier (opus → sonnet → haiku) until it fits, then pause.',     icon: ArrowDownToLine, tint: 'border-info/40 text-info bg-info/10' },
  pause:     { label: 'Pause',     description: 'Stop the pipeline immediately. You resume manually or wait for the window.', icon: Pause,           tint: 'border-err/40 text-err bg-err/10' },
};

function fmtUsd(n: number) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function BudgetSection() {
  const workspaceId = useWorkspaceId();
  const [cfg, setCfg] = useState<BudgetConfig | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/budget`);
    if (r.ok) {
      const j = await r.json();
      setCfg(j.config);
      setUsage(j.usage);
    }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [workspaceId]);

  async function save() {
    if (!cfg) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/budget`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dailyUsdCap:    cfg.dailyUsdCap   ?? null,
          monthlyUsdCap:  cfg.monthlyUsdCap ?? null,
          tokensPer5hCap: cfg.tokensPer5hCap ?? null,
          behavior:       cfg.behavior,
        }),
      });
      if (!r.ok) throw new Error('save failed');
      const j = await r.json();
      setCfg(j.config); setUsage(j.usage);
      toast({ title: 'Budget saved', variant: 'success' });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message, variant: 'error' });
    } finally { setBusy(false); }
  }

  if (!cfg || !usage) {
    return (
      <section>
        <div className="text-ink font-medium text-sm mb-3">Budget & rate limits</div>
        <div className="h-24 shimmer bg-line/20 rounded" />
      </section>
    );
  }

  const dailyPct = cfg.dailyUsdCap ? Math.min(100, (usage.todayUsd / cfg.dailyUsdCap) * 100) : 0;
  const monthPct = cfg.monthlyUsdCap ? Math.min(100, (usage.monthUsd / cfg.monthlyUsdCap) * 100) : 0;
  const tokenPct = cfg.tokensPer5hCap ? Math.min(100, (usage.tokens5h / cfg.tokensPer5hCap) * 100) : 0;

  const barClass = (pct: number) => cn(
    'h-1.5 rounded-full transition-all',
    pct < 60 ? 'bg-accent' : pct < 90 ? 'bg-warn' : 'bg-err',
  );

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Wallet size={14} className="text-accent" />
        <span className="text-ink font-medium text-sm">Budget & rate limits</span>
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1"><RefreshCw size={11} /> refresh</button>
      </div>

      {/* Live ledger */}
      <div className="border border-line/70 rounded-lg bg-surface2/50 overflow-hidden mb-4">
        <div className="p-4 grid md:grid-cols-3 gap-4">
          <Meter
            icon={<Gauge size={12} />}
            label="Today"
            value={fmtUsd(usage.todayUsd)}
            cap={cfg.dailyUsdCap ? fmtUsd(cfg.dailyUsdCap) : 'no cap'}
            pct={dailyPct} barClass={barClass(dailyPct)}
          />
          <Meter
            icon={<Gauge size={12} />}
            label="This 30d"
            value={fmtUsd(usage.monthUsd)}
            cap={cfg.monthlyUsdCap ? fmtUsd(cfg.monthlyUsdCap) : 'no cap'}
            pct={monthPct} barClass={barClass(monthPct)}
          />
          <Meter
            icon={<Gauge size={12} />}
            label="5h tokens"
            value={usage.tokens5h.toLocaleString()}
            cap={cfg.tokensPer5hCap ? cfg.tokensPer5hCap.toLocaleString() : 'no cap'}
            pct={tokenPct} barClass={barClass(tokenPct)}
            hint={usage.windowResetTs > Date.now() ? `window resets ${new Date(usage.windowResetTs).toLocaleTimeString()}` : undefined}
          />
        </div>
      </div>

      {/* Caps form */}
      <div className="border border-line/70 rounded-lg bg-surface2/50 overflow-hidden">
        <div className="p-4 grid md:grid-cols-3 gap-3">
          <Field label="Daily $ cap" hint="Leave blank for no cap.">
            <input
              type="number"
              step="0.01"
              value={cfg.dailyUsdCap ?? ''}
              onChange={(e) => setCfg({ ...cfg, dailyUsdCap: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="—"
              className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
            />
          </Field>
          <Field label="Monthly (30d) $ cap" hint="Rolling 30 days.">
            <input
              type="number"
              step="0.01"
              value={cfg.monthlyUsdCap ?? ''}
              onChange={(e) => setCfg({ ...cfg, monthlyUsdCap: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="—"
              className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
            />
          </Field>
          <Field label="Tokens / 5h window" hint="Claude Pro defaults around 140k.">
            <input
              type="number"
              value={cfg.tokensPer5hCap ?? ''}
              onChange={(e) => setCfg({ ...cfg, tokensPer5hCap: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="140000"
              className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
            />
          </Field>
        </div>

        {/* Behavior radio */}
        <div className="p-4 border-t border-line/40">
          <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2">When a cap is about to be hit</div>
          <div className="grid md:grid-cols-3 gap-2">
            {(['warn', 'downgrade', 'pause'] as Behavior[]).map((b) => {
              const meta = BEHAVIOR_META[b];
              const Icon = meta.icon;
              const active = cfg.behavior === b;
              return (
                <button
                  key={b}
                  onClick={() => setCfg({ ...cfg, behavior: b })}
                  className={cn(
                    'text-left rounded-md border p-3 transition-all',
                    active ? 'border-accent/60 bg-accent/[0.06] shadow-glow' : 'border-line/70 bg-bg/30 hover:border-line2',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon size={14} className={active ? 'text-accent' : 'text-dim'} />
                    <span className={cn('font-medium text-sm', active ? 'text-ink' : 'text-ink2')}>{meta.label}</span>
                    {active && <span className="ml-auto text-[10px] uppercase tracking-wider text-accent">selected</span>}
                  </div>
                  <div className="text-dim text-[11px] mt-1">{meta.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-3 border-t border-line/40 flex items-center justify-end gap-2 bg-bg/40">
          <button
            onClick={save}
            disabled={busy}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
              'bg-accent text-bg shadow-glow hover:brightness-110 disabled:opacity-40',
            )}
          >
            <Save size={12} /> {busy ? 'saving…' : 'save budget'}
          </button>
        </div>
      </div>

      <div className="mt-2 text-dim2 text-[10px] flex items-center gap-1">
        <AlertTriangle size={10} /> Caps apply to this project only · usage history persists in <code className="font-mono text-ink2">usage_log</code> on disk.
      </div>
    </section>
  );
}

function Meter({ icon, label, value, cap, pct, barClass, hint }: { icon: React.ReactNode; label: string; value: string; cap: string; pct: number; barClass: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-dim2">{icon}</span>
        <span className="text-dim2 text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="font-mono text-ink text-lg">{value}</div>
      <div className="text-dim2 text-[11px] font-mono">/ {cap}</div>
      <div className="mt-2 h-1.5 bg-line/40 rounded-full overflow-hidden">
        <div className={barClass} style={{ width: `${pct}%` }} />
      </div>
      {hint && <div className="text-warn text-[10px] mt-1">{hint}</div>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-ink text-xs font-medium mb-1">{label}</div>
      {children}
      {hint && <div className="text-dim2 text-[10px] mt-1">{hint}</div>}
    </div>
  );
}
