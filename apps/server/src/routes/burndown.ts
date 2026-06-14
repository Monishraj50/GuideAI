import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '@guideai/shared/db';
import { loadIntake } from '@guideai/orchestrator/discovery';

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);  // YYYY-MM-DD UTC
}

/**
 * Aggregate the data the dashboard needs to render burndown + cost-burndown +
 * velocity. Cheap — single pass over work_items + usage_log.
 */
export function registerBurndownRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/workspaces/:id/burndown', async (req) => {
      const days = Math.max(1, Math.min(120, Number(req.query.days ?? 30)));
      const db = getDb();
      const now = Date.now();
      // Include today in the window: (days-1) days ago → today (inclusive).
      const startMs = now - (days - 1) * DAY_MS;

      const items = db.select().from(schema.workItems).all()
        .filter((r) => r.workspaceId === req.params.id);
      const usage = db.select().from(schema.usageLog).all()
        .filter((r) => r.workspaceId === req.params.id && r.ts >= startMs);

      const totalItems = items.length;
      const doneItems  = items.filter((i) => i.status === 'done').length;
      const openItems  = totalItems - doneItems - items.filter((i) => i.status === 'cancelled').length;
      const totalUsd   = db.select().from(schema.usageLog).all()
        .filter((r) => r.workspaceId === req.params.id)
        .reduce((s, r) => s + (r.costUsd ?? 0), 0);

      // Per-day buckets.
      const completedByDay: Record<string, number> = {};
      for (const i of items) {
        if (i.status === 'done' && i.completedAt && i.completedAt >= startMs) {
          const k = dayKey(i.completedAt);
          completedByDay[k] = (completedByDay[k] ?? 0) + 1;
        }
      }
      const usdByDay: Record<string, number> = {};
      for (const u of usage) {
        const k = dayKey(u.ts);
        usdByDay[k] = (usdByDay[k] ?? 0) + (u.costUsd ?? 0);
      }

      // Build the ordered day series.
      const series: {
        date: string;
        completed: number;
        cumulativeCompleted: number;
        remaining: number;          // open items at end-of-day
        usdSpent: number;
        cumulativeUsd: number;
      }[] = [];
      let cumComp = 0;
      let cumUsd = 0;
      // We can't recover historical "remaining" snapshots exactly without a snapshot
      // table; we model it as totalItems − cumulativeCompleted as a proxy.
      for (let d = 0; d < days; d++) {
        const ms = startMs + d * DAY_MS;
        const key = dayKey(ms);
        const completed = completedByDay[key] ?? 0;
        cumComp += completed;
        const usd = usdByDay[key] ?? 0;
        cumUsd += usd;
        series.push({
          date: key,
          completed,
          cumulativeCompleted: cumComp,
          remaining: Math.max(0, totalItems - cumComp),
          usdSpent: usd,
          cumulativeUsd: cumUsd,
        });
      }

      // Velocity = items completed in the most recent 7 days.
      const velocity7d = series.slice(-7).reduce((s, r) => s + r.completed, 0);
      const velocity1d = series[series.length - 1]?.completed ?? 0;

      const intake = loadIntake(req.params.id);

      return {
        totals: {
          items: totalItems,
          done: doneItems,
          open: openItems,
          inProgress: items.filter((i) => i.status === 'in_progress').length,
          blocked: items.filter((i) => i.status === 'blocked').length,
          usd: totalUsd,
          budgetHintUsd: intake?.budgetHintUsd ?? null,
        },
        velocity: { last7d: velocity7d, today: velocity1d },
        series,
      };
    });
}
