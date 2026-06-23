import type { FastifyInstance } from 'fastify';
import {
  loadIntake, saveIntake, runDiscovery, latestDiscovery, listDiscoveries,
  type IntakeRecord, type PlanningMode, type HireMode, type BudgetUnit,
} from '@guideai/orchestrator/discovery';
import { planFromDiscoveryByMode } from '@guideai/orchestrator/planReview';
import { writeRequirementsMd } from '@guideai/orchestrator/projectContext';

const PLANNING: PlanningMode[] = ['auto', 'assisted', 'manual'];
const HIRING: HireMode[] = ['auto', 'manual', 'hybrid'];
const BUDGET_UNITS: BudgetUnit[] = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'tokens'];

function defaultsFor(workspaceId: string): IntakeRecord {
  return {
    workspaceId,
    goal: '',
    successCriteria: [],
    constraints: [],
    budgetHintUsd: null,
    budgetHintUnit: 'USD',
    planningMode: 'assisted',
    hireMode: 'manual',
    locked: false,
    lockedAt: null,
    discoveryContext: '',
  };
}

export function registerIntakeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/intake', async (req) => {
    const intake = loadIntake(req.params.id) ?? defaultsFor(req.params.id);
    const discovery = latestDiscovery(req.params.id);
    return { intake, latestDiscovery: discovery };
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      goal: string;
      successCriteria: string[];
      constraints: string[];
      budgetHintUsd: number | null;
      budgetHintUnit: BudgetUnit;
      planningMode: PlanningMode;
      hireMode: HireMode;
      /** Phase A — lock the 4 core fields (one-way; ignored if already locked). */
      locked: boolean;
      /** Phase A — free-text notes for the round-table; editable only while locked. */
      discoveryContext: string;
    }>;
  }>('/api/workspaces/:id/intake', async (req, reply) => {
    const body = req.body ?? {};
    const current = loadIntake(req.params.id) ?? defaultsFor(req.params.id);

    // Lock semantics: once locked, the 4 core fields are immutable. Unlock
    // requires an explicit `locked: false` + a fail/cancel signal from the
    // brief; Phase E handles that. For now, treat lock as one-way during the
    // happy path: silently drop edits to locked fields.
    const isLocked = current.locked;
    const nextLocked = body.locked === undefined ? current.locked : !!body.locked;
    const lockingNow = !current.locked && nextLocked;

    const next: IntakeRecord = {
      workspaceId: req.params.id,
      goal: isLocked
        ? current.goal
        : (typeof body.goal === 'string' ? body.goal : current.goal),
      successCriteria: isLocked
        ? current.successCriteria
        : (Array.isArray(body.successCriteria)
            ? body.successCriteria.map(String).map((s) => s.trim()).filter(Boolean)
            : current.successCriteria),
      constraints: isLocked
        ? current.constraints
        : (Array.isArray(body.constraints)
            ? body.constraints.map(String).map((s) => s.trim()).filter(Boolean)
            : current.constraints),
      budgetHintUsd: body.budgetHintUsd === undefined ? current.budgetHintUsd
        : (body.budgetHintUsd === null ? null : Number(body.budgetHintUsd)),
      budgetHintUnit: BUDGET_UNITS.includes(body.budgetHintUnit as BudgetUnit)
        ? (body.budgetHintUnit as BudgetUnit) : current.budgetHintUnit,
      planningMode: PLANNING.includes(body.planningMode as PlanningMode)
        ? (body.planningMode as PlanningMode) : current.planningMode,
      hireMode: HIRING.includes(body.hireMode as HireMode)
        ? (body.hireMode as HireMode) : current.hireMode,
      locked: nextLocked,
      lockedAt: lockingNow ? Date.now() : (current.lockedAt ?? null),
      // discoveryContext only editable while locked; before lock it stays empty.
      discoveryContext: typeof body.discoveryContext === 'string'
        ? body.discoveryContext
        : current.discoveryContext,
    };
    if (next.budgetHintUsd != null && !Number.isFinite(next.budgetHintUsd)) {
      reply.code(400); return { error: 'budget amount must be a number or null' };
    }
    if (next.budgetHintUsd != null && next.budgetHintUsd < 0) {
      reply.code(400); return { error: 'budget amount cannot be negative' };
    }
    // Block lock-without-goal so the user can't enter the discovery stage
    // with an empty brief.
    if (lockingNow && !next.goal.trim()) {
      reply.code(400); return { error: 'goal must be set before locking requirements' };
    }
    saveIntake(next);
    // Refresh the project-level requirements.md so subsequent briefs +
    // direct tasks pick up the latest goal/criteria/constraints/budget.
    try { writeRequirementsMd(req.params.id); } catch (err) { req.log.warn({ err }, 'writeRequirementsMd failed'); }
    return { intake: next };
  });

  // List discovery history
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/discoveries', async (req) => {
    return { discoveries: listDiscoveries(req.params.id) };
  });

  // Latest discovery
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/discovery', async (req) => {
    return { discovery: latestDiscovery(req.params.id) };
  });

  // Kick off a new discovery round-table.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/discovery', async (req, reply) => {
    const intake = loadIntake(req.params.id);
    if (!intake || !intake.goal.trim()) {
      reply.code(400); return { error: 'intake.goal must be set before running discovery' };
    }
    try {
      const rec = await runDiscovery({ workspaceId: req.params.id });
      // Hand off to plan-review per the workspace's planning mode.
      let plan = null;
      if (rec.synthesis) {
        plan = await planFromDiscoveryByMode({
          workspaceId: req.params.id,
          discoveryId: rec.id,
          synthesis: rec.synthesis,
          planningMode: intake.planningMode,
        });
      }
      return { discovery: rec, plan };
    } catch (err: any) {
      req.log.error(err);
      reply.code(500); return { error: String(err?.message ?? err) };
    }
  });
}
