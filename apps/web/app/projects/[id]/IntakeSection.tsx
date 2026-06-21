'use client';

import { useEffect, useState } from 'react';
import {
  Target, Compass, ShieldAlert, Coins, Users, Briefcase, FolderTree,
  Plus, X, Sparkles, Play, Check, AlertTriangle, RefreshCw, Lightbulb,
  Wand2, Hand, ScanLine, UserCheck, UsersRound, Bot,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

type PlanningMode = 'auto' | 'assisted' | 'manual';
type HireMode = 'auto' | 'manual' | 'hybrid';

type BudgetUnit = 'USD' | 'EUR' | 'GBP' | 'INR' | 'JPY' | 'tokens';
type Currency = Exclude<BudgetUnit, 'tokens'>;

const CURRENCY_OPTIONS: { value: Currency; label: string; symbol: string }[] = [
  { value: 'USD', label: 'USD ($)', symbol: '$' },
  { value: 'EUR', label: 'EUR (€)', symbol: '€' },
  { value: 'GBP', label: 'GBP (£)', symbol: '£' },
  { value: 'INR', label: 'INR (₹)', symbol: '₹' },
  { value: 'JPY', label: 'JPY (¥)', symbol: '¥' },
];

interface IntakeRecord {
  workspaceId: string;
  goal: string;
  successCriteria: string[];
  constraints: string[];
  budgetHintUsd: number | null;
  budgetHintUnit: BudgetUnit;
  planningMode: PlanningMode;
  hireMode: HireMode;
}

interface PanelEntry {
  role: string;
  displayName: string;
  lens: string;
  tier: string;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  failed?: boolean;
  error?: string;
}

interface Synthesis {
  recommendedRoles: string[];
  riskFlags: string[];
  successMetrics: string[];
  costEstimateUsd: number | null;
  costVerdict: 'within-budget' | 'tight' | 'over-budget' | 'unknown';
  securityTag: 'required' | 'recommended' | 'not-needed' | 'unknown';
  benefits: string[];
  summary: string;
}

interface DiscoveryRec {
  id: string;
  status: 'running' | 'done' | 'failed';
  panel: PanelEntry[];
  synthesis: Synthesis | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
}

const PLANNING_MODES: { id: PlanningMode; label: string; description: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'auto',     label: 'Auto',     description: 'Round-table runs, synthesis becomes the brief, pipeline starts.',                       icon: Wand2 },
  { id: 'assisted', label: 'Assisted', description: 'Round-table runs; you review + edit the synthesis before kicking off implementation.', icon: ScanLine },
  { id: 'manual',   label: 'Manual',   description: 'Skip the round-table. Write the brief yourself in the Ops tab.',                       icon: Hand },
];

const HIRE_MODES: { id: HireMode; label: string; description: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'auto',   label: 'Auto',   description: 'Hire every recommended role automatically.',                       icon: Bot },
  { id: 'hybrid', label: 'Hybrid', description: 'Hire safe defaults; ask before anything specialised or costly.',   icon: UsersRound },
  { id: 'manual', label: 'Manual', description: 'You approve each hire from the marketplace.',                      icon: UserCheck },
];

function fmtUsd(n: number | null | undefined) {
  if (n == null) return '—';
  if (n < 0.01 && n !== 0) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

const VERDICT_TINT: Record<Synthesis['costVerdict'], string> = {
  'within-budget': 'border-accent/40 text-accent bg-accent/10',
  'tight':         'border-warn/40 text-warn bg-warn/10',
  'over-budget':   'border-err/40 text-err bg-err/10',
  'unknown':       'border-line/70 text-dim',
};

export function IntakeSection({ workspaceId }: { workspaceId: string }) {
  const [intake, setIntake] = useState<IntakeRecord | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryRec | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [criteriaDraft, setCriteriaDraft] = useState('');
  const [constraintDraft, setConstraintDraft] = useState('');
  /** Local filesystem path where the agents write code. Stored on the
   *  workspace meta (separate endpoint), not the intake row. */
  const [targetFolder, setTargetFolder] = useState('');
  /** Remember the currency choice when toggling to tokens, so toggling back restores it. */
  const [lastCurrency, setLastCurrency] = useState<Currency>('USD');

  async function refresh() {
    const [r, rMeta] = await Promise.all([
      fetch(`/api/workspaces/${workspaceId}/intake`),
      fetch(`/api/workspaces/${workspaceId}/meta`),
    ]);
    if (r.ok) {
      const j = await r.json();
      setIntake(j.intake);
      setDiscovery(j.latestDiscovery);
      if (j.intake?.budgetHintUnit && j.intake.budgetHintUnit !== 'tokens') {
        setLastCurrency(j.intake.budgetHintUnit);
      }
    }
    if (rMeta.ok) {
      const m = await rMeta.json();
      setTargetFolder(m?.targetFolder ?? '');
    }
  }
  useEffect(() => { refresh(); }, [workspaceId]);

  async function save() {
    if (!intake) return;
    setBusy(true);
    try {
      // Two writes: intake fields → /intake, project folder → workspace meta.
      const [r, rMeta] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/intake`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            goal: intake.goal,
            successCriteria: intake.successCriteria,
            constraints: intake.constraints,
            budgetHintUsd: intake.budgetHintUsd,
            budgetHintUnit: intake.budgetHintUnit,
            planningMode: intake.planningMode,
            hireMode: intake.hireMode,
          }),
        }),
        fetch(`/api/workspaces/${workspaceId}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetFolder: targetFolder.trim() }),
        }),
      ]);
      if (!r.ok) throw new Error('intake save failed');
      if (!rMeta.ok) throw new Error('folder save failed');
      const j = await r.json();
      setIntake(j.intake);
      toast({ title: 'Intake saved', variant: 'success' });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message, variant: 'error' });
    } finally { setBusy(false); }
  }

  async function runRoundTable() {
    if (!intake?.goal.trim()) {
      toast({ title: 'Set a goal first', variant: 'warn' });
      return;
    }
    setRunning(true);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/discovery`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'discovery failed');
      setDiscovery(j.discovery);
      toast({ title: 'Discovery complete', description: `${j.discovery.panel.length} panelists weighed in`, variant: 'success' });
    } catch (e: any) {
      toast({ title: 'Discovery failed', description: e?.message, variant: 'error' });
    } finally { setRunning(false); }
  }

  if (!intake) {
    return (
      <section>
        <SectionHeader title="Project intake" icon={<Compass size={14} className="text-accent" />} />
        <div className="h-32 shimmer bg-line/20 rounded-lg" />
      </section>
    );
  }

  function addCriterion() {
    if (!intake) return;
    const v = criteriaDraft.trim();
    if (!v) return;
    setIntake({ ...intake, successCriteria: [...intake.successCriteria, v] });
    setCriteriaDraft('');
  }
  function addConstraint() {
    if (!intake) return;
    const v = constraintDraft.trim();
    if (!v) return;
    setIntake({ ...intake, constraints: [...intake.constraints, v] });
    setConstraintDraft('');
  }

  return (
    <section className="space-y-5">
      <SectionHeader
        title="Project intake & discovery"
        icon={<Compass size={14} className="text-accent" />}
        right={
          <button
            onClick={refresh}
            className="text-dim2 hover:text-ink text-xs flex items-center gap-1"
          >
            <RefreshCw size={11} /> refresh
          </button>
        }
      />

      {/* Intake form */}
      <div className="border border-line/70 rounded-lg bg-surface2/50 overflow-hidden">
        <div className="p-4 space-y-4">
          {/* Goal */}
          <Field
            icon={<Target size={12} />}
            label="Goal"
            hint="A one-paragraph description of what you want this project to do."
          >
            <textarea
              value={intake.goal}
              onChange={(e) => setIntake({ ...intake, goal: e.target.value })}
              placeholder="Build a customer-facing onboarding flow that…"
              rows={3}
              className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60 resize-none"
            />
          </Field>

          {/* Project folder — where agents write code on this machine */}
          <Field
            icon={<FolderTree size={12} />}
            label="Project folder"
            hint="Local filesystem path where agents write code. Opening this folder in VS Code reconnects the project. Leave empty for a sandboxed scratch dir."
          >
            <input
              type="text"
              value={targetFolder}
              onChange={(e) => setTargetFolder(e.target.value)}
              placeholder="/home/you/projects/this-project"
              className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink font-mono outline-none focus:border-accent/60"
            />
          </Field>

          {/* Success criteria */}
          <Field
            icon={<Check size={12} />}
            label="Success criteria"
            hint="What does done look like? Add one bullet at a time."
          >
            <Chips
              items={intake.successCriteria}
              onRemove={(i) => setIntake({ ...intake, successCriteria: intake.successCriteria.filter((_, j) => j !== i) })}
            />
            <ChipInput
              value={criteriaDraft}
              onChange={setCriteriaDraft}
              onSubmit={addCriterion}
              placeholder="e.g. user can finish in under 2 minutes"
            />
          </Field>

          {/* Constraints */}
          <Field
            icon={<AlertTriangle size={12} />}
            label="Constraints"
            hint="Hard limits the team has to respect."
          >
            <Chips
              items={intake.constraints}
              onRemove={(i) => setIntake({ ...intake, constraints: intake.constraints.filter((_, j) => j !== i) })}
            />
            <ChipInput
              value={constraintDraft}
              onChange={setConstraintDraft}
              onSubmit={addConstraint}
              placeholder="e.g. must run offline; ship by Friday"
            />
          </Field>

          {/* Budget hint */}
          <Field
            icon={<Coins size={12} />}
            label="Budget hint"
            hint={intake.budgetHintUnit === 'tokens'
              ? 'Total tokens (input + output) the team should plan within. We add ~30% buffer for retries.'
              : 'A ceiling the team should keep in mind. We add ~30% buffer for retries — plan blocks if estimated cost exceeds this.'}
          >
            {/* Currency / Tokens toggle */}
            <div className="inline-flex rounded-md border border-line/70 bg-bg/40 p-0.5 mb-2 text-xs">
              <button
                type="button"
                onClick={() => setIntake({ ...intake, budgetHintUnit: lastCurrency })}
                className={cn(
                  'px-3 py-1 rounded transition-colors',
                  intake.budgetHintUnit !== 'tokens'
                    ? 'bg-accent text-bg font-medium shadow-glow'
                    : 'text-dim2 hover:text-ink',
                )}
              >
                Currency
              </button>
              <button
                type="button"
                onClick={() => {
                  // Remember the currency before switching to tokens.
                  if (intake.budgetHintUnit !== 'tokens') setLastCurrency(intake.budgetHintUnit as Currency);
                  setIntake({ ...intake, budgetHintUnit: 'tokens' });
                }}
                className={cn(
                  'px-3 py-1 rounded transition-colors',
                  intake.budgetHintUnit === 'tokens'
                    ? 'bg-accent text-bg font-medium shadow-glow'
                    : 'text-dim2 hover:text-ink',
                )}
              >
                Tokens
              </button>
            </div>
            <div className="flex items-center gap-2">
              {intake.budgetHintUnit === 'tokens' ? (
                <input
                  type="number"
                  step="1"
                  min={0}
                  value={intake.budgetHintUsd != null ? intake.budgetHintUsd / 1000 : ''}
                  onChange={(e) => setIntake({
                    ...intake,
                    // UI is in k-units; store the actual token count (×1000) so
                    // downstream math + LLM prompts see real token numbers.
                    budgetHintUsd: e.target.value === '' ? null : Number(e.target.value) * 1000,
                  })}
                  placeholder="100"
                  className="w-32 bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
                />
              ) : (
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={intake.budgetHintUsd ?? ''}
                  onChange={(e) => setIntake({ ...intake, budgetHintUsd: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder="—"
                  className="w-40 bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
                />
              )}
              {intake.budgetHintUnit !== 'tokens' ? (
                <select
                  value={intake.budgetHintUnit}
                  onChange={(e) => {
                    const cur = e.target.value as Currency;
                    setLastCurrency(cur);
                    setIntake({ ...intake, budgetHintUnit: cur });
                  }}
                  className="bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink outline-none focus:border-accent/60"
                >
                  {CURRENCY_OPTIONS.map((u) => (
                    <option key={u.value} value={u.value}>{u.label}</option>
                  ))}
                </select>
              ) : (
                <span className="text-dim text-[12px] font-mono px-2 py-1.5 rounded-md border border-line/40 bg-bg/30">k tokens</span>
              )}
              {intake.budgetHintUnit === 'tokens' && intake.budgetHintUsd != null && intake.budgetHintUsd > 0 && (
                <span className="text-dim2 text-[10px] font-mono">= {intake.budgetHintUsd.toLocaleString()} tokens</span>
              )}
              <span className="text-dim2 text-[10px] ml-auto">leave blank = no limit</span>
            </div>
          </Field>

          {/* Planning mode */}
          <Field icon={<Sparkles size={12} />} label="Planning mode" hint="How the discovery round-table is used.">
            <div className="grid md:grid-cols-3 gap-2">
              {PLANNING_MODES.map((m) => {
                const Icon = m.icon;
                const active = intake.planningMode === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setIntake({ ...intake, planningMode: m.id })}
                    className={cn(
                      'text-left rounded-md border p-3 transition-all',
                      active ? 'border-accent/60 bg-accent/[0.06] shadow-glow' : 'border-line/70 bg-bg/30 hover:border-line2',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon size={14} className={active ? 'text-accent' : 'text-dim'} />
                      <span className={cn('font-medium text-sm', active ? 'text-ink' : 'text-ink2')}>{m.label}</span>
                      {active && <span className="ml-auto text-[10px] uppercase tracking-wider text-accent">selected</span>}
                    </div>
                    <div className="text-dim text-[11px] mt-1">{m.description}</div>
                  </button>
                );
              })}
            </div>
          </Field>

          {/* Hire mode */}
          <Field icon={<Users size={12} />} label="Hiring mode" hint="How recommended roles get added to the roster.">
            <div className="grid md:grid-cols-3 gap-2">
              {HIRE_MODES.map((m) => {
                const Icon = m.icon;
                const active = intake.hireMode === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setIntake({ ...intake, hireMode: m.id })}
                    className={cn(
                      'text-left rounded-md border p-3 transition-all',
                      active ? 'border-accent/60 bg-accent/[0.06] shadow-glow' : 'border-line/70 bg-bg/30 hover:border-line2',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon size={14} className={active ? 'text-accent' : 'text-dim'} />
                      <span className={cn('font-medium text-sm', active ? 'text-ink' : 'text-ink2')}>{m.label}</span>
                      {active && <span className="ml-auto text-[10px] uppercase tracking-wider text-accent">selected</span>}
                    </div>
                    <div className="text-dim text-[11px] mt-1">{m.description}</div>
                  </button>
                );
              })}
            </div>
          </Field>
        </div>

        {/* Footer actions */}
        <div className="p-3 border-t border-line/40 flex items-center justify-end gap-2 bg-bg/40">
          <button
            disabled={busy}
            onClick={save}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-line/70 text-ink2 hover:text-ink hover:border-line2 text-xs font-medium disabled:opacity-40"
          >
            {busy ? 'saving…' : 'save intake'}
          </button>
          <button
            disabled={running || intake.planningMode === 'manual'}
            onClick={runRoundTable}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium shadow-glow disabled:opacity-40',
              'bg-accent text-bg hover:brightness-110',
            )}
            title={intake.planningMode === 'manual' ? 'Switch to auto/assisted to use the round-table' : ''}
          >
            <Play size={11} /> {running ? 'panel discussing…' : 'run discovery round-table'}
          </button>
        </div>
      </div>

      {/* Discovery viewer */}
      {discovery && (
        <DiscoveryView record={discovery} />
      )}
      {!discovery && intake.planningMode !== 'manual' && (
        <div className="border border-dashed border-line/70 rounded-lg p-4 text-dim2 text-xs italic">
          No round-table yet — save the intake, then click <span className="text-ink">run discovery</span> to hear from the 5-agent panel.
        </div>
      )}
    </section>
  );
}

function DiscoveryView({ record }: { record: DiscoveryRec }) {
  const syn = record.synthesis;
  return (
    <div className="space-y-3">
      {/* Synthesis card */}
      {syn && (
        <div className="border border-accent/30 rounded-lg p-4 bg-accent/[0.04] shadow-glow">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb size={14} className="text-accent" />
            <span className="text-ink font-medium text-sm">Synthesized recommendation</span>
            <span className="ml-auto text-dim2 text-[10px] font-mono">{record.id}</span>
          </div>
          <p className="text-ink2 text-sm leading-relaxed mb-3">{syn.summary}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <SynStat
              icon={<Briefcase size={11} />}
              label="hire"
              value={`${syn.recommendedRoles.length} roles`}
            />
            <SynStat
              icon={<Coins size={11} />}
              label="ballpark"
              value={fmtUsd(syn.costEstimateUsd)}
              tint={VERDICT_TINT[syn.costVerdict]}
              extra={syn.costVerdict}
            />
            <SynStat
              icon={<ShieldAlert size={11} />}
              label="risks flagged"
              value={syn.riskFlags.length.toString()}
            />
            <SynStat
              icon={<Check size={11} />}
              label="metrics"
              value={syn.successMetrics.length.toString()}
            />
          </div>

          {/* Recommended roles */}
          {syn.recommendedRoles.length > 0 && (
            <SynRow label="Recommended roles">
              <div className="flex flex-wrap gap-1.5">
                {syn.recommendedRoles.map((r) => (
                  <span key={r} className="font-mono text-[11px] px-2 py-0.5 rounded-full border border-info/40 text-info bg-info/10">{r}</span>
                ))}
              </div>
            </SynRow>
          )}

          {/* Risks */}
          {syn.riskFlags.length > 0 && (
            <SynRow label="Risks">
              <ul className="text-dim text-[12.5px] space-y-1 list-disc list-inside marker:text-warn">
                {syn.riskFlags.slice(0, 8).map((r, i) => (<li key={i} className="text-ink2"><span>{r}</span></li>))}
              </ul>
            </SynRow>
          )}

          {/* Metrics */}
          {syn.successMetrics.length > 0 && (
            <SynRow label="Success metrics">
              <ul className="text-dim text-[12.5px] space-y-1 list-disc list-inside marker:text-accent">
                {syn.successMetrics.slice(0, 6).map((r, i) => (<li key={i} className="text-ink2"><span>{r}</span></li>))}
              </ul>
            </SynRow>
          )}

          <div className="text-dim2 text-[10px] mt-3 flex items-center gap-3 flex-wrap font-mono">
            <span>{record.tokensIn.toLocaleString()}↓ / {record.tokensOut.toLocaleString()}↑ tokens</span>
            <span>{fmtUsd(record.costUsd)} cost</span>
            <span>security: {syn.securityTag}</span>
            {record.endedAt && <span>completed {new Date(record.endedAt).toLocaleTimeString()}</span>}
          </div>
        </div>
      )}

      {/* Panelists */}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {record.panel.map((p) => (
          <article
            key={p.role}
            className={cn(
              'rounded-lg border p-3 bg-surface2/50 overflow-hidden',
              p.failed ? 'border-err/40' : 'border-line/70',
            )}
          >
            <header className="flex items-center gap-2 mb-2">
              <span className="w-7 h-7 rounded-md bg-line/60 border border-line/70 flex items-center justify-center text-accent text-[11px] font-semibold">
                {initials(p.displayName)}
              </span>
              <div className="min-w-0">
                <div className="text-ink text-sm font-medium truncate">{p.displayName}</div>
                <div className="text-dim2 text-[10px] truncate">{p.lens}</div>
              </div>
              <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-line/70 text-dim">{p.tier}</span>
            </header>
            {p.failed ? (
              <div className="text-err text-[11px]">failed: {p.error}</div>
            ) : (
              <pre className="text-[12px] text-ink2 whitespace-pre-wrap leading-relaxed font-mono break-words">{p.text || '(no output)'}</pre>
            )}
            <footer className="text-dim2 text-[10px] mt-2 flex items-center gap-2 font-mono">
              <span>{p.tokensIn}↓/{p.tokensOut}↑</span>
              <span>·</span>
              <span>{fmtUsd(p.costUsd)}</span>
              <span>·</span>
              <span>{Math.round(p.durationMs)}ms</span>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function SynStat({ icon, label, value, tint, extra }: { icon: React.ReactNode; label: string; value: string; tint?: string; extra?: string }) {
  return (
    <div className={cn('border rounded-md px-2 py-1.5', tint ?? 'border-line/70')}>
      <div className="flex items-center gap-1 text-dim2 text-[10px] uppercase tracking-wider">{icon}{label}</div>
      <div className="text-ink font-mono text-sm mt-0.5">{value}</div>
      {extra && <div className="text-[10px] uppercase tracking-wider mt-0.5">{extra}</div>}
    </div>
  );
}
function SynRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1">{label}</div>
      {children}
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

function SectionHeader({ title, icon, right }: { title: string; icon: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-ink font-medium text-sm">{title}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

function Field({ icon, label, hint, children }: { icon: React.ReactNode; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-dim2">{icon}</span>
        <span className="text-ink text-xs font-medium">{label}</span>
      </div>
      {children}
      {hint && <div className="text-dim2 text-[10px] mt-1.5">{hint}</div>}
    </div>
  );
}

function Chips({ items, onRemove }: { items: string[]; onRemove: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {items.map((c, i) => (
        <span
          key={`${i}-${c}`}
          className="group inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full border border-line/70 bg-bg/40 text-ink2"
        >
          {c}
          <button
            onClick={() => onRemove(i)}
            className="opacity-50 hover:opacity-100 hover:text-err transition-opacity"
            title="remove"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}

function ChipInput({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder?: string }) {
  return (
    <div className="flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
        placeholder={placeholder}
        className="flex-1 bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink outline-none focus:border-accent/60"
      />
      <button
        onClick={onSubmit}
        disabled={!value.trim()}
        className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-ink2 border border-line/70 hover:border-line2 hover:text-ink disabled:opacity-40"
      >
        <Plus size={11} /> add
      </button>
    </div>
  );
}
