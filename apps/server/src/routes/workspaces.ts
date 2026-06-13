import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { computeRosterStats } from '@guideai/metrics';
import { readEvents } from '@guideai/messaging/events';
import { listPending } from '@guideai/orchestrator/approvals';
import { readLatestDigest } from '@guideai/orchestrator/digest';
import { paths } from '@guideai/shared/paths';
import fs from 'node:fs';
import path from 'node:path';

function slugify(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || `ws-${randomUUID().slice(0, 6)}`;
}

export function registerWorkspaceRoutes(app: FastifyInstance) {
  // List all workspaces with rich summaries for the /projects view.
  app.get('/api/workspaces', async () => {
    const db = getDb();
    const workspaces = db.select().from(schema.workspaces).all()
      .sort((a, b) => b.createdAt - a.createdAt);

    const summaries = await Promise.all(workspaces.map(async (w) => {
      const stats = computeRosterStats(w.id);
      const active = stats.filter((s) => s.status !== 'retired');
      const pending = listPending(w.id).length;
      const briefs = db.select().from(schema.briefs).all().filter((b) => b.workspaceId === w.id);
      const activeBriefs = briefs.filter((b) => b.status === 'active').length;
      const lastBrief = briefs.length > 0
        ? briefs.reduce((acc, cur) => cur.createdAt > acc.createdAt ? cur : acc)
        : null;
      const tokens = stats.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0);
      const usd = stats.reduce((s, a) => s + a.usd, 0);
      const lastActivity = stats.reduce<number | null>((m, a) => {
        if (a.lastActivity === null) return m;
        return m === null ? a.lastActivity : Math.max(m, a.lastActivity);
      }, null);
      const latestDigest = readLatestDigest(w.id);

      return {
        id: w.id,
        name: w.name,
        autonomyMode: w.autonomyMode,
        createdAt: w.createdAt,
        agents: active.length,
        pendingApprovals: pending,
        activeBriefs,
        totalBriefs: briefs.length,
        lastBrief: lastBrief ? { id: lastBrief.id, body: lastBrief.body, createdAt: lastBrief.createdAt, status: lastBrief.status } : null,
        tokens,
        usd,
        lastActivity,
        digestDate: latestDigest?.date ?? null,
      };
    }));

    return { count: summaries.length, workspaces: summaries };
  });

  // Create a new workspace. Body: { name }; id derived from slug.
  app.post<{ Body: { name: string } }>('/api/workspaces', async (req, reply) => {
    const name = (req.body?.name ?? '').toString().trim();
    if (!name) { reply.code(400); return { error: 'name is required' }; }
    const id = slugify(name);

    const db = getDb();
    const exists = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).all()[0];
    if (exists) { reply.code(409); return { error: `workspace "${id}" already exists` }; }

    db.insert(schema.workspaces).values({
      id, name,
      autonomyMode: 'approval-gated',
      createdAt: Date.now(),
    }).run();

    // Pre-create the on-disk workspace dir so writes don't race on first event.
    fs.mkdirSync(path.join(paths.workspaces, id), { recursive: true });

    return { id, name };
  });

  // Archive a workspace (soft delete — data on disk + DB rows are preserved).
  app.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (req, reply) => {
    const db = getDb();
    const row = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, req.params.id)).all()[0];
    if (!row) { reply.code(404); return { error: 'not found' }; }
    db.update(schema.workspaces).set({ autonomyMode: 'archived' })
      .where(eq(schema.workspaces.id, req.params.id)).run();
    return { ok: true, archived: req.params.id };
  });

  // Per-project "plan" surface: last digest + pending approvals + active briefs + counters.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/plan', async (req, reply) => {
    const db = getDb();
    const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, req.params.id)).all()[0];
    if (!ws) { reply.code(404); return { error: 'workspace not found' }; }
    const stats = computeRosterStats(req.params.id);
    const active = stats.filter((s) => s.status !== 'retired');
    const briefs = db.select().from(schema.briefs).all().filter((b) => b.workspaceId === req.params.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const tasks = db.select().from(schema.tasks).all();
    const tasksByBrief: Record<string, typeof tasks> = {};
    for (const t of tasks) (tasksByBrief[t.briefId] ??= []).push(t);

    const recentBriefs = briefs.slice(0, 10).map((b) => ({
      ...b,
      tasks: (tasksByBrief[b.id] ?? []).length,
      tokens: (tasksByBrief[b.id] ?? []).reduce((s, t) => s + t.tokensIn + t.tokensOut, 0),
    }));

    // Surface the last 30 events for at-a-glance recency.
    const { chunks } = await readEvents(req.params.id, { sinceTs: Date.now() - 24 * 60 * 60 * 1000 });
    const recentChunks = chunks.slice(-30).reverse();

    return {
      workspace: ws,
      agents: { active: active.length, total: stats.length },
      pendingApprovals: listPending(req.params.id),
      digest: readLatestDigest(req.params.id),
      briefs: { recent: recentBriefs, total: briefs.length, active: briefs.filter((b) => b.status === 'active').length },
      tokens: stats.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0),
      usd: stats.reduce((s, a) => s + a.usd, 0),
      recentChunks,
    };
  });
}
