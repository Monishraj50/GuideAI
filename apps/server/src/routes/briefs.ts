import type { FastifyInstance } from 'fastify';
import { submitBrief } from '@guideai/orchestrator/cos';

export function registerBriefRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { body: string; securityTagged?: boolean } }>(
    '/api/workspaces/:id/briefs',
    async (req, reply) => {
      const body = (req.body?.body ?? '').toString().trim();
      if (!body) {
        reply.code(400);
        return { error: 'body is required' };
      }
      try {
        const result = await submitBrief({
          workspaceId: req.params.id,
          body,
          securityTagged: !!req.body?.securityTagged,
        });
        return result;
      } catch (err: any) {
        req.log.error(err);
        reply.code(500);
        return { error: String(err?.message ?? err) };
      }
    },
  );
}
