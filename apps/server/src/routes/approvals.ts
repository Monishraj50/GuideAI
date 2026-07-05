import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { decideApproval, listPending } from '@guideai/orchestrator/approvals';
import { getDb, schema } from '@guideai/shared/db';
import { addSessionAllow } from '@guideai/policies/engine';
import { notifyApprovalDecided } from './permissions.js';

export function registerApprovalRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/approvals/pending',
    async (req) => {
      return { pending: listPending(req.params.id) };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { decision: 'approved' | 'denied'; alwaysAllowSession?: boolean };
  }>(
    '/api/approvals/:id',
    async (req, reply) => {
      const decision = req.body?.decision;
      if (decision !== 'approved' && decision !== 'denied') {
        reply.code(400);
        return { error: 'decision must be "approved" or "denied"' };
      }
      try {
        const workspaceId = (req.query as { workspace?: string })?.workspace;
        if (!workspaceId) {
          reply.code(400);
          return { error: 'missing ?workspace=... query' };
        }
        // "Always allow (this session)": stamp the (tool, args) into the
        // session allowlist BEFORE writing the decision, so a rapid retry of
        // the same tool hits the allowlist rather than blocking again.
        if (decision === 'approved' && req.body?.alwaysAllowSession) {
          const db = getDb();
          const row = db.select().from(schema.approvals)
            .where(eq(schema.approvals.id, req.params.id)).all()[0];
          if (row) {
            let args: unknown = {};
            try { args = JSON.parse(row.argsJson); } catch {}
            addSessionAllow(workspaceId, row.tool, args);
          }
        }
        const result = decideApproval({
          workspaceId,
          approvalId: req.params.id,
          decision,
        });
        // Unblock any hook that's long-polling for this approval.
        notifyApprovalDecided(req.params.id, decision);
        return result;
      } catch (err: any) {
        req.log.error(err);
        reply.code(409);
        return { error: String(err?.message ?? err) };
      }
    },
  );

  // Diff preview for a pending Edit/Write approval. Returns:
  //   - Write : { kind: 'write', filePath, before, after }
  //   - Edit  : { kind: 'edit',  filePath, before, after, oldString, newString }
  //   - other : { kind: 'none' }
  // `before` is read live from disk at request time so the diff reflects the
  // real state the tool would touch. Missing files render as empty string.
  app.get<{ Params: { id: string } }>(
    '/api/approvals/:id/preview',
    async (req, reply) => {
      const db = getDb();
      const row = db.select().from(schema.approvals)
        .where(eq(schema.approvals.id, req.params.id)).all()[0];
      if (!row) { reply.code(404); return { error: 'not found' }; }
      let args: any = {};
      try { args = JSON.parse(row.argsJson); } catch {}
      const filePath: string | undefined = typeof args?.file_path === 'string'
        ? args.file_path : undefined;
      if (!filePath) return { kind: 'none', tool: row.tool };

      const before = fs.existsSync(filePath)
        ? (() => { try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; } })()
        : '';

      if (row.tool === 'Write' && typeof args?.content === 'string') {
        return { kind: 'write', filePath, before, after: args.content };
      }
      if (row.tool === 'Edit'
          && typeof args?.old_string === 'string'
          && typeof args?.new_string === 'string') {
        const replaceAll = !!args.replace_all;
        const after = replaceAll
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string);
        return {
          kind: 'edit', filePath, before, after,
          oldString: args.old_string, newString: args.new_string,
          replaceAll,
        };
      }
      return { kind: 'none', tool: row.tool };
    },
  );
}
