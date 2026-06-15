'use client';

import { useEffect, useState } from 'react';
import {
  Eye, Globe, Save, Plus, X, Play, RefreshCw, Camera, AlertTriangle,
  CheckCircle2, XCircle, Clock, Settings as SettingsIcon, ChevronDown,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

type Status = 'running' | 'pass' | 'fail' | 'error' | 'skipped';

interface ScriptStep {
  step: 'goto' | 'click' | 'fill' | 'expectText' | 'expectVisible' | 'screenshot';
  selector?: string; url?: string; text?: string; contains?: string; label?: string; criterion?: string;
}
interface StepResult { step: ScriptStep; passed: boolean; error?: string; screenshot?: string; durationMs: number }
interface ValidationReport {
  steps: StepResult[];
  summary: { total: number; passed: number; failed: number; durationMs: number };
}
interface ValidationRun {
  id: string;
  workspaceId: string;
  briefId: string | null;
  status: Status;
  targetUrl: string;
  script: ScriptStep[];
  report: ValidationReport | null;
  screenshotsDir: string | null;
  source: 'auto' | 'manual' | 'rerun';
  tokensIn: number; tokensOut: number; costUsd: number;
  startedAt: number; endedAt: number | null;
  errorMessage: string | null;
}
interface TargetConfig { targetUrl: string | null; allowlist: string[] }

const STATUS_META: Record<Status, { tint: string; icon: React.ComponentType<{ size?: number; className?: string }>; label: string }> = {
  running:  { tint: 'border-warn/40 text-warn bg-warn/10',     icon: Clock,        label: 'running' },
  pass:     { tint: 'border-accent/40 text-accent bg-accent/10', icon: CheckCircle2, label: 'pass' },
  fail:     { tint: 'border-err/40 text-err bg-err/10',         icon: XCircle,      label: 'fail' },
  error:    { tint: 'border-err/40 text-err bg-err/10',         icon: AlertTriangle, label: 'error' },
  skipped:  { tint: 'border-line/70 text-dim',                  icon: ChevronDown,  label: 'skipped' },
};

function fmtTs(ms: number | null) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function Validation({ workspaceId }: { workspaceId: string }) {
  const [target, setTarget] = useState<TargetConfig | null>(null);
  const [runs, setRuns] = useState<ValidationRun[]>([]);
  const [open, setOpen] = useState<ValidationRun | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [draft, setDraft] = useState({ targetUrl: '', newOrigin: '' });
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const [t, r] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/target`).then((x) => x.json()),
        fetch(`/api/workspaces/${workspaceId}/validations`).then((x) => x.json()),
      ]);
      setTarget(t.target);
      setRuns(r.runs ?? []);
      if (!editingTarget) setDraft((d) => ({ ...d, targetUrl: t.target.targetUrl ?? '' }));
    } catch {}
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 6000); return () => clearInterval(id); }, [workspaceId, editingTarget]);

  async function saveTarget() {
    setBusy('save-target');
    try {
      const body: any = { targetUrl: draft.targetUrl.trim() || null };
      const r = await fetch(`/api/workspaces/${workspaceId}/target`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'save failed');
      setTarget(j.target);
      setEditingTarget(false);
      toast({ title: 'Target saved', variant: 'success' });
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function addOrigin() {
    if (!draft.newOrigin.trim() || !target) return;
    setBusy('allowlist');
    try {
      const next = Array.from(new Set([...target.allowlist, draft.newOrigin.trim()]));
      const r = await fetch(`/api/workspaces/${workspaceId}/target`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowlist: next }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'save failed');
      setTarget(j.target);
      setDraft({ ...draft, newOrigin: '' });
    } catch (e: any) { toast({ title: 'Allowlist update failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }
  async function removeOrigin(origin: string) {
    if (!target) return;
    setBusy('allowlist');
    try {
      const next = target.allowlist.filter((o) => o !== origin);
      const r = await fetch(`/api/workspaces/${workspaceId}/target`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowlist: next }),
      });
      const j = await r.json();
      setTarget(j.target);
    } finally { setBusy(null); }
  }

  async function runManual(briefId: string) {
    setBusy('run');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/briefs/${briefId}/validate`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'run failed');
      toast({
        title: `Validation ${j.run.status}`,
        description: j.run.report ? `${j.run.report.summary.passed}/${j.run.report.summary.total} steps` : j.run.errorMessage ?? 'no report',
        variant: j.run.status === 'pass' ? 'success' : 'warn',
      });
      await refresh();
    } catch (e: any) { toast({ title: 'Run failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function rerun(runId: string) {
    setBusy('rerun');
    try {
      const r = await fetch(`/api/validations/${runId}/rerun`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'rerun failed');
      toast({
        title: `Rerun ${j.run.status}`,
        description: j.run.report ? `${j.run.report.summary.passed}/${j.run.report.summary.total} steps` : '',
        variant: j.run.status === 'pass' ? 'success' : 'warn',
      });
      await refresh();
    } catch (e: any) { toast({ title: 'Rerun failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  // Brief IDs across runs — for the manual "validate brief" action.
  const briefIds = Array.from(new Set(runs.map((r) => r.briefId).filter(Boolean))) as string[];
  const latest = runs[0];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Eye size={14} className={target?.targetUrl ? 'text-accent' : 'text-dim'} />
        <span className="text-ink font-medium text-sm">Browser validation</span>
        {!target?.targetUrl && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-warn/40 text-warn bg-warn/10">
            no target URL
          </span>
        )}
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
          <RefreshCw size={11} /> refresh
        </button>
        {target?.targetUrl && !editingTarget && (
          <button
            onClick={() => setEditingTarget(true)}
            className="flex items-center gap-1 text-dim2 hover:text-ink text-xs"
          >
            <SettingsIcon size={11} /> configure
          </button>
        )}
      </div>

      {/* Target config */}
      {(!target?.targetUrl || editingTarget) ? (
        <div className="border border-accent/30 rounded-lg p-3 bg-surface2/60 shadow-glow space-y-2">
          <div className="text-ink font-medium text-xs flex items-center gap-1">
            <Globe size={11} className="text-accent" /> Target URL
          </div>
          <input
            value={draft.targetUrl}
            onChange={(e) => setDraft({ ...draft, targetUrl: e.target.value })}
            placeholder="http://localhost:5173"
            className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-sm text-ink font-mono outline-none focus:border-accent/60"
          />
          <div className="text-dim2 text-[10px]">
            The browser will navigate here when a brief completes. Allowlist below restricts which origins the script can hit.
          </div>
          <div className="text-dim2 text-[10px] uppercase tracking-wider mt-2">Origin allowlist</div>
          <div className="flex flex-wrap gap-1.5">
            {(target?.allowlist ?? []).map((o) => (
              <span key={o} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-info/40 text-info bg-info/10 font-mono">
                {o}
                <button onClick={() => removeOrigin(o)} className="opacity-50 hover:opacity-100 hover:text-err">
                  <X size={9} />
                </button>
              </span>
            ))}
            {(!target || target.allowlist.length === 0) && <span className="text-dim2 text-[11px] italic">(auto-fills when you save a target URL)</span>}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={draft.newOrigin}
              onChange={(e) => setDraft({ ...draft, newOrigin: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') addOrigin(); }}
              placeholder="https://staging.example.com"
              className="flex-1 bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
            />
            <button
              onClick={addOrigin}
              disabled={!draft.newOrigin.trim() || busy === 'allowlist'}
              className="flex items-center gap-1 px-2 py-1 rounded border border-line/70 text-ink2 text-xs hover:border-line2 disabled:opacity-40"
            >
              <Plus size={11} /> add origin
            </button>
          </div>
          <div className="flex justify-end gap-2">
            {editingTarget && target?.targetUrl && (
              <button onClick={() => { setEditingTarget(false); setDraft({ targetUrl: target.targetUrl ?? '', newOrigin: '' }); }} className="text-dim2 hover:text-ink text-xs">cancel</button>
            )}
            <button
              onClick={saveTarget}
              disabled={busy === 'save-target'}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
            >
              <Save size={11} /> {busy === 'save-target' ? 'saving…' : 'save target'}
            </button>
          </div>
        </div>
      ) : (
        <div className="border border-accent/30 rounded-lg p-3 bg-surface2/50 flex items-center gap-3">
          <Globe size={12} className="text-accent" />
          <span className="font-mono text-ink text-sm truncate">{target.targetUrl}</span>
          <span className="text-dim2 text-[10px] ml-auto">{target.allowlist.length} origins allowed</span>
        </div>
      )}

      {target?.targetUrl && briefIds.length === 0 && runs.length === 0 && (
        <div className="border border-dashed border-line/70 rounded-lg p-3 text-dim2 text-[11px] italic">
          No validation runs yet — dispatch a brief or click validate on an existing brief to start.
        </div>
      )}

      {/* Per-brief manual run buttons */}
      {target?.targetUrl && briefIds.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-dim2 uppercase tracking-wider text-[10px]">run for:</span>
          {briefIds.map((b) => (
            <button
              key={b}
              onClick={() => runManual(b)}
              disabled={busy === 'run'}
              className="font-mono px-1.5 py-0.5 rounded border border-line/70 text-dim2 hover:text-ink hover:border-line2 disabled:opacity-40 flex items-center gap-0.5"
              title={`Re-validate ${b}`}
            >
              <Play size={9} /> {b}
            </button>
          ))}
        </div>
      )}

      {/* Latest run card */}
      {latest && <RunCard run={latest} headline onOpen={() => setOpen(latest)} onRerun={() => rerun(latest.id)} busy={busy === 'rerun'} />}

      {/* Run history */}
      {runs.length > 1 && (
        <details className="border border-line/70 rounded-lg bg-surface2/40">
          <summary className="cursor-pointer p-2 text-dim2 text-[11px] uppercase tracking-wider hover:text-ink select-none flex items-center gap-1">
            <ChevronDown size={11} /> history · {runs.length - 1} earlier
          </summary>
          <div className="p-2 grid md:grid-cols-2 gap-2">
            {runs.slice(1).map((r) => (
              <RunCard key={r.id} run={r} onOpen={() => setOpen(r)} onRerun={() => rerun(r.id)} busy={busy === 'rerun'} />
            ))}
          </div>
        </details>
      )}

      {open && <RunDetail run={open} workspaceId={workspaceId} onClose={() => setOpen(null)} onRerun={() => { rerun(open.id); setOpen(null); }} />}
    </section>
  );
}

function RunCard({ run, headline, onOpen, onRerun, busy }: {
  run: ValidationRun; headline?: boolean; onOpen: () => void; onRerun: () => void; busy?: boolean;
}) {
  const meta = STATUS_META[run.status] ?? STATUS_META.skipped;
  const Icon = meta.icon;
  const summary = run.report?.summary;
  return (
    <div className={cn(
      'rounded-lg border p-3 bg-bg/30',
      headline ? `${meta.tint.replace('/10', '/15')} shadow-glow` : 'border-line/70',
    )}>
      <div className="flex items-start gap-2 mb-1.5">
        <Icon size={13} className={meta.tint.split(' ')[0]} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className={cn('uppercase font-mono px-1.5 py-0.5 rounded-full border', meta.tint)}>{run.status}</span>
            <span className="text-dim2 font-mono">{run.id}</span>
            <span className="text-dim2 ml-auto">{fmtTs(run.startedAt)}</span>
          </div>
          <div className="text-ink2 text-[12px] mt-1 font-mono truncate" title={run.targetUrl}>{run.targetUrl}</div>
          {run.briefId && <div className="text-dim2 text-[10px] font-mono">brief: {run.briefId}</div>}
        </div>
      </div>
      {summary ? (
        <div className="text-[11px] text-ink2 flex items-center gap-2">
          <span className="font-mono">{summary.passed}/{summary.total} steps</span>
          {summary.failed > 0 && <span className="text-err font-mono">· {summary.failed} failed</span>}
          <span className="text-dim2 ml-auto font-mono">{summary.durationMs}ms</span>
        </div>
      ) : run.errorMessage ? (
        <div className="text-err text-[11px]">{run.errorMessage}</div>
      ) : (
        <div className="text-dim2 text-[11px] italic">no report yet</div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <button onClick={onOpen} className="text-accent hover:underline text-[11px]">open</button>
        <button onClick={onRerun} disabled={busy} className="text-dim2 hover:text-ink text-[11px] flex items-center gap-0.5 disabled:opacity-40">
          <RefreshCw size={9} /> rerun
        </button>
        <span className="ml-auto text-dim2 text-[10px] font-mono">{run.source}</span>
      </div>
    </div>
  );
}

function RunDetail({ run, workspaceId, onClose, onRerun }: {
  run: ValidationRun; workspaceId: string; onClose: () => void; onRerun: () => void;
}) {
  const meta = STATUS_META[run.status] ?? STATUS_META.skipped;
  const Icon = meta.icon;
  const steps = run.report?.steps ?? [];
  return (
    <div className="fixed inset-0 z-50 bg-bg/90 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line/70 rounded-xl shadow-glow max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-line/70">
          <Icon size={14} className={meta.tint.split(' ')[0]} />
          <span className={cn('uppercase font-mono text-[10px] px-1.5 py-0.5 rounded-full border', meta.tint)}>{run.status}</span>
          <span className="text-ink text-sm font-medium truncate">{run.targetUrl}</span>
          <span className="text-dim2 text-[10px] font-mono ml-2">{run.id}</span>
          <button onClick={onRerun} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
            <RefreshCw size={11} /> rerun
          </button>
          <button onClick={onClose} className="text-dim2 hover:text-ink"><X size={14} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {run.errorMessage && (
            <div className="border border-err/40 bg-err/10 text-err text-[12px] rounded p-2 font-mono">
              {run.errorMessage}
            </div>
          )}
          {run.report?.summary && (
            <div className="grid grid-cols-4 gap-2 text-[11px]">
              <Stat label="total"    value={`${run.report.summary.total}`} />
              <Stat label="passed"   value={`${run.report.summary.passed}`} tint="text-accent" />
              <Stat label="failed"   value={`${run.report.summary.failed}`} tint={run.report.summary.failed > 0 ? 'text-err' : 'text-dim'} />
              <Stat label="duration" value={`${run.report.summary.durationMs}ms`} />
            </div>
          )}
          {steps.length > 0 ? (
            <ol className="space-y-1.5">
              {steps.map((sr, i) => (
                <li key={i} className={cn(
                  'border rounded-md p-2 bg-surface2/40',
                  sr.passed ? 'border-accent/30' : 'border-err/40',
                )}>
                  <div className="flex items-center gap-2 text-[11.5px]">
                    {sr.passed ? <CheckCircle2 size={12} className="text-accent" /> : <XCircle size={12} className="text-err" />}
                    <span className="font-mono text-ink">{sr.step.step}</span>
                    {sr.step.selector && <span className="font-mono text-dim2 truncate">{sr.step.selector}</span>}
                    <span className="text-dim2 ml-auto font-mono">{sr.durationMs}ms</span>
                  </div>
                  {sr.step.criterion && (
                    <div className="text-ink2 text-[11px] mt-1">{sr.step.criterion}</div>
                  )}
                  {sr.step.contains && (
                    <div className="text-dim2 text-[10px] font-mono mt-0.5">expects: contains "{sr.step.contains}"</div>
                  )}
                  {sr.error && (
                    <div className="text-err text-[11px] mt-1 font-mono">{sr.error}</div>
                  )}
                  {sr.screenshot && run.screenshotsDir && (
                    <div className="mt-2">
                      <img
                        src={`/api/validations/${run.id}/screenshots/${sr.screenshot}`}
                        alt={sr.step.label ?? `step ${i + 1}`}
                        className="max-w-full max-h-64 rounded border border-line/70"
                        loading="lazy"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-dim2 text-xs italic">no step results — the script may not have run yet</div>
          )}
          {run.script.length > 0 && (
            <details className="border border-line/70 rounded-md bg-bg/30">
              <summary className="cursor-pointer p-2 text-dim2 text-[10px] uppercase tracking-wider hover:text-ink">script ({run.script.length} steps)</summary>
              <pre className="p-2 text-[11px] text-ink2 font-mono overflow-x-auto">{JSON.stringify(run.script, null, 2)}</pre>
            </details>
          )}
          <div className="text-dim2 text-[10px] font-mono">
            source: {run.source} · tokens {run.tokensIn}↓/{run.tokensOut}↑ · cost ${run.costUsd.toFixed(4)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div className="border border-line/70 rounded-md px-2 py-1.5 bg-bg/30">
      <div className="text-dim2 text-[10px] uppercase tracking-wider">{label}</div>
      <div className={cn('font-mono mt-0.5 text-sm', tint ?? 'text-ink')}>{value}</div>
    </div>
  );
}
