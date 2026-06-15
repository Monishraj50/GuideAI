import type { FastifyInstance } from 'fastify';
import {
  loadIntake, saveIntake, runDiscovery, latestDiscovery, listDiscoveries,
  type IntakeRecord, type PlanningMode, type HireMode, type BudgetUnit,
} from '@guideai/orchestrator/discovery';
import { planFromDiscoveryByMode } from '@guideai/orchestrator/planReview';

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
    }>;
  }>('/api/workspaces/:id/intake', async (req, reply) => {
    const body = req.body ?? {};
    const current = loadIntake(req.params.id) ?? defaultsFor(req.params.id);
    const next: IntakeRecord = {
      workspaceId: req.params.id,
      goal: typeof body.goal === 'string' ? body.goal : current.goal,
      successCriteria: Array.isArray(body.successCriteria)
        ? body.successCriteria.map(String).map((s) => s.trim()).filter(Boolean)
        : current.successCriteria,
      constraints: Array.isArray(body.constraints)
        ? body.constraints.map(String).map((s) => s.trim()).filter(Boolean)
        : current.constraints,
      budgetHintUsd: body.budgetHintUsd === undefined ? current.budgetHintUsd
        : (body.budgetHintUsd === null ? null : Number(body.budgetHintUsd)),
      budgetHintUnit: BUDGET_UNITS.includes(body.budgetHintUnit as BudgetUnit)
        ? (body.budgetHintUnit as BudgetUnit) : current.budgetHintUnit,
      planningMode: PLANNING.includes(body.planningMode as PlanningMode)
        ? (body.planningMode as PlanningMode) : current.planningMode,
      hireMode: HIRING.includes(body.hireMode as HireMode)
        ? (body.hireMode as HireMode) : current.hireMode,
    };
    if (next.budgetHintUsd != null && !Number.isFinite(next.budgetHintUsd)) {
      reply.code(400); return { error: 'budget amount must be a number or null' };
    }
    if (next.budgetHintUsd != null && next.budgetHintUsd < 0) {
      reply.code(400); return { error: 'budget amount cannot be negative' };
    }
    saveIntake(next);
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
