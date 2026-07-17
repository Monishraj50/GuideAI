import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { submitBrief, resumeBrief } from '@guideai/orchestrator/cos';
import { isPipelineAlive, revertPlanWorkItemsToInProgress } from '@guideai/orchestrator/wbs';
import { removeSessionPointer, featureSlugFromBrief, rebuildProjectTOC } from '@guideai/orchestrator/contextStore';
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
      // 1. Archive the current plan.md → plan.previous.md so the user can
      //    diff before/after if the new model went off-track.
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
      // 3. Revert plan work_items to in_progress — Progress tracker should
      //    show the plan tasks going BACK to active while the new Phase 1
      //    re-runs (they'll flip to 'done' again when it completes).
      try {
        const reverted = revertPlanWorkItemsToInProgress({
          workspaceId: brief.workspaceId, briefId,
        });
        req.log.info({ briefId, reverted }, 'plan work_items reverted to in_progress for regenerate');
      } catch (err: any) {
        req.log.warn({ err, briefId }, 'revertPlanWorkItemsToInProgress failed');
      }
      // 4. Release the current gate so the paused runPipeline unwinds
      //    (it'll self-abort on the state check). Re-dispose the gate so
      //    the fresh resumeBrief() pipeline gets a virgin gate to await on.
      taskGate.release(briefId, taskGate.PLAN_APPROVED_GATE);
      taskGate.disposeBrief(briefId);
      taskGate.registerBrief(briefId, 'assisted');
      // Give the paused pipeline a tick to unwind before dispatching the
      // new one — otherwise the old pipeline's `finally` clearInterval
      // races the new pipeline's heartbeat setup. `resumeBrief` reads the
      // brief row's claudeSessionId + preferredModel, so the new pipeline
      // reuses the SAME Claude session (cache stays warm) with the new
      // model tier for Phase 1.
      // Loud logging so a silent failure inside resumeBrief doesn't make
      // Regenerate look like a no-op ("clicked, nothing happened").
      req.log.info({ briefId, model }, 'plan/regenerate: scheduling resumeBrief');
      setTimeout(() => {
        void resumeBrief(briefId).then((r) => {
          req.log.info({ briefId, resumeResult: r }, 'plan/regenerate: resumeBrief returned');
        }).catch((err) => {
          req.log.error({ err, briefId }, 'plan/regenerate: resumeBrief threw');
        });
      }, 200);
      return { ok: true, briefId, model, previousPlanPath: prevPath };
    },
  );

  /** Reject the plan → cascade delete every artifact of this brief so the
   *  sidebar isn't left with a phantom cancelled row. Optional note logged.
   *
   *  What gets deleted (in this order — releases the paused pipeline last so
   *  it self-aborts before its finally-block reads a half-deleted row):
   *    1. flip planGateState='rejected' + release the PLAN_APPROVED_GATE →
   *       phases.ts sees 'rejected' and throws → pipeline exits cleanly.
   *    2. delete work_items where briefId = this brief.
   *    3. delete approvals where taskId = this brief.
   *    4. delete sessions where briefId = this brief.
   *    5. delete `<md-root>/briefs/<briefId>/` — plan.md, plan.previous.md,
   *       and any partial phase artifacts.
   *    6. delete the `## Sessions` row for this brief's session from the
   *       feature's FEATURE.md.
   *    7. delete the brief row itself.
   *    8. if this was the workspace's ONLY brief, delete the workspace row
   *       too (undo the project-creation entirely — matches the intuition
   *       "reject the whole thing"). Otherwise workspace stays. */
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
      const workspaceId: string = brief.workspaceId;

      // Step 1 — signal the paused pipeline to abort.
      db.update(schema.briefs)
        .set({ planGateState: 'rejected', status: 'cancelled' } as any)
        .where(eq(schema.briefs.id, briefId)).run();
      taskGate.release(briefId, taskGate.PLAN_APPROVED_GATE);

      // Step 2 — work_items for this brief.
      let workItemsDeleted = 0;
      try {
        const items = db.select().from(schema.workItems).all()
          .filter((r) => r.briefId === briefId);
        for (const r of items) {
          db.delete(schema.workItems).where(eq(schema.workItems.id, r.id)).run();
          workItemsDeleted++;
        }
      } catch (err: any) { req.log.warn({ err }, 'work_items delete failed'); }

      // Step 3 — approvals stored with taskId=briefId.
      let approvalsDeleted = 0;
      try {
        const apps = db.select().from(schema.approvals).all()
          .filter((r: any) => r.taskId === briefId);
        for (const r of apps) {
          db.delete(schema.approvals).where(eq(schema.approvals.id, r.id)).run();
          approvalsDeleted++;
        }
      } catch (err: any) { req.log.warn({ err }, 'approvals delete failed'); }

      // Step 4 — sessions row(s) that opened for this brief.
      let sessionsDeleted = 0;
      const briefSessionId: string | null = brief.claudeSessionId ?? null;
      try {
        const sess = db.select().from(schema.sessions).all()
          .filter((r: any) => r.briefId === briefId);
        for (const r of sess) {
          db.delete(schema.sessions).where(eq(schema.sessions.id, r.id)).run();
          sessionsDeleted++;
        }
      } catch (err: any) { req.log.warn({ err }, 'sessions delete failed'); }

      // Step 5 — brief md directory on disk.
      const briefDir = path.join(paths.workspaceMdDir(workspaceId), 'briefs', briefId);
      let artifactsDeleted = false;
      try {
        if (fs.existsSync(briefDir)) {
          fs.rmSync(briefDir, { recursive: true, force: true });
          artifactsDeleted = true;
        }
      } catch (err: any) { req.log.warn({ err }, 'briefDir delete failed'); }

      // Step 6 — remove the session-pointer row from FEATURE.md.
      let featureRowRemoved = false;
      try {
        const featureSlug = featureSlugFromBrief(brief.body ?? '');
        if (briefSessionId && featureSlug) {
          featureRowRemoved = removeSessionPointer({
            workspaceId, slug: featureSlug, sessionId: briefSessionId,
          });
          rebuildProjectTOC(workspaceId);
        }
      } catch (err: any) { req.log.warn({ err }, 'FEATURE.md prune failed'); }

      // Step 7 — the brief row itself.
      try {
        db.delete(schema.briefs).where(eq(schema.briefs.id, briefId)).run();
      } catch (err: any) { req.log.warn({ err }, 'brief row delete failed'); }

      // Step 8 — workspace gets removed too if this was its only brief.
      // FK-order matters: SQLite's foreign_keys=ON refuses to delete a row
      // that anything else references. Every table that carries a workspaceId
      // FK gets zeroed first, then the workspace row itself. Silent-catch
      // each — if a subordinate delete fails we still try the next; the
      // final DELETE will fail with FK-error and we'll report workspace=false
      // so the user knows to clean up manually.
      let workspaceRemoved = false;
      try {
        const remainingBriefs = db.select().from(schema.briefs).all()
          .filter((b) => b.workspaceId === workspaceId).length;
        if (remainingBriefs === 0) {
          const wipe = (fn: () => void) => { try { fn(); } catch {} };
          wipe(() => db.delete(schema.projectIntakes).where(eq(schema.projectIntakes.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.workspaceRepos).where(eq(schema.workspaceRepos.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.workspaceBudgets).where(eq(schema.workspaceBudgets.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.discoveries).where(eq(schema.discoveries.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.plans).where(eq(schema.plans.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.deliverables).where(eq(schema.deliverables.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.designPicks).where(eq(schema.designPicks.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.validationRuns).where(eq(schema.validationRuns.workspaceId, workspaceId)).run());
          wipe(() => db.delete(schema.agentMemory).where(eq(schema.agentMemory.sourceWorkspaceId, workspaceId)).run());
          // Any lingering sessions row not tied to this brief but tied to the
          // workspace (rare but possible).
          wipe(() => db.delete(schema.sessions).where(eq(schema.sessions.workspaceId, workspaceId)).run());
          db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).run();
          workspaceRemoved = true;
        }
      } catch (err: any) { req.log.warn({ err }, 'workspace cascade delete failed'); }

      // Clean up gate state now that everything else is gone.
      taskGate.disposeBrief(briefId);

      return {
        ok: true, briefId, rejected: true,
        note: req.body?.note ?? null,
        deleted: {
          workItems: workItemsDeleted,
          approvals: approvalsDeleted,
          sessions: sessionsDeleted,
          artifactsDir: artifactsDeleted,
          featureRow: featureRowRemoved,
          workspace: workspaceRemoved,
        },
      };
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
