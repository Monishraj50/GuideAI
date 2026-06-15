// Phase 2 — Plan review + hire-mode enforcement.
//
// A "plan" is an editable, user-reviewable view over a discovery's synthesis.
// Phase 1 produced the synthesis; Phase 2 lets the user edit it, decides which
// hires to make based on the workspace's hire_mode, and dispatches the brief.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { appendEvent } from '@guideai/messaging/events';
import { loadCatalog } from '@guideai/agents-catalog';
import type { SystemChunk } from '@guideai/shared/chunks';
import { hireAgent } from './hiring.js';
import { submitBrief } from './cos.js';
import { autoSeedFromPlan } from './wbs.js';
import { runCritiques, type CritiqueBundle } from './critique.js';
import {
  loadIntake, latestDiscovery, type DiscoverySynthesis,
  type HireMode, type PlanningMode,
} from './discovery.js';

export type PlanStatus = 'draft' | 'approved' | 'dispatched' | 'rejected';

export interface HirePreview {
  /** Canonical catalog role we resolved to (or original if no match). */
  role: string;
  /** Whatever the discovery suggested (pre-resolution). */
  requested: string;
  /** Plan that will be taken: hire immediately, queue for approval, or skip. */
  action: 'hire' | 'queue' | 'skip';
  reason?: string;
  /** Display name if catalog match (or pretty form). */
  displayName?: string;
  /** Already on the roster — no-op. */
  alreadyHired?: boolean;
}

export interface HireDispatchResult {
  hired: HirePreview[];
  queued: HirePreview[];
  skipped: HirePreview[];
  errors: { role: string; error: string }[];
}

export interface PlanRecord {
  id: string;
  workspaceId: string;
  discoveryId: string | null;
  status: PlanStatus;
  synthesis: DiscoverySynthesis;
  notes: string | null;
  briefId: string | null;
  hireSummary: HireDispatchResult | null;
  critiques: CritiqueBundle | null;
  critiquesRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  dispatchedAt: number | null;
}

/** Roles auto-hired even in `hybrid` mode. Lean defaults — common, low-risk. */
const SAFE_DEFAULT_ROLES = new Set([
  'backend-developer',
  'frontend-developer',
  'fullstack-developer',
  'technical-writer',
  'qa-expert',
  'test-automator',
]);

/** Map shorthand → catalog-canonical role names. Discovery panelists are not
 *  required to know every exact catalog ID, so we resolve here. */
const ROLE_ALIASES: Record<string, string> = {
  'qa-engineer':            'qa-expert',
  'test-engineer':          'test-automator',
  'test-automation-engineer': 'test-automator',
  'quality-assurance-engineer': 'qa-expert',
  'full-stack-developer':   'fullstack-developer',
  'fullstack':              'fullstack-developer',
  'devops':                 'devops-engineer',
  'sre':                    'sre-engineer',
  'site-reliability-engineer': 'sre-engineer',
  'security':               'security-engineer',
  'ux-designer':            'ui-designer',
  'ui-ux-designer':         'ui-designer',
  'pm':                     'product-manager',
  'product-owner':          'product-manager',
  'tech-lead':              'engineering-manager',
  'architect':              'solution-architect',
};

function resolveCatalogRole(role: string): { role: string; displayName?: string; matched: boolean } {
  const cat = loadCatalog();
  if (!cat) return { role, matched: false };
  const norm = role.toLowerCase().trim().replace(/\s+/g, '-');
  const direct = cat.agents.find((a) => a.role === norm);
  if (direct) return { role: direct.role, displayName: direct.displayName, matched: true };
  const aliased = ROLE_ALIASES[norm];
  if (aliased) {
    const found = cat.agents.find((a) => a.role === aliased);
    if (found) return { role: found.role, displayName: found.displayName, matched: true };
  }
  // Fuzzy: any agent role that contains the requested keyword.
  const partial = cat.agents.find((a) => a.role.includes(norm) || norm.includes(a.role));
  if (partial) return { role: partial.role, displayName: partial.displayName, matched: true };
  return { role: norm, matched: false };
}

/**
 * Decide what to do with each requested role given the hire mode. Pure-ish —
 * checks roster + catalog but doesn't dispatch.
 */
export function previewHires(args: {
  workspaceId: string;
  roles: string[];
  hireMode: HireMode;
}): HireDispatchResult {
  const db = getDb();
  const roster = db.select().from(schema.agents).all()
    .filter((a) => a.workspaceId === args.workspaceId && a.status !== 'retired');
  const onRoster = new Set(roster.map((a) => a.role));

  const out: HireDispatchResult = { hired: [], queued: [], skipped: [], errors: [] };
  const seen = new Set<string>();

  for (const requested of args.roles) {
    if (!requested) continue;
    const resolved = resolveCatalogRole(requested);
    if (seen.has(resolved.role)) continue;
    seen.add(resolved.role);

    if (onRoster.has(resolved.role)) {
      out.hired.push({
        requested, role: resolved.role,
        displayName: resolved.displayName,
        action: 'hire', alreadyHired: true,
        reason: 'already on roster',
      });
      continue;
    }
    if (!resolved.matched) {
      out.skipped.push({
        requested, role: resolved.role,
        action: 'skip', reason: 'no catalog match',
      });
      continue;
    }

    // Mode decides.
    if (args.hireMode === 'auto') {
      out.hired.push({ requested, role: resolved.role, displayName: resolved.displayName, action: 'hire', reason: 'auto-hire' });
    } else if (args.hireMode === 'manual') {
      out.queued.push({ requested, role: resolved.role, displayName: resolved.displayName, action: 'queue', reason: 'manual approval' });
    } else { // hybrid
      if (SAFE_DEFAULT_ROLES.has(resolved.role)) {
        out.hired.push({ requested, role: resolved.role, displayName: resolved.displayName, action: 'hire', reason: 'safe default' });
      } else {
        out.queued.push({ requested, role: resolved.role, displayName: resolved.displayName, action: 'queue', reason: 'non-default — needs approval' });
      }
    }
  }
  return out;
}

/**
 * Execute a hire preview: anything tagged `hire` (and not already on roster) is
 * actually added. `queued` and `skipped` are returned for the UI to handle.
 */
export function executeHires(args: {
  workspaceId: string;
  preview: HireDispatchResult;
}): HireDispatchResult {
  const out: HireDispatchResult = {
    hired: [], queued: [...args.preview.queued], skipped: [...args.preview.skipped],
    errors: [...args.preview.errors],
  };
  for (const h of args.preview.hired) {
    if (h.alreadyHired) { out.hired.push(h); continue; }
    try {
      const r = hireAgent(args.workspaceId, h.role);
      out.hired.push({ ...h, displayName: r.displayName });
    } catch (e: any) {
      out.errors.push({ role: h.role, error: String(e?.message ?? e) });
      out.skipped.push({ ...h, action: 'skip', reason: `hire failed: ${e?.message ?? e}` });
    }
  }
  return out;
}

// ---------- plan CRUD ----------

function rowToPlan(row: any): PlanRecord {
  return {
    id: row.id, workspaceId: row.workspaceId, discoveryId: row.discoveryId,
    status: row.status, synthesis: JSON.parse(row.editedSynthesisJson),
    notes: row.notes,
    briefId: row.briefId,
    hireSummary: row.hireSummaryJson ? JSON.parse(row.hireSummaryJson) : null,
    critiques: row.critiquesJson ? JSON.parse(row.critiquesJson) : null,
    critiquesRunAt: row.critiquesRunAt ?? null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    approvedAt: row.approvedAt, dispatchedAt: row.dispatchedAt,
  };
}

export function listPlans(workspaceId: string): PlanRecord[] {
  const db = getDb();
  return db.select().from(schema.plans).all()
    .filter((p) => p.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(rowToPlan);
}

export function latestPlan(workspaceId: string): PlanRecord | null {
  return listPlans(workspaceId)[0] ?? null;
}

export function getPlan(planId: string): PlanRecord | null {
  const db = getDb();
  const row = db.select().from(schema.plans).where(eq(schema.plans.id, planId)).all()[0];
  return row ? rowToPlan(row) : null;
}

/**
 * Create a plan from the latest discovery (or one passed explicitly). If a
 * draft plan for the same discovery already exists, reuse it so the UI doesn't
 * accumulate dupes when the discovery is re-rendered.
 */
export function createPlanFromDiscovery(args: {
  workspaceId: string;
  discoveryId?: string;
  synthesis?: DiscoverySynthesis;
}): PlanRecord {
  const db = getDb();
  let discoveryId = args.discoveryId;
  let synthesis = args.synthesis;
  if (!synthesis) {
    const d = latestDiscovery(args.workspaceId);
    if (!d || !d.synthesis) throw new Error('no discovery synthesis to plan from');
    discoveryId = d.id;
    synthesis = d.synthesis;
  }

  if (discoveryId) {
    const existing = db.select().from(schema.plans).all()
      .find((p) => p.workspaceId === args.workspaceId && p.discoveryId === discoveryId && p.status === 'draft');
    if (existing) return rowToPlan(existing);
  }

  const id = `plan-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.insert(schema.plans).values({
    id, workspaceId: args.workspaceId, discoveryId: discoveryId ?? null,
    status: 'draft',
    editedSynthesisJson: JSON.stringify(synthesis),
    notes: null, briefId: null, hireSummaryJson: null,
    createdAt: now, updatedAt: now, approvedAt: null, dispatchedAt: null,
  } as any).run();

  appendEvent(args.workspaceId, sys(args.workspaceId,
    `plan ${id} drafted from discovery ${discoveryId ?? '(adhoc)'}`));

  return getPlan(id)!;
}

export function savePlanEdits(args: {
  planId: string;
  synthesis?: DiscoverySynthesis;
  notes?: string;
}): PlanRecord {
  const db = getDb();
  const current = getPlan(args.planId);
  if (!current) throw new Error(`plan ${args.planId} not found`);
  if (current.status !== 'draft') throw new Error(`plan ${args.planId} is ${current.status}; cannot edit`);

  const patch: Record<string, any> = { updatedAt: Date.now() };
  if (args.synthesis) {
    patch.editedSynthesisJson = JSON.stringify(args.synthesis);
    // Synthesis changed — any prior critique is stale. Clear so the next
    // approve call re-runs the critics against the edited version.
    patch.critiquesJson = null;
    patch.critiquesRunAt = null;
  }
  if (args.notes !== undefined) patch.notes = args.notes;

  db.update(schema.plans).set(patch).where(eq(schema.plans.id, args.planId)).run();
  return getPlan(args.planId)!;
}

/** Re-run the critic pass on demand (e.g. after a manual edit, or if the user
 *  just wants a fresh take). Overwrites any prior bundle. */
export async function recritique(planId: string): Promise<PlanRecord> {
  const db = getDb();
  const plan = getPlan(planId);
  if (!plan) throw new Error(`plan ${planId} not found`);
  const intake = loadIntake(plan.workspaceId);
  const bundle = await runCritiques({
    workspaceId: plan.workspaceId, planId: plan.id,
    synthesis: plan.synthesis, intake,
  });
  db.update(schema.plans).set({
    critiquesJson: JSON.stringify(bundle),
    critiquesRunAt: bundle.ranAt,
    updatedAt: Date.now(),
  } as any).where(eq(schema.plans.id, plan.id)).run();
  return getPlan(plan.id)!;
}

export function rejectPlan(planId: string): PlanRecord {
  const db = getDb();
  const current = getPlan(planId);
  if (!current) throw new Error(`plan ${planId} not found`);
  if (current.status === 'dispatched') throw new Error('plan already dispatched');
  db.update(schema.plans).set({ status: 'rejected', updatedAt: Date.now() })
    .where(eq(schema.plans.id, planId)).run();
  appendEvent(current.workspaceId, sys(current.workspaceId, `plan ${planId} rejected`, 'warn'));
  return getPlan(planId)!;
}

/**
 * Compose the brief body from the (possibly edited) synthesis. This is what the
 * pipeline sees as the user's brief.
 */
export function composeBriefBody(syn: DiscoverySynthesis, intakeGoal: string): string {
  const lines: string[] = [];
  lines.push(`# ${intakeGoal.trim() || syn.summary.slice(0, 80)}`);
  lines.push('');
  if (syn.summary) { lines.push(syn.summary); lines.push(''); }
  if (syn.benefits.length) {
    lines.push('## Benefits'); for (const b of syn.benefits) lines.push(`- ${b}`); lines.push('');
  }
  if (syn.successMetrics.length) {
    lines.push('## Success metrics'); for (const m of syn.successMetrics) lines.push(`- ${m}`); lines.push('');
  }
  if (syn.recommendedRoles.length) {
    lines.push('## Hired roster'); lines.push(syn.recommendedRoles.join(', ')); lines.push('');
  }
  if (syn.riskFlags.length) {
    lines.push('## Risks to watch'); for (const r of syn.riskFlags.slice(0, 6)) lines.push(`- ${r}`); lines.push('');
  }
  if (syn.costEstimateUsd != null) {
    lines.push(`_Ballpark: $${syn.costEstimateUsd.toFixed(2)} (${syn.costVerdict})_`);
  }
  return lines.join('\n').trim();
}

/**
 * Mark the plan approved, execute hires per the workspace's intake.hireMode, and
 * (if no manual approvals are needed) submit the composed brief to the pipeline.
 *
 * Returns the updated plan record. If hires are queued, the plan stays in
 * `approved` (not `dispatched`) until the user clears them in /hire — at that
 * point they can re-call this to actually start the pipeline.
 */
export async function approvePlan(args: {
  planId: string;
  forceDispatch?: boolean;  // when true, dispatch the brief even if hires are queued OR critics blocked
  skipCritique?: boolean;   // when true, never run critics (useful for retries)
}): Promise<PlanRecord> {
  const db = getDb();
  let plan = getPlan(args.planId);
  if (!plan) throw new Error(`plan ${args.planId} not found`);
  if (plan.status === 'rejected') throw new Error('plan was rejected');
  if (plan.status === 'dispatched') return plan;

  const intake = loadIntake(plan.workspaceId);
  const hireMode: HireMode = intake?.hireMode ?? 'manual';
  const securityTagged = plan.synthesis.securityTag === 'required';

  // 0) Critique gate. Run critics if no bundle yet (idempotent per plan version).
  //    If a critic blocks and forceDispatch is not set, return early without
  //    hiring or dispatching — the UI must surface the bundle and let the user
  //    edit + re-approve, or force-dispatch.
  if (!plan.critiques && !args.skipCritique) {
    try {
      const bundle = await runCritiques({
        workspaceId: plan.workspaceId, planId: plan.id,
        synthesis: plan.synthesis, intake,
      });
      db.update(schema.plans).set({
        critiquesJson: JSON.stringify(bundle),
        critiquesRunAt: bundle.ranAt,
        updatedAt: Date.now(),
      } as any).where(eq(schema.plans.id, plan.id)).run();
      plan = getPlan(plan.id)!;
    } catch (err: any) {
      // Fail-open: if critique infra dies, don't block the brief. Just log.
      appendEvent(plan.workspaceId, sys(plan.workspaceId,
        `critique skipped (continuing): ${err?.message ?? err}`, 'warn'));
    }
  }
  if (plan.critiques?.blocked && !args.forceDispatch) {
    appendEvent(plan.workspaceId, sys(plan.workspaceId,
      `plan ${plan.id} blocked by critics · CEO:${plan.critiques.ceo.verdict} Eng:${plan.critiques.eng.verdict} · force-dispatch or edit to proceed`, 'warn'));
    return plan;  // status stays 'draft', UI shows the critique cards
  }

  // 0b) Over-budget gate. If the synthesizer's verdict is `over-budget` (cost ×
  // buffer exceeds the user's hint), block dispatch until the user either
  // raises the budget, trims scope, or explicitly force-dispatches.
  if (plan.synthesis.costVerdict === 'over-budget' && !args.forceDispatch) {
    const unit = intake?.budgetHintUnit ?? 'USD';
    const hint = intake?.budgetHintUsd != null
      ? `${intake.budgetHintUsd.toLocaleString()} ${unit}`
      : '(no budget set)';
    appendEvent(plan.workspaceId, sys(plan.workspaceId,
      `plan ${plan.id} blocked: estimated ~$${plan.synthesis.costEstimateUsd?.toFixed(2) ?? '?'} (× ~30% buffer) exceeds budget ${hint} · trim scope or raise budget, or force-dispatch`,
      'warn'));
    return plan;
  }

  // 1) Hires.
  const preview = previewHires({
    workspaceId: plan.workspaceId,
    roles: plan.synthesis.recommendedRoles,
    hireMode,
  });
  const hireSummary = executeHires({ workspaceId: plan.workspaceId, preview });

  appendEvent(plan.workspaceId, sys(plan.workspaceId,
    `plan ${plan.id} approved · hires: ${hireSummary.hired.length} done, ${hireSummary.queued.length} queued, ${hireSummary.skipped.length} skipped`));

  // 2) Decide whether to dispatch the brief.
  const hasQueued = hireSummary.queued.length > 0;
  const shouldDispatch = !hasQueued || !!args.forceDispatch;

  let briefId: string | null = null;
  let status: PlanStatus = 'approved';
  if (shouldDispatch) {
    const body = composeBriefBody(plan.synthesis, intake?.goal ?? '');
    const result = await submitBrief({
      workspaceId: plan.workspaceId, body, securityTagged,
    });
    briefId = result.briefId;
    status = 'dispatched';
    appendEvent(plan.workspaceId, sys(plan.workspaceId,
      `plan ${plan.id} dispatched → brief ${briefId}`));
    // Phase 4 — seed the WBS so the dashboard has something to show.
    try {
      autoSeedFromPlan({
        workspaceId: plan.workspaceId, briefId, planId: plan.id,
        synthesis: plan.synthesis,
      });
    } catch (err: any) {
      appendEvent(plan.workspaceId, sys(plan.workspaceId,
        `WBS seed skipped: ${err?.message ?? err}`, 'warn'));
    }
  } else {
    appendEvent(plan.workspaceId, sys(plan.workspaceId,
      `plan ${plan.id} waiting on ${hireSummary.queued.length} queued hire(s) before dispatch`, 'warn'));
  }

  const now = Date.now();
  db.update(schema.plans).set({
    status,
    hireSummaryJson: JSON.stringify(hireSummary),
    briefId,
    updatedAt: now,
    approvedAt: plan.approvedAt ?? now,
    dispatchedAt: status === 'dispatched' ? now : null,
  } as any).where(eq(schema.plans.id, plan.id)).run();

  return getPlan(plan.id)!;
}

/**
 * Convenience helper for the discovery route. Given that discovery just
 * finished, decide what to do based on planningMode:
 *   - manual:   do nothing
 *   - assisted: draft a plan, surface it for review
 *   - auto:     draft a plan, auto-approve + dispatch in one go
 */
export async function planFromDiscoveryByMode(args: {
  workspaceId: string;
  discoveryId: string;
  synthesis: DiscoverySynthesis;
  planningMode: PlanningMode;
}): Promise<PlanRecord | null> {
  if (args.planningMode === 'manual') return null;
  const draft = createPlanFromDiscovery({
    workspaceId: args.workspaceId,
    discoveryId: args.discoveryId,
    synthesis: args.synthesis,
  });
  if (args.planningMode === 'auto') {
    // forceDispatch:false → if hire-mode also queues things, the plan stays in
    // 'approved' waiting on hires. That's the right behaviour for auto+manual
    // mode mixes; the user clears hires, then re-approves to dispatch.
    return await approvePlan({ planId: draft.id });
  }
  return draft;
}

// ---------- helpers ----------

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId,
    kind: 'system', level, text,
  };
}

export { SAFE_DEFAULT_ROLES };
