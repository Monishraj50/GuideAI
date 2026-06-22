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

  // ─── Sessions: per-task chat history ────────────────────────────────────
  //
  // A "session" is one task's slice of the workspace event log — every chunk
  // emitted by the task's agent between startedAt and endedAt. Used by the
  // VS Code session viewer ("click an agent → click a task → see the chat").
  app.get<{ Params: { id: string; taskId: string } }>(
    '/api/workspaces/:id/tasks/:taskId/session',
    async (req, reply) => {
      const db = getDb();
      const task = db.select().from(schema.tasks).all().find((t) => t.id === req.params.taskId);
      if (!task) { reply.code(404); return { error: 'task not found' }; }
      const brief = db.select().from(schema.briefs).where(eq(schema.briefs.id, task.briefId)).all()[0];
      const agent = task.agentId
        ? db.select().from(schema.agents).all().find((a) => a.id === task.agentId)
        : null;

      const startTs = task.startedAt ?? 0;
      const endTs = task.endedAt ?? Date.now();
      const { chunks } = await readEvents(req.params.id, { sinceTs: Math.max(0, startTs - 1000) });
      // Keep chunks attributed to this task's agent OR phase chunks tagged
      // with this task's id (the orchestrator stamps them).
      const sessionChunks = chunks.filter((c) => {
        if (c.ts > endTs + 2000) return false;
        if (c.kind === 'phase' && c.taskId === req.params.taskId) return true;
        if (task.agentId && c.agentId === task.agentId) return true;
        return false;
      });

      let artifact: { phase: string; path: string; body: string } | null = null;
      if (task.artifactPath && fs.existsSync(task.artifactPath)) {
        artifact = {
          phase: task.phase,
          path: task.artifactPath,
          body: fs.readFileSync(task.artifactPath, 'utf8'),
        };
      }

      return {
        task,
        brief: brief
          ? { id: brief.id, body: brief.body, status: brief.status }
          : null,
        agent: agent
          ? { id: agent.id, role: agent.role, displayName: agent.displayName, status: agent.status }
          : null,
        chunks: sessionChunks,
        artifact,
        window: { startTs, endTs },
      };
    },
  );

  // ─── All sessions in a workspace (agent-tagged) ─────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/sessions',
    async (req) => {
      const db = getDb();
      const briefs = db.select().from(schema.briefs).all()
        .filter((b) => b.workspaceId === req.params.id);
      const briefById = new Map(briefs.map((b) => [b.id, b]));
      const tasks = db.select().from(schema.tasks).all()
        .filter((t) => briefById.has(t.briefId));
      const agents = db.select().from(schema.agents).all()
        .filter((a) => a.workspaceId === req.params.id);
      const agentById = new Map(agents.map((a) => [a.id, a]));

      const sessions = tasks
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .map((t) => {
          const brief = briefById.get(t.briefId);
          const agent = t.agentId ? agentById.get(t.agentId) : null;
          return {
            taskId: t.id,
            briefId: t.briefId,
            briefTitle: brief?.body.split('\n')[0]?.slice(0, 80) ?? t.briefId,
            agentId: t.agentId,
            agentRole: agent?.role ?? null,
            agentDisplayName: agent?.displayName ?? null,
            phase: t.phase,
            status: t.status,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            tokensIn: t.tokensIn,
            tokensOut: t.tokensOut,
          };
        });

      return { count: sessions.length, sessions };
    },
  );
}
