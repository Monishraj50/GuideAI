import type { FastifyInstance } from 'fastify';
import { submitBrief } from '@guideai/orchestrator/cos';

export function registerBriefRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: {
      body: string;
      securityTagged?: boolean;
      /** Local filesystem path where the agents should write code. Becomes cwd. */
      targetFolder?: string;
      /** Catalog roles to ensure are hired before phase 1; missing ones auto-hire. */
      taggedAgents?: string[];
      /** Soft budget hint for the gate. `mode: tokens` uses raw token count;
       *  `mode: currency` uses USD. */
      budget?: { mode: 'tokens' | 'currency'; amount: number };
    };
  }>(
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
          targetFolder: req.body?.targetFolder?.trim() || undefined,
          taggedAgents: Array.isArray(req.body?.taggedAgents)
            ? req.body.taggedAgents.filter((r) => typeof r === 'string' && r.trim())
            : undefined,
          budget: req.body?.budget && typeof req.body.budget.amount === 'number'
            ? { mode: req.body.budget.mode, amount: req.body.budget.amount }
            : undefined,
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
