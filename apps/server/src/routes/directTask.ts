import type { FastifyInstance } from 'fastify';
import { runSingleAgent, runAutoFix } from '@guideai/orchestrator/directTask';

export function registerDirectTaskRoutes(app: FastifyInstance) {
  // Ask one specific agent to do one specific thing. No round-table, no critic.
  app.post<{
    Params: { id: string };
    Body: { agentId: string; prompt: string; cwd?: string };
  }>('/api/workspaces/:id/direct-task', async (req, reply) => {
    try {
      const body = req.body ?? ({} as any);
      if (!body.agentId?.trim() || !body.prompt?.trim()) {
        reply.code(400); return { error: 'agentId and prompt are required' };
      }
      const run = await runSingleAgent({
        workspaceId: req.params.id,
        agentId: body.agentId,
        prompt: body.prompt,
        cwd: body.cwd,
      });
      return { run };
    } catch (err: any) {
      req.log.error(err);
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  // Describe what's broken / what to do; we route to a relevant agent
  // (auto-hiring one if no current roster match) and run them solo.
  app.post<{
    Params: { id: string };
    Body: { description: string; cwd?: string; hire?: boolean };
  }>('/api/workspaces/:id/auto-fix', async (req, reply) => {
    try {
      const body = req.body ?? ({} as any);
      if (!body.description?.trim()) {
        reply.code(400); return { error: 'description is required' };
      }
      const run = await runAutoFix({
        workspaceId: req.params.id,
        description: body.description,
        cwd: body.cwd,
        hire: body.hire,
      });
      return { run };
    } catch (err: any) {
      req.log.error(err);
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });
}
