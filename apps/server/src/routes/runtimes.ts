import type { FastifyInstance } from 'fastify';
import { ClaudeAdapter } from '@guideai/runtime-claude';
import { listRuntimes } from '@guideai/runtime-core/registry';

export function registerRuntimeRoutes(app: FastifyInstance) {
  app.get('/api/runtimes', async () => ({
    runtimes: listRuntimes(ClaudeAdapter),
  }));
}
