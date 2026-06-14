import type { FastifyInstance } from 'fastify';
import {
  loadBudget, saveBudget, summarizeUsage, type Behavior,
} from '@guideai/policies/budgets';
import { getDb, schema } from '@guideai/shared/db';

export function registerBudgetRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/budget',
    async (req) => {
      const cfg = loadBudget(req.params.id);
      const usage = summarizeUsage(req.params.id, cfg);
      return { config: cfg, usage };
    },
  );

  app.put<{ Params: { id: string }; Body: { dailyUsdCap?: number | null; monthlyUsdCap?: number | null; tokensPer5hCap?: number | null; behavior?: Behavior } }>(
    '/api/workspaces/:id/budget',
    async (req, reply) => {
      const body = req.body ?? {};
      const allowed: Behavior[] = ['warn', 'downgrade', 'pause'];
      const behavior: Behavior = allowed.includes((body.behavior ?? 'downgrade') as Behavior)
        ? (body.behavior ?? 'downgrade') as Behavior
        : 'downgrade';
      saveBudget({
        workspaceId: req.params.id,
        dailyUsdCap:    body.dailyUsdCap   ?? undefined,
        monthlyUsdCap:  body.monthlyUsdCap ?? undefined,
        tokensPer5hCap: body.tokensPer5hCap ?? undefined,
        behavior,
      });
      const cfg = loadBudget(req.params.id);
      const usage = summarizeUsage(req.params.id, cfg);
      reply.code(200);
      return { config: cfg, usage };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { groupBy?: 'tier' | 'phase' | 'agent' } }>(
    '/api/workspaces/:id/usage',
    async (req) => {
      const db = getDb();
      const rows = db.select().from(schema.usageLog).all()
        .filter((r) => r.workspaceId === req.params.id)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 500);
      return { count: rows.length, rows };
    },
  );
}
