import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '@guideai/shared/db';
import {
  listDeliverables, getDeliverable, createDeliverable, deleteDeliverable,
  harvestBriefDeliverables,
  type DeliverableKind,
} from '@guideai/orchestrator/deliverables';

const KINDS: DeliverableKind[] = ['artifact', 'slide-deck', 'explainer', 'link', 'file'];

export function registerDeliverableRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { briefId?: string; kind?: DeliverableKind } }>(
    '/api/workspaces/:id/deliverables', async (req) => {
      const items = listDeliverables(req.params.id, {
        briefId: req.query.briefId,
        kind: KINDS.includes(req.query.kind as DeliverableKind) ? req.query.kind : undefined,
      });
      return { items };
    });

  app.get<{ Params: { id: string } }>('/api/deliverables/:id', async (req, reply) => {
    const item = getDeliverable(req.params.id);
    if (!item) { reply.code(404); return { error: 'not found' }; }
    return { item };
  });

  // Manual add — link or file.
  app.post<{
    Params: { id: string };
    Body: { briefId?: string | null; kind: DeliverableKind; title: string; body?: string | null; uri?: string | null };
  }>('/api/workspaces/:id/deliverables', async (req, reply) => {
    try {
      const body = req.body ?? ({} as any);
      if (!KINDS.includes(body.kind)) {
        reply.code(400); return { error: `kind must be one of ${KINDS.join('|')}` };
      }
      const item = createDeliverable({
        workspaceId: req.params.id,
        briefId: body.briefId ?? null,
        kind: body.kind,
        title: body.title,
        body: body.body ?? null,
        uri: body.uri ?? null,
        source: 'manual',
      });
      return { item };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/deliverables/:id', async (req, reply) => {
    try {
      deleteDeliverable(req.params.id);
      return { ok: true };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  // Regenerate deliverables for a brief (re-harvest artifacts, re-make deck +
  // explainer). Useful if the user edits the plan synthesis after dispatch.
  app.post<{ Params: { id: string; briefId: string } }>(
    '/api/workspaces/:id/briefs/:briefId/deliverables/regenerate',
    async (req, reply) => {
      try {
        const db = getDb();
        const brief = db.select().from(schema.briefs).all()
          .find((b) => b.id === req.params.briefId && b.workspaceId === req.params.id);
        if (!brief) { reply.code(404); return { error: 'brief not found' }; }
        const plan = db.select().from(schema.plans).all()
          .find((p) => p.briefId === req.params.briefId);
        const synthesis = plan?.editedSynthesisJson ? JSON.parse(plan.editedSynthesisJson) : null;
        const result = await harvestBriefDeliverables({
          workspaceId: req.params.id,
          briefId: req.params.briefId,
          briefBody: brief.body,
          synthesis,
        });
        return {
          artifacts: result.artifacts.length,
          deck: result.deck ? { id: result.deck.id, title: result.deck.title } : null,
          explainer: result.explainer ? { id: result.explainer.id, title: result.explainer.title } : null,
        };
      } catch (err: any) {
        req.log.error(err);
        reply.code(500); return { error: String(err?.message ?? err) };
      }
    });
}
