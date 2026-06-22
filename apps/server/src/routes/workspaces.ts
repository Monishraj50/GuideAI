import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { computeRosterStats } from '@guideai/metrics';
import { readEvents } from '@guideai/messaging/events';
import { listPending } from '@guideai/orchestrator/approvals';
import { readLatestDigest } from '@guideai/orchestrator/digest';
import { writeRequirementsMd } from '@guideai/orchestrator/projectContext';
import { paths } from '@guideai/shared/paths';
import fs from 'node:fs';
import path from 'node:path';

function slugify(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || `ws-${randomUUID().slice(0, 6)}`;
}

// Zero-config workspace name derived from the user's task title.
// Caps the slug at 50 chars and suffixes with YYYY-MM-DD for uniqueness.
function slugFromTaskTitle(title: string): string {
  const truncated = title.slice(0, 50).trim();
  const slug = slugify(truncated);
  const date = new Date().toISOString().slice(0, 10);
  return `${slug}-${date}`;
}

// Standard subfolder layout for every workspace. Briefs, docs, reports, and
// slides each get their own home so the user can find artifacts by type.
// meta.json captures kind + originating task + targetFolder so we can tell
// auto-task workspaces apart from project workspaces, and resolve the cwd
// for the pipeline at dispatch time.
export interface WorkspaceMeta {
  id: string;
  createdAt: number;
  kind: 'project' | 'auto-task';
  originatingTask: string | null;
  /** Local filesystem path where the project's code lives. Used as the
   *  pipeline's cwd when set. */
  targetFolder: string | null;
}

function scaffoldWorkspaceDir(id: string, meta: {
  originatingTask?: string;
  kind?: 'project' | 'auto-task';
  targetFolder?: string;
}): void {
  const wsRoot = path.join(paths.workspaces, id);
  for (const sub of ['briefs', 'docs', 'reports', 'slides', 'code']) {
    fs.mkdirSync(path.join(wsRoot, sub), { recursive: true });
  }
  const data: WorkspaceMeta = {
    id,
    createdAt: Date.now(),
    kind: meta.kind ?? 'project',
    originatingTask: meta.originatingTask ?? null,
    targetFolder: meta.targetFolder?.trim() || null,
  };
  fs.writeFileSync(
    path.join(wsRoot, 'meta.json'),
    JSON.stringify(data, null, 2),
    'utf-8',
  );
}

export function readWorkspaceMeta(id: string): WorkspaceMeta | null {
  try {
    const p = path.join(paths.workspaces, id, 'meta.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as WorkspaceMeta;
  } catch { return null; }
}

function writeWorkspaceMeta(id: string, patch: Partial<WorkspaceMeta>): WorkspaceMeta {
  const wsRoot = path.join(paths.workspaces, id);
  fs.mkdirSync(wsRoot, { recursive: true });
  const existing = readWorkspaceMeta(id) ?? {
    id, createdAt: Date.now(), kind: 'project' as const,
    originatingTask: null, targetFolder: null,
  };
  const next = { ...existing, ...patch };
  fs.writeFileSync(path.join(wsRoot, 'meta.json'), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export function registerWorkspaceRoutes(app: FastifyInstance) {
  // List workspaces with rich summaries for the /projects view.
  // Archived workspaces are hidden by default; pass ?includeArchived=1 to
  // include them (e.g. for a future "show archived" UI).
  app.get<{ Querystring: { includeArchived?: string } }>(
    '/api/workspaces', async (req) => {
    const db = getDb();
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const workspaces = db.select().from(schema.workspaces).all()
      .filter((w) => includeArchived || w.autonomyMode !== 'archived')
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

  // Create a new workspace. Body: { name, targetFolder? }; id derived from slug.
  //
  // Conflict semantics:
  //   - id taken by an ACTIVE workspace → 409 (true collision).
  //   - id taken only by ARCHIVED workspaces → auto-suffix (`-2`, `-3`, …) so
  //     the user can reuse the name without losing the archived data on disk.
  //
  // `targetFolder` is the local filesystem path where the project's code
  // lives — agents write here, opening this folder in VS Code later
  // reconnects the project. Stored in meta.json; editable via PATCH.
  app.post<{ Body: { name: string; targetFolder?: string } }>('/api/workspaces', async (req, reply) => {
    const name = (req.body?.name ?? '').toString().trim();
    if (!name) { reply.code(400); return { error: 'name is required' }; }
    const base = slugify(name);
    const targetFolder = req.body?.targetFolder?.toString().trim() || undefined;

    const db = getDb();
    const rowFor = (slug: string) =>
      db.select().from(schema.workspaces).where(eq(schema.workspaces.id, slug)).all()[0];

    // Hard-collision: an ACTIVE workspace owns this slug.
    const taken = rowFor(base);
    if (taken && taken.autonomyMode !== 'archived') {
      reply.code(409); return { error: `workspace "${base}" already exists` };
    }

    // Walk a suffix counter until we find an unused (or only-archived-elsewhere) slug.
    let id = base;
    let n = 2;
    while (rowFor(id)) {
      id = `${base}-${n++}`;
      if (n > 100) { reply.code(409); return { error: `too many archived workspaces named "${base}"` }; }
    }

    db.insert(schema.workspaces).values({
      id, name,
      autonomyMode: 'approval-gated',
      createdAt: Date.now(),
    }).run();

    scaffoldWorkspaceDir(id, { kind: 'project', targetFolder });
    // Scaffold the project-level requirements.md (intake is still empty;
    // the file gets refreshed when intake is saved).
    try { writeRequirementsMd(id); } catch {}

    return { id, name, targetFolder: targetFolder ?? null };
  });

  // PATCH a workspace — for editing the targetFolder post-hoc.
  app.patch<{ Params: { id: string }; Body: { targetFolder?: string } }>(
    '/api/workspaces/:id', async (req, reply) => {
      const db = getDb();
      const row = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, req.params.id)).all()[0];
      if (!row) { reply.code(404); return { error: 'not found' }; }
      const patch: Partial<WorkspaceMeta> = {};
      if (req.body?.targetFolder !== undefined) {
        patch.targetFolder = req.body.targetFolder.toString().trim() || null;
      }
      const updated = writeWorkspaceMeta(req.params.id, patch);
      // Folder change → refresh requirements.md so the new path is in context.
      try { writeRequirementsMd(req.params.id); } catch {}
      return { id: req.params.id, targetFolder: updated.targetFolder };
    },
  );

  // Read a workspace's meta (project folder, kind, originating task).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/meta', async (req, reply) => {
    const meta = readWorkspaceMeta(req.params.id);
    if (!meta) { reply.code(404); return { error: 'workspace meta not found' }; }
    return meta;
  });

  // Zero-config workspace creation from a task title.
  //
  // POST /api/workspaces/auto  Body: { taskTitle, kind? }
  //   - Slugifies the task title + dates it for uniqueness
  //   - Creates the workspace silently (no name conflict UX needed)
  //   - Scaffolds the standard subfolder layout
  //   - Returns { id, name } for the caller to use immediately
  //
  // Designed for the VS Code right-click → Auto-fix flow where the user
  // hasn't picked a workspace; we make one for them named from the task.
  app.post<{ Body: { taskTitle: string; kind?: 'project' | 'auto-task' } }>(
    '/api/workspaces/auto', async (req, reply) => {
      const taskTitle = (req.body?.taskTitle ?? '').toString().trim();
      if (!taskTitle) { reply.code(400); return { error: 'taskTitle is required' }; }
      const kind = req.body?.kind ?? 'auto-task';

      const base = slugFromTaskTitle(taskTitle);
      const db = getDb();
      const rowFor = (slug: string) =>
        db.select().from(schema.workspaces).where(eq(schema.workspaces.id, slug)).all()[0];

      // Walk a suffix counter if the same task is dispatched multiple times today.
      let id = base;
      let n = 2;
      while (rowFor(id)) {
        id = `${base}-${n++}`;
        if (n > 100) { reply.code(409); return { error: 'too many workspaces for this task today' }; }
      }

      // Human-readable name = first 60 chars of the task title.
      const name = taskTitle.length > 60 ? taskTitle.slice(0, 57) + '…' : taskTitle;

      db.insert(schema.workspaces).values({
        id, name,
        autonomyMode: 'approval-gated',
        createdAt: Date.now(),
      }).run();

      scaffoldWorkspaceDir(id, { kind, originatingTask: taskTitle });
      try { writeRequirementsMd(id); } catch {}

      return { id, name };
    },
  );

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
