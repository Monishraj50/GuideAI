import type { FastifyInstance } from 'fastify';
import { computeRosterStats } from '@guideai/metrics';

export function registerMetricRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/metrics',
    async (req) => ({ agents: computeRosterStats(req.params.id) }),
  );
}
