import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';

export function registerSecondOpinionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/second-opinion',
    async (req, reply) => {
      const db = getDb();
      const ws = db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, req.params.id)).all()[0];
      if (!ws) { reply.code(404); return { error: 'workspace not found' }; }
      return { enabled: !!(ws as any).secondOpinionEnabled };
    });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/workspaces/:id/second-opinion',
    async (req, reply) => {
      const db = getDb();
      const ws = db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, req.params.id)).all()[0];
      if (!ws) { reply.code(404); return { error: 'workspace not found' }; }
      const enabled = !!req.body?.enabled;
      db.update(schema.workspaces).set({ secondOpinionEnabled: enabled ? 1 : 0 } as any)
        .where(eq(schema.workspaces.id, req.params.id)).run();
      return { enabled };
    });
}
