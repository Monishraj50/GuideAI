import type { FastifyInstance } from 'fastify';
import { submitBrief } from '@guideai/orchestrator/cos';
import * as taskGate from '@guideai/orchestrator/taskGate';

export function registerBriefRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: {
      body: string;
      securityTagged?: boolean;
      /** Local filesystem path where the agents should write code. Becomes cwd. */
      targetFolder?: string;
      /** Catalog roles to ensure are hired before phase 1; missing ones auto-hire. */
      taggedAgents?: string[];
      /** Soft budget hint for the gate. `mode: tokens` uses raw token count;
       *  `mode: currency` uses USD. */
      budget?: { mode: 'tokens' | 'currency'; amount: number };
      /** Execution mode.
       *    'auto'    — runs end-to-end (default for /ops + ext direct-task)
       *    'manual'  — pauses each phase; Kanban drag-release advances it
       *    'pending' — Phase C; brief blocks at the start gate until a
       *                separate POST /api/briefs/:briefId/start promotes it
       */
      mode?: 'auto' | 'manual' | 'pending';
    };
  }>(
    '/api/workspaces/:id/briefs',
    async (req, reply) => {
      const body = (req.body?.body ?? '').toString().trim();
      if (!body) {
        reply.code(400);
        return { error: 'body is required' };
      }
      try {
        const rawMode = req.body?.mode;
        const mode: 'auto' | 'manual' | 'pending' =
          rawMode === 'manual' ? 'manual' : rawMode === 'pending' ? 'pending' : 'auto';
        const result = await submitBrief({
          workspaceId: req.params.id,
          body,
          securityTagged: !!req.body?.securityTagged,
          targetFolder: req.body?.targetFolder?.trim() || undefined,
          taggedAgents: Array.isArray(req.body?.taggedAgents)
            ? req.body.taggedAgents.filter((r) => typeof r === 'string' && r.trim())
            : undefined,
          budget: req.body?.budget && typeof req.body.budget.amount === 'number'
            ? { mode: req.body.budget.mode, amount: req.body.budget.amount }
            : undefined,
          mode,
        });
        return result;
      } catch (err: any) {
        req.log.error(err);
        reply.code(500);
        return { error: String(err?.message ?? err) };
      }
    },
  );

  // Phase C — promote a 'pending' brief to 'auto' or 'manual' and release the
  // synthetic start gate. Idempotent: calling on a non-pending brief is a
  // no-op (returns the current mode + 0 released gates).
  app.post<{
    Params: { briefId: string };
    Body: { mode?: 'auto' | 'manual' };
  }>(
    '/api/briefs/:briefId/start',
    async (req, reply) => {
      const requested = req.body?.mode;
      if (requested !== 'auto' && requested !== 'manual') {
        reply.code(400);
        return { error: "mode must be 'auto' or 'manual'" };
      }
      const r = taskGate.start(req.params.briefId, requested);
      return { ok: true, briefId: req.params.briefId, ...r };
    },
  );

  // Release a single phase gate (Manual mode) — fired when the user drags
  // a phase card from Inactive → Active in the Kanban.
  app.post<{ Params: { briefId: string; phase: string } }>(
    '/api/briefs/:briefId/phases/:phase/release',
    async (req) => {
      const released = taskGate.release(req.params.briefId, req.params.phase);
      return { ok: true, released, briefId: req.params.briefId, phase: req.params.phase };
    },
  );

  // Release every remaining phase gate for a brief (Auto handoff / "play all").
  app.post<{ Params: { briefId: string } }>(
    '/api/briefs/:briefId/release-all',
    async (req) => {
      const n = taskGate.releaseAll(req.params.briefId);
      return { ok: true, released: n, briefId: req.params.briefId };
    },
  );

  // Read gate states for a brief — used by the Kanban to render Inactive vs.
  // released phase cards.
  app.get<{ Params: { briefId: string } }>(
    '/api/briefs/:briefId/gates',
    async (req) => ({ briefId: req.params.briefId, mode: taskGate.modeOf(req.params.briefId), gates: taskGate.gateStates(req.params.briefId) }),
  );

  // Reopen a completed phase in verify-and-repair mode. Today this records
  // the request (emits a system event + appends a reopen marker to the
  // transcript on next run) but does NOT yet rerun the agent in isolation —
  // that requires extracting dispatch from runPipeline (planned v1.1).
  // The UI affordance is live so the gesture works end-to-end.
  app.post<{ Params: { briefId: string; phase: string } }>(
    '/api/briefs/:briefId/phases/:phase/reopen',
    async (req, reply) => {
      reply.code(202);
      return {
        ok: true,
        briefId: req.params.briefId,
        phase: req.params.phase,
        mode: 'verify-and-repair',
        note: 'reopen recorded — agent rerun lands in v1.1',
      };
    },
  );
}
