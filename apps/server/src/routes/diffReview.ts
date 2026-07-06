// S9 · Diff review API — per-work_item hunk extraction + selection apply.
//
// GET  /api/work-items/:id/diff        → { files: HunkFile[] } vs baseGitRef
// POST /api/work-items/:id/diff/apply  → accepts { acceptedHunkIds }, reverts
//                                          the rest, records outcome, and if
//                                          any hunks were rejected spawns a
//                                          follow-up review-phase work_item.

import type { FastifyInstance } from 'fastify';
import { extractHunks, applyHunkSelection, type Hunk } from '@guideai/orchestrator/diffReview';
import { getWorkItem, createWorkItem } from '@guideai/orchestrator/wbs';
import { getDb, schema } from '@guideai/shared/db';
import { runHook } from '@guideai/policies/hooks';

// In-memory cache so /diff/apply doesn't have to re-parse (`git diff` output
// changes as we revert). Keyed by `${workItemId}:${baseGitRef}` — small,
// bounded by the number of in-flight reviews per workspace.
const HUNK_CACHE = new Map<string, Hunk[]>();

function workspaceCwd(workspaceId: string): string | null {
  const row = getDb().select().from(schema.workspaces).all()
    .find((w) => w.id === workspaceId) as any;
  const cwd = (row?.targetFolder as string | undefined)?.trim();
  return cwd || null;
}

export function registerDiffReviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/work-items/:id/diff',
    async (req, reply) => {
      const item = getWorkItem(req.params.id);
      if (!item) { reply.code(404); return { error: 'not found' }; }
      if (!item.baseGitRef) return { files: [], reason: 'no baseGitRef (task never went in_progress in a git repo)' };
      const cwd = workspaceCwd(item.workspaceId);
      if (!cwd) return { files: [], reason: 'workspace has no targetFolder' };
      try {
        const files = extractHunks({ cwd, base: item.baseGitRef });
        // Cache the flat hunk list for the follow-up POST /apply.
        const flat = files.flatMap((f) => f.hunks);
        HUNK_CACHE.set(`${item.id}:${item.baseGitRef}`, flat);
        return { files, hunkCount: flat.length };
      } catch (err: any) {
        reply.code(500);
        return { error: `git diff failed: ${String(err?.message ?? err)}` };
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { acceptedHunkIds: string[]; note?: string };
  }>(
    '/api/work-items/:id/diff/apply',
    async (req, reply) => {
      const item = getWorkItem(req.params.id);
      if (!item) { reply.code(404); return { error: 'not found' }; }
      if (!item.baseGitRef) { reply.code(409); return { error: 'no baseGitRef' }; }
      const cwd = workspaceCwd(item.workspaceId);
      if (!cwd) { reply.code(409); return { error: 'workspace has no targetFolder' }; }
      const accepted = Array.isArray(req.body?.acceptedHunkIds) ? req.body.acceptedHunkIds : [];
      const cached = HUNK_CACHE.get(`${item.id}:${item.baseGitRef}`);
      if (!cached) {
        reply.code(409);
        return { error: 'no cached hunks — call GET /diff first' };
      }
      // S11 · pre-diff hook chain. Scans the *accepted* hunks (rejected ones
      // never touch disk, no need to gate them). A hook that returns block=true
      // short-circuits the apply — used by the built-in secret-scan.
      const acceptedHunks = cached.filter((h) => accepted.includes(h.id));
      const hookRes = runHook('pre-diff', {
        workspaceId: item.workspaceId, workItemId: item.id,
        hunks: acceptedHunks.map((h) => ({ file: h.file, body: h.body })),
      });
      if (hookRes.block) {
        reply.code(409);
        return { error: 'pre-diff-hook-blocked', reason: hookRes.blockReason ?? 'blocked by policy' };
      }
      const result = applyHunkSelection({ cwd, hunks: cached, acceptedIds: accepted });

      // Any hunks we rejected → spawn a follow-up work_item so the work isn't
      // silently dropped. Follow-up lives in review phase (it's a diff-review
      // outcome), same brief, description names the rejected files.
      const rejectedHunks = cached.filter((h) => !accepted.includes(h.id));
      let followupId: string | null = null;
      if (rejectedHunks.length > 0) {
        const rejectedFiles = [...new Set(rejectedHunks.map((h) => h.file))];
        const followup = createWorkItem({
          workspaceId: item.workspaceId,
          briefId: item.briefId,
          title: `Follow-up: address rejected hunks in ${rejectedFiles.slice(0, 3).join(', ')}${rejectedFiles.length > 3 ? '…' : ''}`,
          description: [
            `${rejectedHunks.length} hunk(s) across ${rejectedFiles.length} file(s) were rejected during diff review.`,
            `Original task: ${item.title} (${item.id})`,
            req.body?.note ? `Reviewer note: ${req.body.note}` : '',
          ].filter(Boolean).join('\n\n'),
          phase: 'review',
          assignedRole: item.assignedRole,
          priority: 'high',
          source: 'auto',
          dependencies: [],
          skillHint: 'fix-bug',
          acceptance: 'The rejected changes are re-implemented in a way the reviewer signs off on.',
        });
        followupId = followup.id;
      }

      // Cache is now stale (working tree changed) — clear it so a fresh
      // /diff reflects the applied selection.
      HUNK_CACHE.delete(`${item.id}:${item.baseGitRef}`);

      return {
        ok: true,
        applied: result.applied,
        reverted: result.reverted,
        failed: result.failed,
        outcome: rejectedHunks.length === 0 ? 'shipped' : (accepted.length === 0 ? 'abandoned' : 'partial'),
        followupWorkItemId: followupId,
      };
    },
  );
}
