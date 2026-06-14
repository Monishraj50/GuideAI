import type { FastifyInstance } from 'fastify';
import {
  listPlans, latestPlan, getPlan, createPlanFromDiscovery, savePlanEdits,
  approvePlan, rejectPlan, previewHires,
  type PlanRecord,
} from '@guideai/orchestrator/planReview';
import { loadIntake, latestDiscovery, type DiscoverySynthesis } from '@guideai/orchestrator/discovery';

export function registerPlanRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/plan-reviews', async (req) => {
    return { plans: listPlans(req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/workspaces/:id/plan-review', async (req) => {
    return { plan: latestPlan(req.params.id) };
  });

  // Create a new draft plan from the latest discovery synthesis.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/plan-review', async (req, reply) => {
    try {
      const plan = createPlanFromDiscovery({ workspaceId: req.params.id });
      return { plan };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  // Live hire preview for the latest plan (so the UI can show what would
  // happen before the user clicks approve).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/plan-review/hire-preview', async (req, reply) => {
    const plan = latestPlan(req.params.id);
    if (!plan) { reply.code(404); return { error: 'no plan yet' }; }
    const intake = loadIntake(req.params.id);
    const preview = previewHires({
      workspaceId: req.params.id,
      roles: plan.synthesis.recommendedRoles,
      hireMode: intake?.hireMode ?? 'manual',
    });
    return { plan, preview };
  });

  app.put<{
    Params: { id: string };
    Body: { synthesis?: Partial<DiscoverySynthesis>; notes?: string };
  }>('/api/plans/:id', async (req, reply) => {
    try {
      const current = getPlan(req.params.id);
      if (!current) { reply.code(404); return { error: 'plan not found' }; }
      const synth: DiscoverySynthesis = req.body?.synthesis
        ? mergeSynthesis(current.synthesis, req.body.synthesis)
        : current.synthesis;
      const plan = savePlanEdits({
        planId: req.params.id,
        synthesis: synth,
        notes: req.body?.notes,
      });
      return { plan };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.post<{ Params: { id: string }; Body?: { forceDispatch?: boolean } }>(
    '/api/plans/:id/approve',
    async (req, reply) => {
      try {
        const plan = await approvePlan({
          planId: req.params.id,
          forceDispatch: !!req.body?.forceDispatch,
        });
        return { plan };
      } catch (err: any) {
        req.log.error(err);
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/plans/:id/reject', async (req, reply) => {
    try {
      const plan = rejectPlan(req.params.id);
      return { plan };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
    const plan = getPlan(req.params.id);
    if (!plan) { reply.code(404); return { error: 'plan not found' }; }
    return { plan };
  });
}

function mergeSynthesis(cur: DiscoverySynthesis, patch: Partial<DiscoverySynthesis>): DiscoverySynthesis {
  return {
    recommendedRoles: arr(patch.recommendedRoles, cur.recommendedRoles),
    riskFlags:        arr(patch.riskFlags,        cur.riskFlags),
    successMetrics:   arr(patch.successMetrics,   cur.successMetrics),
    benefits:         arr(patch.benefits,         cur.benefits),
    costEstimateUsd:  patch.costEstimateUsd === undefined ? cur.costEstimateUsd
                       : (patch.costEstimateUsd === null ? null : Number(patch.costEstimateUsd)),
    costVerdict:      (patch.costVerdict ?? cur.costVerdict) as DiscoverySynthesis['costVerdict'],
    securityTag:      (patch.securityTag ?? cur.securityTag) as DiscoverySynthesis['securityTag'],
    summary:          typeof patch.summary === 'string' ? patch.summary : cur.summary,
  };
}
function arr(next: string[] | undefined, cur: string[]): string[] {
  if (!Array.isArray(next)) return cur;
  return next.map((s) => String(s).trim()).filter(Boolean);
}
