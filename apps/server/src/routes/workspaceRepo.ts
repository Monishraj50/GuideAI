import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paths } from '@guideai/shared/paths';
import {
  getWorkspaceRepo, linkRepo, unlinkRepo, createRepo,
  pushDeliverables, syncWorkItemsToIssues,
} from '@guideai/orchestrator/github';

const SESSION_FILE = path.join(paths.home, 'session.json');

function currentUsername(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return typeof j?.username === 'string' ? j.username : null;
  } catch { return null; }
}

function requireUser(reply: any): string | null {
  const u = currentUsername();
  if (!u) { reply.code(401); return null; }
  return u;
}

export function registerWorkspaceRepoRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/repo', async (req) => {
    return { repo: getWorkspaceRepo(req.params.id) };
  });

  // Link an existing repo: body {owner, repo, visibility?, defaultBranch?}.
  app.post<{
    Params: { id: string };
    Body: { owner: string; repo: string; visibility?: 'public' | 'private'; defaultBranch?: string; htmlUrl?: string };
  }>('/api/workspaces/:id/repo/link', async (req, reply) => {
    try {
      const body = req.body ?? ({} as any);
      if (!body.owner?.trim() || !body.repo?.trim()) {
        reply.code(400); return { error: 'owner and repo are required' };
      }
      const repo = linkRepo({
        workspaceId: req.params.id,
        owner: body.owner, repo: body.repo,
        visibility: body.visibility ?? 'private',
        defaultBranch: body.defaultBranch ?? 'main',
        htmlUrl: body.htmlUrl,
      });
      return { repo };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/workspaces/:id/repo', async (req) => {
    unlinkRepo(req.params.id);
    return { ok: true };
  });

  // Create a new repo under the authed user and link it.
  app.post<{
    Params: { id: string };
    Body: { name: string; description?: string; private?: boolean };
  }>('/api/workspaces/:id/repo/create', async (req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    try {
      const body = req.body ?? ({} as any);
      if (!body.name?.trim()) { reply.code(400); return { error: 'name is required' }; }
      const repo = await createRepo({
        workspaceId: req.params.id,
        name: body.name,
        description: body.description,
        private: body.private,
        username,
      });
      return { repo };
    } catch (err: any) {
      req.log.error(err);
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.post<{ Params: { id: string }; Body?: { briefId?: string } }>(
    '/api/workspaces/:id/repo/push',
    async (req, reply) => {
      const username = requireUser(reply);
      if (!username) return { error: 'sign-in required' };
      try {
        const result = await pushDeliverables({
          workspaceId: req.params.id, briefId: req.body?.briefId, username,
        });
        return result;
      } catch (err: any) {
        req.log.error(err);
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    },
  );

  app.post<{ Params: { id: string }; Body?: { briefId?: string } }>(
    '/api/workspaces/:id/repo/sync-issues',
    async (req, reply) => {
      const username = requireUser(reply);
      if (!username) return { error: 'sign-in required' };
      try {
        const result = await syncWorkItemsToIssues({
          workspaceId: req.params.id, briefId: req.body?.briefId, username,
        });
        return result;
      } catch (err: any) {
        req.log.error(err);
        reply.code(400); return { error: String(err?.message ?? err) };
      }
    },
  );
}
