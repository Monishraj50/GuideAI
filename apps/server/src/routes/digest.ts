import type { FastifyInstance } from 'fastify';
import cron from 'node-cron';
import { generateDigest, readLatestDigest } from '@guideai/orchestrator/digest';
import { getDb, schema } from '@guideai/shared/db';

const DAILY_CRON = '0 9 * * *';        // 09:00 local every day
const DEFAULT_WORKSPACE = 'demo';

export function registerDigestRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/digest',
    async (req) => {
      const latest = readLatestDigest(req.params.id);
      return latest ?? { date: null, text: null, summary: null };
    },
  );

  app.post<{ Params: { id: string }; Querystring: { window?: string } }>(
    '/api/workspaces/:id/digest',
    async (req, reply) => {
      const windowMs = req.query.window ? Number(req.query.window) : undefined;
      try { return await generateDigest({ workspaceId: req.params.id, windowMs }); }
      catch (e: any) { reply.code(500); return { error: String(e?.message ?? e) }; }
    },
  );

  // Schedule the daily 09:00 cron. Runs across every workspace that exists
  // when the tick fires — keeps the demo simple. Server logs each tick.
  cron.schedule(DAILY_CRON, async () => {
    try {
      const db = getDb();
      const workspaces = db.select().from(schema.workspaces).all();
      const ids = workspaces.length > 0
        ? workspaces.map((w) => w.id)
        : [DEFAULT_WORKSPACE];
      app.log.info({ count: ids.length }, '[cron] daily digest tick');
      for (const id of ids) {
        try { await generateDigest({ workspaceId: id }); }
        catch (e: any) { app.log.error({ err: e?.message, ws: id }, '[cron] digest failed'); }
      }
    } catch (e: any) {
      app.log.error({ err: e?.message }, '[cron] tick error');
    }
  }, { timezone: process.env.TZ });
}
