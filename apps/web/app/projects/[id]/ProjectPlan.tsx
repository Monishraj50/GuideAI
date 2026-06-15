'use client';

import { useEffect, useState } from 'react';
import {
  Users, FileText, ShieldAlert, Coins, Sparkles, Activity, Check, X, ArrowRight, Play, RadioTower, Store, Network,
} from 'lucide-react';
import { useWorkspace } from '../../../components/WorkspaceProvider';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';
import { IntakeSection } from './IntakeSection';
import { PlanReview } from './PlanReview';
import { Dashboard } from './Dashboard';
import { Deliverables } from './Deliverables';
import { RepoSection } from './RepoSection';
import { Validation } from './Validation';

interface PlanResp {
  workspace: { id: string; name: string; autonomyMode: string; createdAt: number };
  agents: { active: number; total: number };
  pendingApprovals: { id: string; tool: string; argsJson: string; decision: string; decidedAt: number }[];
  digest: { date: string | null; text: string | null; generatedAt?: number } | null;
  briefs: {
    recent: { id: string; body: string; status: string; createdAt: number; tasks: number; tokens: number }[];
    total: number;
    active: number;
  };
  tokens: number;
  usd: number;
  recentChunks: any[];
}

function fmtUsd(n: number) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function ProjectPlan({ workspaceId }: { workspaceId: string }) {
  const { setActive } = useWorkspace();
  const [plan, setPlan] = useState<PlanResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    // Switching the active workspace context so other tabs follow.
    setActive(workspaceId);
  }, [workspaceId, setActive]);

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/plan`);
    if (r.ok) setPlan(await r.json());
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [workspaceId]);

  async function decide(id: string, decision: 'approved' | 'denied') {
    setActing(id);
    try {
      await fetch(`/api/approvals/${id}?workspace=${workspaceId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      toast({ title: `${decision === 'approved' ? 'Approved' : 'Denied'}`, variant: decision === 'approved' ? 'success' : 'warn' });
      await refresh();
    } finally { setActing(null); }
  }

  async function runDigest() {
    setBusy(true);
    try {
      await fetch(`/api/workspaces/${workspaceId}/digest`, { method: 'POST' });
      toast({ title: 'Digest generated', variant: 'success' });
      await refresh();
    } catch { toast({ title: 'Digest failed', variant: 'error' }); }
    finally { setBusy(false); }
  }

  if (!plan) {
    return <div className="p-5 space-y-2"><div className="h-4 w-40 shimmer bg-line/30 rounded" /><div className="h-3 w-80 shimmer bg-line/20 rounded" /></div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-6">
      {/* Hero */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1">workspace</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{plan.workspace.name}</h1>
          <div className="text-dim text-xs mt-1">created {new Date(plan.workspace.createdAt).toLocaleDateString()} · {plan.workspace.autonomyMode}</div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <HeroStat icon={<Users size={12} />} label="agents" value={plan.agents.active.toString()} />
          <HeroStat icon={<FileText size={12} />} label="briefs" value={plan.briefs.total.toString()} sub={plan.briefs.active > 0 ? `${plan.briefs.active} active` : undefined} />
          <HeroStat icon={<Coins size={12} />} label="spend" value={fmtUsd(plan.usd)} />
          <HeroStat icon={<Activity size={12} />} label="tokens" value={plan.tokens.toLocaleString()} />
        </div>
      </div>

      {/* Intake + discovery round-table */}
      <IntakeSection workspaceId={workspaceId} />

      {/* Plan review + hire dispatch */}
      <PlanReview workspaceId={workspaceId} />

      {/* Progress dashboard (WBS Kanban + burndown) */}
      <Dashboard workspaceId={workspaceId} />

      {/* Deliverables — artifacts, slide decks, explainers, links */}
      <Deliverables workspaceId={workspaceId} />

      {/* GitHub repo — push deliverables, sync WBS → issues */}
      <RepoSection workspaceId={workspaceId} />

      {/* Browser-driven validation */}
      <Validation workspaceId={workspaceId} />

      {/* Pending approvals — top of plan since they're blocking */}
      <Section
        title="Needs your approval"
        icon={<ShieldAlert size={14} className={plan.pendingApprovals.length > 0 ? 'text-warn' : 'text-dim'} />}
        count={plan.pendingApprovals.length}
      >
        {plan.pendingApprovals.length === 0 ? (
          <Empty text="Nothing waiting for you." />
        ) : (
          <ul className="divide-y divide-line/40 border border-line/70 rounded-lg bg-surface2/50 overflow-hidden">
            {plan.pendingApprovals.map((p) => {
              let args: any = {};
              try { args = JSON.parse(p.argsJson); } catch {}
              const summary = `${p.tool}(${typeof args.cmd === 'string' ? args.cmd : JSON.stringify(args)})`;
              return (
                <li key={p.id} className="p-3 flex items-center gap-3 text-xs hover:bg-line/20">
                  <span className="font-mono text-ink flex-1 truncate">{summary}</span>
                  <span className="text-dim2 text-[10px] font-mono">{p.id}</span>
                  <button
                    disabled={acting === p.id}
                    onClick={() => decide(p.id, 'approved')}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-bg text-[11px] font-medium disabled:opacity-40 hover:brightness-110"
                  >
                    <Check size={11} /> approve
                  </button>
                  <button
                    disabled={acting === p.id}
                    onClick={() => decide(p.id, 'denied')}
                    className="flex items-center gap-1 px-2 py-1 rounded-md border border-err/40 text-err text-[11px] disabled:opacity-40 hover:bg-err/10"
                  >
                    <X size={11} /> deny
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Latest digest */}
      <Section
        title="Standup digest"
        icon={<Sparkles size={14} className="text-accent" />}
        right={
          <button
            onClick={runDigest}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40 shadow-glow"
          >
            <Play size={11} /> {busy ? 'running…' : 'run now'}
          </button>
        }
      >
        {plan.digest?.text ? (
          <article className="border border-line/70 rounded-lg p-4 bg-surface2/50">
            <div className="text-dim2 text-[11px] mb-2">{plan.digest.date} · generated {plan.digest.generatedAt ? new Date(plan.digest.generatedAt).toLocaleString() : ''}</div>
            <pre className="text-[12.5px] text-ink2 font-mono whitespace-pre-wrap leading-relaxed">{plan.digest.text}</pre>
          </article>
        ) : (
          <Empty text="No digest yet. Run one to summarise the last 24h." />
        )}
      </Section>

      {/* Recent briefs */}
      <Section title="Recent briefs" icon={<FileText size={14} className="text-info" />} count={plan.briefs.total}>
        {plan.briefs.recent.length === 0 ? (
          <Empty text="No briefs yet — submit one in Ops." />
        ) : (
          <ul className="divide-y divide-line/40 border border-line/70 rounded-lg bg-surface2/50 overflow-hidden">
            {plan.briefs.recent.map((b) => (
              <li key={b.id} className="group">
                <a href={`/logs/${b.id}`} className="block px-4 py-2 hover:bg-line/20">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-dim2">{b.id}</span>
                    <span className={cn(
                      'uppercase font-mono text-[10px] px-1.5 py-0.5 rounded-full border',
                      b.status === 'done' && 'border-accent/40 text-accent bg-accent/10',
                      b.status === 'active' && 'border-warn/40 text-warn bg-warn/10',
                      b.status === 'failed' && 'border-err/40 text-err bg-err/10',
                      b.status === 'pending' && 'border-line/70 text-dim',
                    )}>{b.status}</span>
                    <span className="text-dim2 ml-auto">{new Date(b.createdAt).toLocaleString()}</span>
                    <ArrowRight size={11} className="text-dim2 group-hover:text-accent transition-colors" />
                  </div>
                  <div className="text-ink2 text-sm mt-1 truncate">{b.body}</div>
                  <div className="text-dim2 text-[10px] font-mono mt-0.5">
                    {b.tasks} phase{b.tasks === 1 ? '' : 's'} · {b.tokens.toLocaleString()} tokens
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Jump links */}
      <Section title="Project surfaces" icon={<ArrowRight size={14} className="text-dim" />}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Jump href="/ops" icon={RadioTower} label="Ops" hint="brief + feed" />
          <Jump href="/hire" icon={Store} label="Hire" hint="catalog" />
          <Jump href="/org" icon={Network} label="Org" hint="roster" />
          <Jump href="/logs" icon={FileText} label="Logs" hint="replay" />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, icon, count, children, right }: { title: string; icon: React.ReactNode; count?: number; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-ink font-medium text-sm">{title}</span>
          {count !== undefined && <span className="text-dim2 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-line/70">{count}</span>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="border border-dashed border-line/70 rounded-lg p-3 text-dim2 text-xs italic">{text}</div>;
}
function HeroStat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="border border-line/70 rounded-md px-3 py-2 bg-surface2/40 min-w-[100px]">
      <div className="flex items-center gap-1.5 text-dim2 text-[10px] uppercase tracking-wider">{icon}{label}</div>
      <div className="text-ink font-mono mt-1">{value}</div>
      {sub && <div className="text-warn text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}
function Jump({ href, icon: Icon, label, hint }: { href: string; icon: React.ComponentType<{ size?: number }>; label: string; hint: string }) {
  return (
    <a href={href} className="group flex items-center gap-2 p-3 rounded-md border border-line/70 bg-surface2/40 hover:border-line2 hover:bg-surface2/80 transition-all">
      <div className="w-7 h-7 rounded-md bg-line/40 border border-line/70 flex items-center justify-center text-dim group-hover:text-accent group-hover:border-accent/30 transition-colors">
        <Icon size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-ink text-xs">{label}</div>
        <div className="text-dim2 text-[10px]">{hint}</div>
      </div>
    </a>
  );
}
