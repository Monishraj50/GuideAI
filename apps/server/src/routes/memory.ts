import type { FastifyInstance } from 'fastify';
import {
  listMemoryByWorkspace, createMemory, deleteMemory,
  getMemoryShare, setMemoryShare, loadAgentMemoryForRole,
  type MemoryShare,
} from '@guideai/orchestrator/memory';

export function registerMemoryRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { role?: string } }>(
    '/api/workspaces/:id/memory', async (req) => {
      const entries = listMemoryByWorkspace(req.params.id, req.query.role ? { role: req.query.role } : undefined);
      const share = getMemoryShare(req.params.id);
      return { entries, share };
    });

  app.post<{ Params: { id: string }; Body: { role: string; body: string } }>(
    '/api/workspaces/:id/memory', async (req, reply) => {
      try {
        const e = createMemory({
          workspaceId: req.params.id,
          role: req.body?.role,
          body: req.body?.body,
          source: 'manual',
        });
        return { entry: e };
      } catch (err: any) {
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    deleteMemory(req.params.id);
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { share: MemoryShare } }>(
    '/api/workspaces/:id/memory/share', async (req, reply) => {
      try {
        setMemoryShare(req.params.id, req.body?.share);
        return { share: getMemoryShare(req.params.id) };
      } catch (err: any) {
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    });

  // Inspect what a role would see when running in this workspace.
  app.get<{ Params: { id: string; role: string } }>(
    '/api/workspaces/:id/memory/effective/:role', async (req) => {
      const entries = loadAgentMemoryForRole({
        role: req.params.role, currentWorkspaceId: req.params.id,
      });
      return { entries };
    });
}
