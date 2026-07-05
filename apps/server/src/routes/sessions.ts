// S7 · Sessions API — group + query the `sessions` table for the UI.
//
// GET  /api/workspaces/:id/sessions/features  → sessions grouped by feature
// POST /api/workspaces/:id/sessions/pick      → run pickSession for a query
//                                                (surfaces the scorer to the UI)
import type { FastifyInstance } from 'fastify';
import { listSessionsGroupedByFeature, pickSession } from '@guideai/orchestrator/resume';
import { getDb, schema } from '@guideai/shared/db';

export function registerSessionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/sessions/features',
    async (req) => {
      const groups = listSessionsGroupedByFeature(req.params.id);
      // Enrich with the sourceBrief snippet so the UI can render "Did …"
      // without a second round trip.
      const db = getDb();
      const briefsById = new Map<string, string>();
      for (const b of db.select().from(schema.briefs).all()) {
        briefsById.set(b.id, b.body ?? '');
      }
      return {
        count: groups.reduce((s, g) => s + g.sessions.length, 0),
        features: groups.map((g) => ({
          featureSlug: g.featureSlug,
          sessions: g.sessions.map((s) => ({
            ...s,
            briefSnippet: (briefsById.get(s.briefId ?? '') ?? '').slice(0, 200),
          })),
        })),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { featureSlug?: string | null; query: string };
  }>(
    '/api/workspaces/:id/sessions/pick',
    async (req, reply) => {
      const query = (req.body?.query ?? '').toString().trim();
      if (!query) { reply.code(400); return { error: 'query required' }; }
      const hit = pickSession({
        workspaceId: req.params.id,
        featureSlug: req.body?.featureSlug ?? null,
        query,
      });
      return hit
        ? { picked: hit.session, score: hit.score, reason: hit.reason }
        : { picked: null };
    },
  );
}
