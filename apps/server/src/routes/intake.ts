// S2 fixup: minimal intake routes restored after S1 strip.
//
// The full intake stack (round-table runner, budget forecaster, plan
// composer) was deleted in S1. The vscode `newProject` webview still
// needs to PUT the user's goal/budget so we don't block project
// creation. This route writes straight to the projectIntakes table via
// the kept saveIntake/loadIntake helpers in orchestrator/discovery.ts.

import type { FastifyInstance } from 'fastify';
import {
  loadIntake, saveIntake,
  type BudgetUnit, type PlanningMode, type HireMode,
} from '@guideai/orchestrator/discovery';

interface IntakePutBody {
  goal?: string;
  successCriteria?: string[];
  constraints?: string[];
  budgetHintUsd?: number | null;
  budgetHintUnit?: BudgetUnit;
  planningMode?: PlanningMode;
  hireMode?: HireMode;
  discoveryContext?: string;
  /** Plan-editor: model tier for Phase 1 (Plan). haiku | sonnet | opus */
  preferredModel?: string;
}

export function registerIntakeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/intake',
    async (req, reply) => {
      const intake = loadIntake(req.params.id);
      if (!intake) { reply.code(404); return { error: 'intake not set' }; }
      return intake;
    },
  );

  app.put<{ Params: { id: string }; Body: IntakePutBody }>(
    '/api/workspaces/:id/intake',
    async (req, reply) => {
      const b = req.body ?? {};
      const existing = loadIntake(req.params.id);
      try {
        saveIntake({
          workspaceId: req.params.id,
          goal: b.goal ?? existing?.goal ?? '',
          successCriteria: Array.isArray(b.successCriteria) ? b.successCriteria : existing?.successCriteria ?? [],
          constraints: Array.isArray(b.constraints) ? b.constraints : existing?.constraints ?? [],
          budgetHintUsd: b.budgetHintUsd ?? existing?.budgetHintUsd ?? null,
          budgetHintUnit: b.budgetHintUnit ?? existing?.budgetHintUnit ?? 'USD',
          planningMode: b.planningMode ?? existing?.planningMode ?? 'assisted',
          hireMode: b.hireMode ?? existing?.hireMode ?? 'manual',
          locked: existing?.locked ?? false,
          lockedAt: existing?.lockedAt ?? null,
          discoveryContext: b.discoveryContext ?? existing?.discoveryContext ?? '',
          preferredModel: b.preferredModel ?? (existing as any)?.preferredModel ?? 'sonnet',
        } as any);
        return loadIntake(req.params.id);
      } catch (err: any) {
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    },
  );

  // S1 strip: discovery round-table runner removed; the webview's optional
  // "run discovery" toggle gets a clean 410 instead of a confusing 404.
  app.post('/api/workspaces/:id/discovery', async (_req, reply) => {
    reply.code(410);
    return { error: 'discovery round-table removed in v2' };
  });
}
