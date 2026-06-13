import type { FastifyInstance } from 'fastify';
import { decideApproval, listPending } from '@guideai/orchestrator/approvals';

export function registerApprovalRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/approvals/pending',
    async (req) => {
      return { pending: listPending(req.params.id) };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { decision: 'approved' | 'denied' };
  }>(
    '/api/approvals/:id',
    async (req, reply) => {
      const decision = req.body?.decision;
      if (decision !== 'approved' && decision !== 'denied') {
        reply.code(400);
        return { error: 'decision must be "approved" or "denied"' };
      }
      try {
        // approvalId carries no workspace id, so we resolve it via the chunk's
        // workspace context. For step 5 we accept a workspaceId query for simplicity.
        const workspaceId = (req.query as { workspace?: string })?.workspace;
        if (!workspaceId) {
          reply.code(400);
          return { error: 'missing ?workspace=... query' };
        }
        return decideApproval({
          workspaceId,
          approvalId: req.params.id,
          decision,
        });
      } catch (err: any) {
        req.log.error(err);
        reply.code(409);
        return { error: String(err?.message ?? err) };
      }
    },
  );
}
