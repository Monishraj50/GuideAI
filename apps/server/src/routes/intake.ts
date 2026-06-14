import type { FastifyInstance } from 'fastify';
import {
  loadIntake, saveIntake, runDiscovery, latestDiscovery, listDiscoveries,
  type IntakeRecord, type PlanningMode, type HireMode,
} from '@guideai/orchestrator/discovery';

const PLANNING: PlanningMode[] = ['auto', 'assisted', 'manual'];
const HIRING: HireMode[] = ['auto', 'manual', 'hybrid'];

function defaultsFor(workspaceId: string): IntakeRecord {
  return {
    workspaceId,
    goal: '',
    successCriteria: [],
    constraints: [],
    budgetHintUsd: null,
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
      planningMode: PLANNING.includes(body.planningMode as PlanningMode)
        ? (body.planningMode as PlanningMode) : current.planningMode,
      hireMode: HIRING.includes(body.hireMode as HireMode)
        ? (body.hireMode as HireMode) : current.hireMode,
    };
    if (next.budgetHintUsd != null && !Number.isFinite(next.budgetHintUsd)) {
      reply.code(400); return { error: 'budgetHintUsd must be a number or null' };
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
      return { discovery: rec };
    } catch (err: any) {
      req.log.error(err);
      reply.code(500); return { error: String(err?.message ?? err) };
    }
  });
}
