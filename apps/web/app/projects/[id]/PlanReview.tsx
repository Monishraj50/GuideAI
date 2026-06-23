'use client';

import { useEffect, useState } from 'react';
import {
  ClipboardCheck, Pencil, Check, X, ArrowRight, AlertTriangle, ShieldAlert,
  Users, Coins, Lightbulb, Send, UserPlus, UserCheck, UserX, Hourglass,
  RotateCcw, ExternalLink, Scale, Wrench, Gavel, MessageSquare, Sparkles,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

type Verdict = 'within-budget' | 'tight' | 'over-budget' | 'unknown';

interface Synthesis {
  recommendedRoles: string[];
  riskFlags: string[];
  successMetrics: string[];
  benefits: string[];
  costEstimateUsd: number | null;
  costVerdict: Verdict;
  securityTag: 'required' | 'recommended' | 'not-needed' | 'unknown';
  summary: string;
}

interface HirePreview {
  role: string;
  requested: string;
  action: 'hire' | 'queue' | 'skip';
  reason?: string;
  displayName?: string;
  alreadyHired?: boolean;
}
interface HireSummary {
  hired: HirePreview[];
  queued: HirePreview[];
  skipped: HirePreview[];
  errors: { role: string; error: string }[];
}

type CritiqueVerdict = 'pass' | 'needs-revision' | 'reject';
interface SuggestedEdit { where: string; what: string }
interface Critique {
  role: 'ceo' | 'eng';
  displayName: string;
  verdict: CritiqueVerdict;
  concerns: string[];
  suggestedEdits: SuggestedEdit[];
  rawText: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  failed?: boolean;
  error?: string;
}
interface CritiqueBundle { ceo: Critique; eng: Critique; ranAt: number; blocked: boolean }

interface PlanRecord {
  id: string;
  workspaceId: string;
  discoveryId: string | null;
  status: 'draft' | 'approved' | 'dispatched' | 'rejected';
  synthesis: Synthesis;
  notes: string | null;
  briefId: string | null;
  hireSummary: HireSummary | null;
  critiques: CritiqueBundle | null;
  critiquesRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  dispatchedAt: number | null;
}

const CRITIQUE_TINT: Record<CritiqueVerdict, string> = {
  pass:             'border-accent/40 text-accent bg-accent/10',
  'needs-revision': 'border-warn/40 text-warn bg-warn/10',
  reject:           'border-err/40 text-err bg-err/10',
};
const CRITIQUE_ICONS: Record<'ceo' | 'eng', React.ComponentType<{ size?: number; className?: string }>> = {
  ceo: Scale,
  eng: Wrench,
};

const VERDICT_TINT: Record<Verdict, string> = {
  'within-budget': 'border-accent/40 text-accent bg-accent/10',
  'tight':         'border-warn/40 text-warn bg-warn/10',
  'over-budget':   'border-err/40 text-err bg-err/10',
  'unknown':       'border-line/70 text-dim',
};

const STATUS_TINT: Record<PlanRecord['status'], string> = {
  draft:      'border-line/70 text-dim',
  approved:   'border-warn/40 text-warn bg-warn/10',
  dispatched: 'border-accent/40 text-accent bg-accent/10',
  rejected:   'border-err/40 text-err bg-err/10',
};

function fmtUsd(n: number | null | undefined) {
  if (n == null) return '—';
  if (n < 0.01 && n !== 0) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function PlanReview({ workspaceId }: { workspaceId: string }) {
  const [plan, setPlan] = useState<PlanRecord | null>(null);
  const [preview, setPreview] = useState<HireSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Synthesis | null>(null);

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/plan-review/hire-preview`).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      setPlan(j.plan);
      setPreview(j.preview);
      if (!editing) setDraft(j.plan.synthesis);
    } else {
      const r2 = await fetch(`/api/workspaces/${workspaceId}/plan-review`).catch(() => null);
      if (r2 && r2.ok) {
        const j = await r2.json();
        setPlan(j.plan);
        setPreview(null);
        if (!editing) setDraft(j.plan?.synthesis ?? null);
      } else {
        setPlan(null); setPreview(null);
      }
    }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [workspaceId, editing]);

  async function createFromLatest() {
    setBusy('create');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/plan-review`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'create failed');
      toast({ title: 'Plan drafted from latest discovery', variant: 'success' });
      setPlan(j.plan); setDraft(j.plan.synthesis); await refresh();
    } catch (e: any) {
      toast({ title: 'Could not draft plan', description: e?.message, variant: 'error' });
    } finally { setBusy(null); }
  }

  async function saveDraft() {
    if (!plan || !draft) return;
    setBusy('save');
    try {
      const r = await fetch(`/api/plans/${plan.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ synthesis: draft, notes: plan.notes ?? null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'save failed');
      setPlan(j.plan); setEditing(false);
      toast({ title: 'Plan edits saved', variant: 'success' });
      await refresh();
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message, variant: 'error' });
    } finally { setBusy(null); }
  }

  async function approve(force = false) {
    if (!plan) return;
    setBusy('approve');
    try {
      const r = await fetch(`/api/plans/${plan.id}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forceDispatch: force }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'approve failed');
      setPlan(j.plan); await refresh();
      // Critic blocked the approval — surface as warn, not success.
      if (j.plan.status === 'draft' && j.plan.critiques?.blocked) {
        toast({
          title: 'Critics flagged issues',
          description: `CEO: ${j.plan.critiques.ceo.verdict} · Eng: ${j.plan.critiques.eng.verdict}`,
          variant: 'warn',
        });
        return;
      }
      // Budget blocked the approval.
      if (j.plan.status === 'draft' && j.plan.synthesis?.costVerdict === 'over-budget') {
        toast({
          title: 'Plan exceeds your budget',
          description: 'Trim scope, raise the budget, or click "force dispatch" to override.',
          variant: 'warn',
        });
        return;
      }
      toast({
        title: j.plan.status === 'dispatched'
          ? 'Plan dispatched · awaiting Start Implementing'
          : 'Plan approved — hires queued',
        description: j.plan.briefId
          ? `brief ${j.plan.briefId} — pick Auto or Manual in the panel below to begin`
          : `${j.plan.hireSummary?.queued.length ?? 0} hires need approval`,
        variant: 'success',
      });
    } catch (e: any) {
      toast({ title: 'Approve failed', description: e?.message, variant: 'error' });
    } finally { setBusy(null); }
  }

  async function recritique() {
    if (!plan) return;
    setBusy('critique');
    try {
      const r = await fetch(`/api/plans/${plan.id}/critique`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'critique failed');
      setPlan(j.plan);
      toast({
        title: 'Critics re-ran',
        description: `CEO: ${j.plan.critiques?.ceo.verdict} · Eng: ${j.plan.critiques?.eng.verdict}`,
        variant: j.plan.critiques?.blocked ? 'warn' : 'success',
      });
    } catch (e: any) {
      toast({ title: 'Critique failed', description: e?.message, variant: 'error' });
    } finally { setBusy(null); }
  }

  async function reject() {
    if (!plan) return;
    if (!confirm('Reject this plan? You can run discovery again to draft a fresh one.')) return;
    setBusy('reject');
    try {
      const r = await fetch(`/api/plans/${plan.id}/reject`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'reject failed');
      setPlan(j.plan);
      toast({ title: 'Plan rejected', variant: 'warn' });
      await refresh();
    } catch (e: any) {
      toast({ title: 'Reject failed', description: e?.message, variant: 'error' });
    } finally { setBusy(null); }
  }

  if (!plan) {
    return (
      <section className="space-y-2">
        <SectionHeader title="Plan review" icon={<ClipboardCheck size={14} className="text-accent" />} />
        <div className="border border-dashed border-line/70 rounded-lg p-4 flex items-center justify-between gap-3">
          <div className="text-dim2 text-xs italic">No plan drafted yet. Run a discovery round-table, then draft a plan from it.</div>
          <button
            onClick={createFromLatest}
            disabled={busy === 'create'}
            className="px-3 py-1.5 rounded-md bg-line/40 border border-line/70 text-ink text-xs hover:border-line2 disabled:opacity-40"
          >
            {busy === 'create' ? 'drafting…' : 'draft from latest'}
          </button>
        </div>
      </section>
    );
  }

  const isDraft = plan.status === 'draft';
  const isApproved = plan.status === 'approved';
  const isDispatched = plan.status === 'dispatched';
  const isRejected = plan.status === 'rejected';
  const syn = (editing && draft) ? draft : plan.synthesis;

  return (
    <section data-section="plan-review" className="space-y-3">
      <SectionHeader
        title="Plan review"
        icon={<ClipboardCheck size={14} className="text-accent" />}
        right={
          <div className="flex items-center gap-2">
            <span className={cn('text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded-full border', STATUS_TINT[plan.status])}>
              {plan.status}
            </span>
            <span className="text-dim2 text-[10px] font-mono">{plan.id}</span>
          </div>
        }
      />

      {/* Summary / edit panel */}
      <div className={cn('border rounded-lg p-4 bg-surface2/50',
        isDispatched ? 'border-accent/40 shadow-glow' : isRejected ? 'border-err/40' : 'border-line/70')}>
        {/* Top row: summary + controls */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            {editing && draft ? (
              <textarea
                rows={3}
                value={draft.summary}
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60 resize-none"
              />
            ) : (
              <p className="text-ink2 text-sm leading-relaxed">{syn.summary || '(no summary)'}</p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Pill icon={<Coins size={11} />} tint={VERDICT_TINT[syn.costVerdict]} text={`${fmtUsd(syn.costEstimateUsd)} · ${syn.costVerdict}`} />
              <Pill icon={<ShieldAlert size={11} />} tint={syn.securityTag === 'required' ? 'border-warn/40 text-warn bg-warn/10' : 'border-line/70 text-dim'} text={`security: ${syn.securityTag}`} />
              <Pill icon={<Users size={11} />} tint="border-line/70 text-dim" text={`${syn.recommendedRoles.length} roles`} />
            </div>
          </div>
          {isDraft && (
            <div className="flex flex-col gap-2 shrink-0">
              {!editing ? (
                <button
                  onClick={() => { setDraft(plan.synthesis); setEditing(true); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-line/70 text-ink2 text-xs hover:border-line2 hover:text-ink"
                >
                  <Pencil size={11} /> edit
                </button>
              ) : (
                <>
                  <button
                    onClick={saveDraft}
                    disabled={busy === 'save'}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40 shadow-glow"
                  >
                    <Check size={11} /> {busy === 'save' ? 'saving…' : 'save edits'}
                  </button>
                  <button
                    onClick={() => { setEditing(false); setDraft(plan.synthesis); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-dim2 text-xs hover:text-ink"
                  >
                    <X size={11} /> cancel
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Editable lists */}
        <EditableList
          icon={<UserPlus size={11} />} label="Recommended roles"
          items={syn.recommendedRoles}
          editing={editing && !!draft}
          onChange={(v) => draft && setDraft({ ...draft, recommendedRoles: v })}
          placeholder="role-name (e.g. backend-developer)"
          chipTint="border-info/40 text-info bg-info/10"
        />
        <EditableList
          icon={<Check size={11} />} label="Success metrics"
          items={syn.successMetrics}
          editing={editing && !!draft}
          onChange={(v) => draft && setDraft({ ...draft, successMetrics: v })}
          placeholder="add metric…"
          chipTint="border-accent/40 text-accent bg-accent/10"
        />
        <EditableList
          icon={<AlertTriangle size={11} />} label="Risks to watch"
          items={syn.riskFlags}
          editing={editing && !!draft}
          onChange={(v) => draft && setDraft({ ...draft, riskFlags: v })}
          placeholder="add risk…"
          chipTint="border-warn/40 text-warn bg-warn/10"
        />
        <EditableList
          icon={<Lightbulb size={11} />} label="Benefits"
          items={syn.benefits}
          editing={editing && !!draft}
          onChange={(v) => draft && setDraft({ ...draft, benefits: v })}
          placeholder="add benefit…"
          chipTint="border-line/70 text-ink2 bg-bg/30"
        />

        {/* Critique panel */}
        {(plan.critiques || isDraft) && (
          <div className="mt-4 border-t border-line/40 pt-3">
            <div className="flex items-center gap-2 mb-2">
              <Gavel size={11} className="text-warn" />
              <span className="text-dim2 text-[10px] uppercase tracking-wider">Critic pass</span>
              {plan.critiques && (
                <span className="text-dim2 text-[10px] font-mono">
                  ran {new Date(plan.critiques.ranAt).toLocaleTimeString()}
                </span>
              )}
              {plan.critiques?.blocked && (
                <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border border-warn/40 text-warn bg-warn/10">blocked</span>
              )}
              <button
                onClick={recritique}
                disabled={busy === 'critique'}
                className="ml-auto text-dim2 hover:text-ink text-[11px] flex items-center gap-1 disabled:opacity-40"
                title="Re-run CEO + Eng critics against the current synthesis"
              >
                <Sparkles size={10} /> {busy === 'critique' ? 'critiquing…' : (plan.critiques ? 're-run' : 'run critics')}
              </button>
            </div>
            {plan.critiques ? (
              <div className="grid md:grid-cols-2 gap-2">
                <CritiqueCard c={plan.critiques.ceo} />
                <CritiqueCard c={plan.critiques.eng} />
              </div>
            ) : (
              <div className="text-dim2 text-[11px] italic">
                Critics will run automatically when you click <span className="text-ink">approve</span> — or kick them now to see verdicts before approving.
              </div>
            )}
          </div>
        )}

        {/* Hire preview */}
        {preview && (
          <div className="mt-4 border-t border-line/40 pt-3">
            <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1">
              <Users size={11} /> Hire dispatch preview
              <span className="ml-2 text-dim2 normal-case">(based on current hire mode)</span>
            </div>
            <div className="grid md:grid-cols-3 gap-2 text-[11px]">
              <HireColumn icon={<UserCheck size={11} />} tint="text-accent" label="will hire" items={preview.hired} />
              <HireColumn icon={<Hourglass size={11} />} tint="text-warn"   label="queued for approval" items={preview.queued} />
              <HireColumn icon={<UserX size={11} />}    tint="text-dim"    label="skipped" items={preview.skipped} />
            </div>
            {preview.errors.length > 0 && (
              <div className="mt-2 text-err text-[11px]">
                errors: {preview.errors.map((e) => `${e.role}: ${e.error}`).join('; ')}
              </div>
            )}
          </div>
        )}

        {/* Hire summary (post-approval) */}
        {plan.hireSummary && (isApproved || isDispatched) && (
          <div className="mt-4 border-t border-line/40 pt-3">
            <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1">
              <Users size={11} /> Hire dispatch result
            </div>
            <div className="grid md:grid-cols-3 gap-2 text-[11px]">
              <HireColumn icon={<UserCheck size={11} />} tint="text-accent" label="hired" items={plan.hireSummary.hired} />
              <HireColumn icon={<Hourglass size={11} />} tint="text-warn"   label="awaiting approval" items={plan.hireSummary.queued} />
              <HireColumn icon={<UserX size={11} />}    tint="text-dim"    label="skipped" items={plan.hireSummary.skipped} />
            </div>
          </div>
        )}

        {/* Brief link if dispatched */}
        {isDispatched && plan.briefId && (
          <div className="mt-4 border-t border-line/40 pt-3 flex items-center justify-between text-[12px]">
            <div className="flex items-center gap-2 text-accent">
              <Send size={12} /> Brief dispatched: <span className="font-mono">{plan.briefId}</span>
            </div>
            <a href={`/logs/${plan.briefId}`} className="text-accent hover:underline flex items-center gap-1 text-xs">
              open trace <ExternalLink size={11} />
            </a>
          </div>
        )}

        {/* Footer actions */}
        {(isDraft || (isApproved && plan.hireSummary && plan.hireSummary.queued.length > 0)) && (
          <div className="mt-4 border-t border-line/40 pt-3 flex items-center justify-end gap-2 flex-wrap">
            {isDraft && syn.costVerdict === 'over-budget' && (
              <span className="text-err text-[11px] mr-auto flex items-center gap-1">
                <AlertTriangle size={11} /> Estimated cost exceeds your budget (incl. ~30% buffer). Trim scope, raise budget, or force-dispatch to override.
              </span>
            )}
            {isDraft && plan.critiques?.blocked && syn.costVerdict !== 'over-budget' && (
              <span className="text-warn text-[11px] mr-auto flex items-center gap-1">
                <AlertTriangle size={11} /> Critics flagged issues. Edit + re-run, or force-dispatch to override.
              </span>
            )}
            {isDraft && (
              <button
                onClick={reject}
                disabled={busy === 'reject'}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-err/40 text-err text-xs hover:bg-err/10 disabled:opacity-40"
              >
                <X size={11} /> reject
              </button>
            )}
            {isDraft && !plan.critiques?.blocked && syn.costVerdict !== 'over-budget' && (
              <button
                onClick={() => approve(false)}
                disabled={busy === 'approve' || editing}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium shadow-glow hover:brightness-110 disabled:opacity-40"
                title={editing ? 'save edits first' : ''}
              >
                <ArrowRight size={11} /> {busy === 'approve' ? 'approving…' : (plan.critiques ? 'approve & dispatch' : 'run critics & approve')}
              </button>
            )}
            {isDraft && (plan.critiques?.blocked || syn.costVerdict === 'over-budget') && (
              <button
                onClick={() => approve(true)}
                disabled={busy === 'approve' || editing}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium hover:brightness-110 disabled:opacity-40',
                  syn.costVerdict === 'over-budget' ? 'bg-err text-bg' : 'bg-warn text-bg',
                )}
                title="Override the gate and dispatch anyway"
              >
                <Send size={11} /> {busy === 'approve' ? 'dispatching…' : (
                  syn.costVerdict === 'over-budget' ? 'force dispatch (over budget)' : 'force dispatch (override critics)'
                )}
              </button>
            )}
            {isApproved && (
              <button
                onClick={() => approve(true)}
                disabled={busy === 'approve'}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-warn text-bg text-xs font-medium hover:brightness-110 disabled:opacity-40"
                title="Dispatch the brief even though some hires are still queued"
              >
                <Send size={11} /> {busy === 'approve' ? 'dispatching…' : 'force dispatch anyway'}
              </button>
            )}
          </div>
        )}

        {isRejected && (
          <div className="mt-4 border-t border-line/40 pt-3 flex items-center justify-end gap-2">
            <button
              onClick={createFromLatest}
              disabled={busy === 'create'}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-line/70 text-ink2 text-xs hover:border-line2 disabled:opacity-40"
            >
              <RotateCcw size={11} /> redraft from latest discovery
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function CritiqueCard({ c }: { c: Critique }) {
  const Icon = CRITIQUE_ICONS[c.role];
  const tint = CRITIQUE_TINT[c.verdict];
  return (
    <div className={cn('border rounded-md p-2.5 bg-bg/30', tint)}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={11} />
        <span className="text-ink text-[12px] font-medium">{c.displayName}</span>
        <span className={cn('ml-auto text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border', tint)}>
          {c.verdict}
        </span>
      </div>
      {c.failed ? (
        <div className="text-err text-[11px]">failed: {c.error}</div>
      ) : (
        <>
          {c.concerns.length > 0 && (
            <ul className="text-ink2 text-[11.5px] space-y-0.5 list-disc list-inside marker:text-current mb-1.5">
              {c.concerns.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          )}
          {c.suggestedEdits.length > 0 && (
            <div className="space-y-0.5 mb-1.5">
              {c.suggestedEdits.map((e, i) => (
                <div key={i} className="text-[11px] text-ink2 flex items-start gap-1">
                  <MessageSquare size={9} className="mt-1 shrink-0 opacity-70" />
                  <span><span className="font-mono text-dim2">{e.where}</span> · {e.what}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="text-dim2 text-[10px] font-mono pt-1 border-t border-line/30 flex items-center gap-2 flex-wrap">
        <span>{c.tokensIn}↓/{c.tokensOut}↑</span>
        <span>·</span>
        <span>${c.costUsd.toFixed(4)}</span>
        <span>·</span>
        <span>{c.durationMs}ms</span>
      </div>
    </div>
  );
}

function HireColumn({ icon, tint, label, items }: { icon: React.ReactNode; tint: string; label: string; items: HirePreview[] }) {
  return (
    <div className="border border-line/70 rounded-md p-2 bg-bg/30 min-h-[60px]">
      <div className={cn('flex items-center gap-1 text-[10px] uppercase tracking-wider mb-1.5', tint)}>{icon}{label} <span className="ml-auto font-mono">{items.length}</span></div>
      {items.length === 0 ? (
        <div className="text-dim2 italic">none</div>
      ) : (
        <ul className="space-y-1">
          {items.map((h, i) => (
            <li key={`${h.role}-${i}`} className="text-ink2 font-mono truncate" title={`${h.role}${h.alreadyHired ? ' (already on roster)' : ''} — ${h.reason ?? ''}`}>
              {h.displayName ?? h.role}
              {h.alreadyHired && <span className="text-dim2 ml-1">·on roster</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditableList({
  icon, label, items, editing, onChange, placeholder, chipTint,
}: {
  icon: React.ReactNode; label: string; items: string[]; editing: boolean;
  onChange: (next: string[]) => void; placeholder: string; chipTint: string;
}) {
  const [draftInput, setDraftInput] = useState('');
  if (!editing && items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1 flex items-center gap-1">{icon}{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <span key={`${it}-${i}`} className={cn('inline-flex items-center gap-1 text-[11.5px] px-2 py-0.5 rounded-full border', chipTint)}>
            {it}
            {editing && (
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="opacity-50 hover:opacity-100 hover:text-err transition-opacity"
                title="remove"
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}
      </div>
      {editing && (
        <div className="flex items-center gap-2 mt-2">
          <input
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draftInput.trim()) {
                e.preventDefault();
                onChange([...items, draftInput.trim()]);
                setDraftInput('');
              }
            }}
            placeholder={placeholder}
            className="flex-1 bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
          />
        </div>
      )}
    </div>
  );
}

function Pill({ icon, tint, text }: { icon: React.ReactNode; tint: string; text: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full border', tint)}>
      {icon} {text}
    </span>
  );
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
