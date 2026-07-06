// S12 · Pack management API.
//
// GET  /api/packs                        → list installed packs + status
// POST /api/packs   { fromPath | fromGitUrl } → install
// DELETE /api/packs/:name                → uninstall

import type { FastifyInstance } from 'fastify';
import { listPacks, installPack, uninstallPack } from '@guideai/orchestrator/packs';

export function registerPackRoutes(app: FastifyInstance) {
  app.get('/api/packs', async () => {
    const packs = listPacks();
    return {
      count: packs.length,
      packs: packs.map((p) => ({
        name: p.name, version: p.manifest.version,
        description: p.manifest.description ?? null,
        tags: p.manifest.tags ?? [],
        skillCount: p.skillCount,
        installedAt: p.installedAt,
        hasMissingReqs: p.hasMissingReqs,
        missing: p.missing,
      })),
    };
  });

  app.post<{
    Body: { fromPath?: string; fromGitUrl?: string; force?: boolean };
  }>('/api/packs', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.fromPath && !body.fromGitUrl) {
      reply.code(400);
      return { error: 'fromPath or fromGitUrl required' };
    }
    try {
      const pack = installPack({
        fromPath: body.fromPath,
        fromGitUrl: body.fromGitUrl,
        force: !!body.force,
      });
      return {
        ok: true,
        name: pack.name, version: pack.manifest.version,
        skillCount: pack.skillCount,
        hasMissingReqs: pack.hasMissingReqs,
        missing: pack.missing,
      };
    } catch (err: any) {
      reply.code(400);
      return { error: String(err?.message ?? err) };
    }
  });

  app.delete<{ Params: { name: string } }>('/api/packs/:name', async (req, reply) => {
    const r = uninstallPack(req.params.name);
    if (!r.ok) { reply.code(404); return { error: 'pack not found' }; }
    return { ok: true, removed: r.removed };
  });
}
