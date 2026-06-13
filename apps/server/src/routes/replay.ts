import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { readEvents } from '@guideai/messaging/events';
import type { Chunk } from '@guideai/shared/chunks';

export function registerReplayRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/briefs',
    async (req) => {
      const db = getDb();
      const briefs = db.select().from(schema.briefs).all()
        .filter((b) => b.workspaceId === req.params.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      const tasks = db.select().from(schema.tasks).all();
      const byBrief: Record<string, typeof tasks> = {};
      for (const t of tasks) (byBrief[t.briefId] ??= []).push(t);
      return {
        briefs: briefs.map((b) => {
          const ts = byBrief[b.id] ?? [];
          return {
            id: b.id,
            body: b.body,
            status: b.status,
            createdAt: b.createdAt,
            phaseCount: ts.length,
            tokensIn: ts.reduce((s, t) => s + (t.tokensIn ?? 0), 0),
            tokensOut: ts.reduce((s, t) => s + (t.tokensOut ?? 0), 0),
          };
        }),
      };
    },
  );

  app.get<{ Params: { id: string; briefId: string } }>(
    '/api/workspaces/:id/briefs/:briefId',
    async (req, reply) => {
      const db = getDb();
      const brief = db.select().from(schema.briefs).where(eq(schema.briefs.id, req.params.briefId)).all()[0];
      if (!brief) { reply.code(404); return { error: 'brief not found' }; }

      const tasks = db.select().from(schema.tasks).all()
        .filter((t) => t.briefId === req.params.briefId)
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

      // Filter the workspace event log down to chunks relevant to this brief:
      // either the user chunk that matches its body, or phase chunks tagged
      // with this taskId, or any chunk whose ts falls within the brief window.
      const startTs = brief.createdAt;
      const endTs = tasks.reduce((m, t) => Math.max(m, t.endedAt ?? t.startedAt ?? 0), startTs) || Date.now();
      const { chunks } = await readEvents(req.params.id, { sinceTs: startTs });
      const relevant: Chunk[] = chunks.filter((c) => {
        if (c.ts > endTs + 2000) return false;          // 2s buffer for tail events
        if (c.kind === 'phase' && c.taskId !== brief.id) return false;
        return true;
      });

      // Pull artifact contents if files exist.
      const artifacts: Record<string, { phase: string; path: string; body: string }> = {};
      for (const t of tasks) {
        if (t.artifactPath && fs.existsSync(t.artifactPath)) {
          artifacts[t.phase] = { phase: t.phase, path: t.artifactPath, body: fs.readFileSync(t.artifactPath, 'utf8') };
        }
      }

      return {
        brief,
        tasks,
        chunks: relevant,
        artifacts,
        window: { startTs, endTs },
      };
    },
  );
}
