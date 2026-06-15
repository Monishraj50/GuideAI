import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb, schema } from '@guideai/shared/db';
import {
  loadTarget, saveTarget, listValidationRuns, getValidationRun, latestValidationRun,
  runValidation, rerunValidation, isUrlInAllowlist,
} from '@guideai/orchestrator/validate';
import { loadIntake } from '@guideai/orchestrator/discovery';

function loadSynthesisForBrief(workspaceId: string, briefId: string): any | null {
  const db = getDb();
  const plan = db.select().from(schema.plans).all()
    .find((p) => p.workspaceId === workspaceId && p.briefId === briefId);
  if (!plan) return null;
  try { return JSON.parse(plan.editedSynthesisJson); } catch { return null; }
}

function safeOrigin(s: string): string | null {
  try { const u = new URL(s); return `${u.protocol}//${u.host}`; } catch { return null; }
}

export function registerValidationRoutes(app: FastifyInstance) {
  // GET / PUT target config
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/target', async (req) => {
    return { target: loadTarget(req.params.id) };
  });

  app.put<{
    Params: { id: string };
    Body: { targetUrl?: string | null; allowlist?: string[] };
  }>('/api/workspaces/:id/target', async (req, reply) => {
    try {
      const body = req.body ?? ({} as any);
      if (body.targetUrl) {
        if (!safeOrigin(body.targetUrl)) {
          reply.code(400); return { error: 'targetUrl must be a valid URL' };
        }
      }
      if (body.allowlist && !Array.isArray(body.allowlist)) {
        reply.code(400); return { error: 'allowlist must be an array' };
      }
      const target = saveTarget({
        workspaceId: req.params.id,
        targetUrl: body.targetUrl,
        allowlist: body.allowlist,
      });
      return { target };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  // List + get
  app.get<{ Params: { id: string }; Querystring: { briefId?: string } }>(
    '/api/workspaces/:id/validations', async (req) => {
      const runs = listValidationRuns(req.params.id, req.query.briefId ? { briefId: req.query.briefId } : undefined);
      return { runs };
    });

  app.get<{ Params: { id: string } }>('/api/validations/:id', async (req, reply) => {
    const run = getValidationRun(req.params.id);
    if (!run) { reply.code(404); return { error: 'not found' }; }
    return { run };
  });

  // Kick a fresh validation against a brief (manual run).
  app.post<{ Params: { id: string; briefId: string } }>(
    '/api/workspaces/:id/briefs/:briefId/validate',
    async (req, reply) => {
      try {
        const cfg = loadTarget(req.params.id);
        if (!cfg.targetUrl) { reply.code(400); return { error: 'target_url not set for this workspace' }; }
        if (!isUrlInAllowlist(cfg.targetUrl, cfg.allowlist)) {
          reply.code(400); return { error: `target_url origin not in allowlist: ${cfg.targetUrl}` };
        }
        const db = getDb();
        const brief = db.select().from(schema.briefs).all()
          .find((b) => b.id === req.params.briefId && b.workspaceId === req.params.id);
        if (!brief) { reply.code(404); return { error: 'brief not found' }; }
        const synthesis = loadSynthesisForBrief(req.params.id, req.params.briefId);
        const intake = loadIntake(req.params.id);
        const run = await runValidation({
          workspaceId: req.params.id, briefId: req.params.briefId,
          briefBody: brief.body, synthesis, intake,
          source: 'manual',
        });
        return { run };
      } catch (err: any) {
        req.log.error(err);
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    });

  // Re-run an existing persisted script (no LLM).
  app.post<{ Params: { id: string } }>('/api/validations/:id/rerun', async (req, reply) => {
    try {
      const run = await rerunValidation({ runId: req.params.id });
      return { run };
    } catch (err: any) {
      req.log.error(err);
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { briefId?: string } }>(
    '/api/workspaces/:id/validation/latest', async (req) => {
      return { run: latestValidationRun(req.params.id, req.query.briefId) };
    });

  // Stream a screenshot file. Path-traversal hardened via basename + dir match.
  app.get<{ Params: { id: string; name: string } }>(
    '/api/validations/:id/screenshots/:name', async (req, reply: FastifyReply) => {
      const run = getValidationRun(req.params.id);
      if (!run?.screenshotsDir) { reply.code(404); return { error: 'no screenshots for run' }; }
      const safeName = path.basename(req.params.name);
      if (!/^[\w.-]+\.png$/.test(safeName)) { reply.code(400); return { error: 'bad filename' }; }
      const file = path.join(run.screenshotsDir, safeName);
      // Final guard — make sure the resolved path is inside the screenshots dir.
      if (!file.startsWith(path.resolve(run.screenshotsDir) + path.sep)) {
        reply.code(400); return { error: 'invalid path' };
      }
      if (!fs.existsSync(file)) { reply.code(404); return { error: 'not found' }; }
      reply.type('image/png');
      return reply.send(fs.createReadStream(file));
    });
}
