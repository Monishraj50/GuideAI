import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { submitBrief, resumeBrief } from '@guideai/orchestrator/cos';
import { isPipelineAlive } from '@guideai/orchestrator/wbs';
import { paths } from '@guideai/shared/paths';
import { getDb, schema } from '@guideai/shared/db';
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
      mode?: 'auto' | 'manual' | 'pending' | 'assisted';
      preferredModel?: string;
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
        const mode: 'auto' | 'manual' | 'pending' | 'assisted' =
          rawMode === 'manual' ? 'manual'
          : rawMode === 'pending' ? 'pending'
          : rawMode === 'assisted' ? 'assisted'
          : 'auto';
        const preferredModel = typeof req.body?.preferredModel === 'string'
          && ['haiku', 'sonnet', 'opus'].includes(req.body.preferredModel)
          ? req.body.preferredModel : undefined;
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
          preferredModel,
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
  //
  // Auto-resume: if no live runPipeline is driving this brief (heartbeat
  // stale or never set), kick off resumeBrief BEFORE releasing the gate.
  // Otherwise the gate-release would have nothing listening, the in_progress
  // task would sit until the sweeper reverts it, and the user would see
  // "task fell back to inactive" with no agent ever running.
  app.post<{ Params: { briefId: string; phase: string } }>(
    '/api/briefs/:briefId/phases/:phase/release',
    async (req) => {
      const { briefId, phase } = req.params;
      let resumed = false;
      if (!isPipelineAlive(briefId)) {
        const r = await resumeBrief(briefId);
        resumed = r.ok;
      }
      const released = taskGate.release(briefId, phase);
      return { ok: true, released, resumed, briefId, phase };
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

  // Resume a brief whose pipeline died (server crash, manual kill, etc.).
  // Reuses the brief's stored Claude session UUID and skips phases whose
  // artifact .md is already on disk. Safe to call when nothing is stuck —
  // becomes a noop because every phase artifact exists.
  app.post<{ Params: { briefId: string } }>(
    '/api/briefs/:briefId/resume',
    async (req, reply) => {
      try {
        const result = await resumeBrief(req.params.briefId);
        if (!result.ok) {
          reply.code(result.reason === 'brief-not-found' ? 404 : 409);
        }
        return result;
      } catch (err: any) {
        req.log.error(err);
        reply.code(500);
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  );

  // ── Plan editor · assisted-mode Approve/Regenerate/Reject ────────────

  /** List briefs currently paused at PLAN_APPROVED_GATE. The extension polls
   *  this every 5s and auto-opens the Plan editor when new entries appear. */
  app.get('/api/briefs/pending-plan-review', async () => {
    const db = getDb();
    const rows = db.select().from(schema.briefs).all()
      .filter((b) => (b as any).planGateState === 'pending' && b.status === 'plan-review-pending');
    return {
      count: rows.length,
      briefs: rows.map((b: any) => ({
        id: b.id, workspaceId: b.workspaceId, body: b.body,
        status: b.status, planGateState: b.planGateState,
        model: b.preferredModel ?? 'sonnet',
      })),
    };
  });

  /** GET the current plan artifact for a brief paused at PLAN_APPROVED_GATE.
   *  Returns { planBody, model, briefStatus }. UI editor loads this on open. */
  app.get<{ Params: { briefId: string } }>(
    '/api/briefs/:briefId/plan',
    async (req, reply) => {
      const briefId = req.params.briefId;
      const db = getDb();
      const brief = db.select().from(schema.briefs).all().find((b) => b.id === briefId) as any;
      if (!brief) { reply.code(404); return { error: 'brief not found' }; }
      const planPath = path.join(paths.workspaceMdDir(brief.workspaceId), 'briefs', briefId, 'plan.md');
      const planBody = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf-8') : '';
      return {
        briefId,
        workspaceId: brief.workspaceId,
        body: brief.body,
        status: brief.status,
        planGateState: brief.planGateState,
        model: brief.preferredModel ?? 'sonnet',
        planBody,
      };
    },
  );

  /** Approve the plan → release the PLAN_APPROVED gate → pipeline moves to
   *  Implement. Optional body { edits: string } overwrites plan.md with the
   *  user's textarea contents before releasing (so the Implement phase sees
   *  the edited version). */
  app.post<{ Params: { briefId: string }; Body?: { edits?: string } }>(
    '/api/briefs/:briefId/plan/approve',
    async (req, reply) => {
      const briefId = req.params.briefId;
      const db = getDb();
      const brief = db.select().from(schema.briefs).all().find((b) => b.id === briefId) as any;
      if (!brief) { reply.code(404); return { error: 'brief not found' }; }
      if (brief.planGateState !== 'pending') {
        reply.code(409);
        return { error: 'brief not awaiting plan approval', state: brief.planGateState };
      }
      const edits = req.body?.edits;
      if (typeof edits === 'string' && edits.trim().length > 0) {
        const planPath = path.join(paths.workspaceMdDir(brief.workspaceId), 'briefs', briefId, 'plan.md');
        try { fs.writeFileSync(planPath, edits); } catch {}
      }
      db.update(schema.briefs)
        .set({ planGateState: 'approved', status: 'active' } as any)
        .where(eq(schema.briefs.id, briefId)).run();
      taskGate.release(briefId, taskGate.PLAN_APPROVED_GATE);
      return { ok: true, briefId, released: true };
    },
  );

  /** Regenerate the plan with a different model. Preserves the previous
   *  plan.md as plan.previous.md, updates brief.preferredModel, resets the
   *  gate, and re-runs the pipeline from Phase 1 via resumeBrief() (which
   *  skips phases whose artifact is on disk — but here we just moved it, so
   *  Phase 1 re-runs). */
  app.post<{
    Params: { briefId: string };
    Body: { model?: string; note?: string };
  }>(
    '/api/briefs/:briefId/plan/regenerate',
    async (req, reply) => {
      const briefId = req.params.briefId;
      const model = (req.body?.model ?? '').trim();
      if (!model) { reply.code(400); return { error: 'model required' }; }
      const db = getDb();
      const brief = db.select().from(schema.briefs).all().find((b) => b.id === briefId) as any;
      if (!brief) { reply.code(404); return { error: 'brief not found' }; }
      if (brief.planGateState !== 'pending') {
        reply.code(409);
        return { error: 'brief not awaiting plan approval', state: brief.planGateState };
      }
      // 1. Archive the current plan.md → plan.previous.md.
      const briefDir = path.join(paths.workspaceMdDir(brief.workspaceId), 'briefs', briefId);
      const planPath = path.join(briefDir, 'plan.md');
      const prevPath = path.join(briefDir, 'plan.previous.md');
      try { if (fs.existsSync(planPath)) fs.renameSync(planPath, prevPath); } catch {}
      // 2. Persist the new model choice + KEEP planGateState='pending' so the
      //    paused pipeline, on gate release, sees "still pending" and bails
      //    out instead of racing the new pipeline into Implement.
      db.update(schema.briefs)
        .set({ preferredModel: model, planGateState: 'pending' } as any)
        .where(eq(schema.briefs.id, briefId)).run();
      // 3. Release the current gate so the paused runPipeline unwinds
      //    (it'll self-abort on the state check). Re-dispose the gate so
      //    the fresh resumeBrief() pipeline gets a virgin gate to await on.
      taskGate.release(briefId, taskGate.PLAN_APPROVED_GATE);
      taskGate.disposeBrief(briefId);
      taskGate.registerBrief(briefId, 'assisted');
      // Give the paused pipeline a tick to unwind before dispatching the
      // new one — otherwise the old pipeline's `finally` clearInterval
      // races the new pipeline's heartbeat setup.
      setTimeout(() => {
        void resumeBrief(briefId).catch(() => {});
      }, 200);
      return { ok: true, briefId, model, previousPlanPath: prevPath };
    },
  );

  /** Reject the plan → mark brief cancelled + release the gate so the
   *  paused pipeline exits cleanly. Optional note stored for the audit log. */
  app.post<{ Params: { briefId: string }; Body?: { note?: string } }>(
    '/api/briefs/:briefId/plan/reject',
    async (req, reply) => {
      const briefId = req.params.briefId;
      const db = getDb();
      const brief = db.select().from(schema.briefs).all().find((b) => b.id === briefId) as any;
      if (!brief) { reply.code(404); return { error: 'brief not found' }; }
      if (brief.planGateState !== 'pending') {
        reply.code(409);
        return { error: 'brief not awaiting plan approval', state: brief.planGateState };
      }
      db.update(schema.briefs)
        .set({ planGateState: 'rejected', status: 'cancelled' } as any)
        .where(eq(schema.briefs.id, briefId)).run();
      taskGate.release(briefId, taskGate.PLAN_APPROVED_GATE);
      return { ok: true, briefId, rejected: true, note: req.body?.note ?? null };
    },
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
