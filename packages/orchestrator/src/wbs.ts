// Phase 4 — Work Breakdown Structure (WBS).
//
// Once a plan is dispatched, derive a flat list of trackable work items the
// user can move across a Kanban. Items are auto-seeded from the synthesis
// (one per recommended role × phase × success metric × risk) and editable
// by the user.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { appendEvent } from '@guideai/messaging/events';
import type { SystemChunk } from '@guideai/shared/chunks';
import type { DiscoverySynthesis } from './discovery.js';

export type WorkStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
// S3: pipeline emits plan/implement/review. 'research' and 'verify' remain in
// the union so pre-S3 DB rows still deserialize; new work items only use the
// 3-phase set. 'other' is the escape hatch for user-created items outside
// the pipeline.
export type WorkPhase = 'plan' | 'implement' | 'review' | 'other' | 'research' | 'verify';
export type WorkPriority = 'low' | 'normal' | 'high' | 'critical';

export interface WorkItem {
  id: string;
  workspaceId: string;
  briefId: string | null;
  planId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  assignedRole: string | null;
  assignedAgentId: string | null;
  phase: WorkPhase | null;
  status: WorkStatus;
  priority: WorkPriority;
  estimateHours: number | null;
  position: number;
  source: 'auto' | 'manual';
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  failureDiagnosis: string | null;
  featureTag: string | null;
  claudeSessionId: string | null;
  // S8 · GOAP-style deps. Empty array = no preconditions; task can start
  // whenever its lane opens.
  dependencies: string[];
  skillHint: string | null;
  acceptance: string | null;
  // S9 · captured on transition to in_progress; anchors the diff-review baseline.
  baseGitRef: string | null;
}

const STATUSES: WorkStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

function rowToItem(row: any): WorkItem {
  return {
    id: row.id, workspaceId: row.workspaceId,
    briefId: row.briefId, planId: row.planId, parentId: row.parentId,
    title: row.title, description: row.description,
    assignedRole: row.assignedRole, assignedAgentId: row.assignedAgentId,
    phase: row.phase, status: row.status, priority: row.priority,
    estimateHours: row.estimateHours, position: row.position,
    source: row.source,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    startedAt: row.startedAt, completedAt: row.completedAt,
    failureDiagnosis: row.failureDiagnosis ?? null,
    featureTag: row.featureTag ?? null,
    claudeSessionId: row.claudeSessionId ?? null,
    dependencies: parseDepsJson(row.dependencies),
    skillHint: row.skillHint ?? null,
    acceptance: row.acceptance ?? null,
    baseGitRef: row.baseGitRef ?? null,
  };
}

function parseDepsJson(s: unknown): string[] {
  if (!s) return [];
  try { const v = JSON.parse(String(s)); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}

function nextPosition(workspaceId: string, status: WorkStatus): number {
  const db = getDb();
  const rows = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === workspaceId && r.status === status);
  return (rows.reduce((m, r) => Math.max(m, r.position), -1) + 1);
}

export function listWorkItems(workspaceId: string, opts?: { briefId?: string; status?: WorkStatus }): WorkItem[] {
  const db = getDb();
  let rows = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === workspaceId);
  if (opts?.briefId) rows = rows.filter((r) => r.briefId === opts.briefId);
  if (opts?.status) rows = rows.filter((r) => r.status === opts.status);
  return rows
    .sort((a, b) => (a.status === b.status ? a.position - b.position : STATUSES.indexOf(a.status as WorkStatus) - STATUSES.indexOf(b.status as WorkStatus)))
    .map(rowToItem);
}

export function getWorkItem(id: string): WorkItem | null {
  const db = getDb();
  const row = db.select().from(schema.workItems).where(eq(schema.workItems.id, id)).all()[0];
  return row ? rowToItem(row) : null;
}

export interface CreateWorkItemInput {
  workspaceId: string;
  title: string;
  description?: string;
  briefId?: string | null;
  planId?: string | null;
  parentId?: string | null;
  assignedRole?: string | null;
  assignedAgentId?: string | null;
  phase?: WorkPhase | null;
  status?: WorkStatus;
  priority?: WorkPriority;
  estimateHours?: number | null;
  source?: 'auto' | 'manual';
  featureTag?: string | null;
  // S8 · optional GOAP fields.
  dependencies?: string[];
  skillHint?: string | null;
  acceptance?: string | null;
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  if (!input.title.trim()) throw new Error('title is required');
  const db = getDb();
  const id = `wi-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const status = input.status ?? 'todo';
  db.insert(schema.workItems).values({
    id,
    workspaceId: input.workspaceId,
    briefId: input.briefId ?? null,
    planId: input.planId ?? null,
    parentId: input.parentId ?? null,
    title: input.title.trim(),
    description: input.description ?? null,
    assignedRole: input.assignedRole ?? null,
    assignedAgentId: input.assignedAgentId ?? null,
    phase: input.phase ?? null,
    status,
    priority: input.priority ?? 'normal',
    estimateHours: input.estimateHours ?? null,
    position: nextPosition(input.workspaceId, status),
    source: input.source ?? 'manual',
    createdAt: now, updatedAt: now,
    startedAt: status === 'in_progress' ? now : null,
    completedAt: status === 'done' ? now : null,
    featureTag: input.featureTag ?? null,
    dependencies: JSON.stringify(input.dependencies ?? []),
    skillHint: input.skillHint ?? null,
    acceptance: input.acceptance ?? null,
  } as any).run();
  return getWorkItem(id)!;
}

/** S8 — a task is releasable when every id in its `dependencies` list is
 *  status=done. Used by the Kanban gate + server-side start check. */
export function canStartWorkItem(id: string): { ok: boolean; blockedBy: string[] } {
  const item = getWorkItem(id);
  if (!item) return { ok: false, blockedBy: [] };
  if (item.dependencies.length === 0) return { ok: true, blockedBy: [] };
  const db = getDb();
  const rows = db.select().from(schema.workItems).all()
    .filter((r) => item.dependencies.includes(r.id));
  const blockedBy = rows.filter((r) => r.status !== 'done').map((r) => r.id);
  return { ok: blockedBy.length === 0, blockedBy };
}

export interface UpdateWorkItemInput {
  title?: string;
  description?: string | null;
  assignedRole?: string | null;
  assignedAgentId?: string | null;
  phase?: WorkPhase | null;
  status?: WorkStatus;
  priority?: WorkPriority;
  estimateHours?: number | null;
  position?: number;
}

export function updateWorkItem(id: string, input: UpdateWorkItemInput): WorkItem {
  const db = getDb();
  const current = getWorkItem(id);
  if (!current) throw new Error(`work item ${id} not found`);
  const now = Date.now();
  const patch: Record<string, any> = { updatedAt: now };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.assignedRole !== undefined) patch.assignedRole = input.assignedRole;
  if (input.assignedAgentId !== undefined) patch.assignedAgentId = input.assignedAgentId;
  if (input.phase !== undefined) patch.phase = input.phase;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.estimateHours !== undefined) patch.estimateHours = input.estimateHours;
  if (input.position !== undefined) patch.position = input.position;
  if (input.status !== undefined && input.status !== current.status) {
    patch.status = input.status;
    if (input.status === 'in_progress' && !current.startedAt) patch.startedAt = now;
    if (input.status === 'done') patch.completedAt = now;
    if (input.status !== 'done') patch.completedAt = null;
    if (input.position === undefined) patch.position = nextPosition(current.workspaceId, input.status);
  }
  db.update(schema.workItems).set(patch).where(eq(schema.workItems.id, id)).run();
  return getWorkItem(id)!;
}

export function deleteWorkItem(id: string): { ok: true } {
  const db = getDb();
  db.delete(schema.workItems).where(eq(schema.workItems.id, id)).run();
  return { ok: true };
}

/**
 * Auto-generate a starter WBS from a dispatched plan + synthesis. Idempotent
 * per (planId, briefId) so re-running on the same plan doesn't duplicate.
 *
 * The pattern: a small set of items per recommended role (research + implement),
 * one review item per risk flag, one verify item per success metric.
 */
export function autoSeedFromPlan(args: {
  workspaceId: string;
  briefId: string;
  planId: string;
  synthesis: DiscoverySynthesis;
  featureTag?: string | null;
}): WorkItem[] {
  const db = getDb();
  // Idempotency: if any auto items already exist for this brief, skip.
  const existing = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId && r.briefId === args.briefId && r.source === 'auto');
  if (existing.length > 0) return existing.map(rowToItem);

  const items: WorkItem[] = [];
  const { workspaceId, briefId, planId, synthesis, featureTag } = args;
  const common = { workspaceId, briefId, planId, source: 'auto' as const, featureTag: featureTag ?? null };

  // S3: 3-phase auto-seed. Research folds into plan (one scoping item per
  // role); verify folds into review (one criterion per success metric).
  for (const role of synthesis.recommendedRoles.slice(0, 8)) {
    items.push(createWorkItem({
      ...common,
      title: `Scope ${role}'s slice`,
      description: `Define inputs, outputs, and acceptance for the ${role} thread; include any research needed to unblock the plan.`,
      assignedRole: role, phase: 'plan', priority: 'normal',
    }));
    items.push(createWorkItem({
      ...common,
      title: `Implement ${role}'s slice`,
      description: `Build the assigned slice end-to-end.`,
      assignedRole: role, phase: 'implement', priority: 'high',
    }));
  }

  // One review item per top risk (capped at 5).
  for (const risk of synthesis.riskFlags.slice(0, 5)) {
    items.push(createWorkItem({
      ...common,
      title: `Review risk: ${truncate(risk, 60)}`,
      description: risk,
      assignedRole: 'risk-officer', phase: 'review', priority: 'high',
    }));
  }

  // Success criteria are verified inside the review phase now (verify was
  // folded in for S3). One review item per success metric (capped at 6).
  for (const metric of synthesis.successMetrics.slice(0, 6)) {
    items.push(createWorkItem({
      ...common,
      title: `Verify: ${truncate(metric, 60)}`,
      description: `Confirm: ${metric}`,
      assignedRole: 'qa-expert', phase: 'review', priority: 'normal',
    }));
  }

  appendEvent(workspaceId, sys(workspaceId,
    `WBS auto-generated · ${items.length} items from plan ${planId} → brief ${briefId}`));
  return items;
}

/** Mark all auto items matching a (briefId, phase) as in_progress at phase
 *  start. Without this, cards visibly skip from Inactive → Done because the
 *  pipeline only updates state on phase completion. Called from runPipeline
 *  right before runOnce. */
export function markPhaseStarted(args: {
  workspaceId: string;
  briefId: string;
  phase: WorkPhase;
}): WorkItem[] {
  const db = getDb();
  const matching = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId
      && r.briefId === args.briefId
      && r.phase === args.phase
      && (r.status === 'todo' || r.status === 'blocked'));
  for (const r of matching) {
    updateWorkItem(r.id, { status: 'in_progress' });
    // S9 · capture the git HEAD as the diff-review baseline. Best-effort —
    // skipped if the target isn't a git repo (fine, /diff will simply return
    // an empty diff and the review webview won't pop).
    try { stampBaseGitRef(r.id, args.workspaceId); } catch {}
  }
  return matching.map((r) => getWorkItem(r.id)!);
}

function stampBaseGitRef(workItemId: string, workspaceId: string): void {
  const db = getDb();
  const wsRow = db.select().from(schema.workspaces).all()
    .find((w) => w.id === workspaceId) as any;
  const cwd = (wsRow?.targetFolder as string | undefined)?.trim();
  if (!cwd) return;
  // Late-require so this module doesn't take a hard child_process dep in
  // environments (test drivers) that never call markPhaseStarted.
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  // Auto-init the target folder as a git repo if it isn't one. Without this,
  // Diff review returns "no baseGitRef" and the per-task review affordance
  // does nothing — a common case since Atrune-managed folders often start
  // as plain directories. Baseline commit gives a real HEAD to diff against;
  // subsequent Claude edits show up as a clean per-task hunk set.
  const dotGit = pathMod.join(cwd, '.git');
  if (!fsMod.existsSync(dotGit)) {
    try {
      execSync('git init', { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
      // Local identity so `git commit` works even when the user has no
      // global git identity configured. Scope is --local so we don't touch
      // the user's global config.
      execSync('git config user.email "atrune@local"', { cwd, stdio: 'ignore' });
      execSync('git config user.name "Atrune"', { cwd, stdio: 'ignore' });
      // Ignore Atrune's own bookkeeping so its churn doesn't show up in
      // per-task diffs. `.atrune/` = per-workspace SQLite + logs;
      // `.claude/` = Claude Code's hook config we drop per spawn.
      const gitignorePath = pathMod.join(cwd, '.gitignore');
      const gitignore = fsMod.existsSync(gitignorePath)
        ? fsMod.readFileSync(gitignorePath, 'utf8')
        : '';
      const additions: string[] = [];
      if (!/^\.atrune\/?$/m.test(gitignore)) additions.push('.atrune/');
      if (!/^\.claude\/?$/m.test(gitignore)) additions.push('.claude/');
      if (additions.length > 0) {
        fsMod.writeFileSync(
          gitignorePath,
          (gitignore ? gitignore.replace(/\s*$/, '\n') : '') + additions.join('\n') + '\n',
        );
      }
      execSync('git add -A', { cwd, stdio: 'ignore' });
      // --allow-empty covers a truly empty target folder; the .gitignore
      // above at least gives us one file to commit.
      execSync('git commit --allow-empty -m "atrune baseline"', { cwd, stdio: 'ignore' });
    } catch {
      // git binary missing / permission problem / etc. Fall through: the
      // `git rev-parse HEAD` below will fail too, we silently skip stamping,
      // and diff review will still report "no baseGitRef" with an accurate
      // reason. Better than crashing the pipeline over a review feature.
    }
  }
  let head: string;
  try {
    head = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return; }  // not a git repo → skip
  if (!head) return;
  db.update(schema.workItems).set({ baseGitRef: head, updatedAt: Date.now() } as any)
    .where(eq(schema.workItems.id, workItemId)).run();
}

/** Mark all auto items matching a (briefId, phase) as done. Used when the
 *  pipeline finishes a phase so progress reflects real state. */
export function markPhaseComplete(args: {
  workspaceId: string;
  briefId: string;
  phase: WorkPhase;
}): WorkItem[] {
  const db = getDb();
  const matching = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId
      && r.briefId === args.briefId
      && r.phase === args.phase
      && r.status !== 'done' && r.status !== 'cancelled');
  for (const r of matching) {
    updateWorkItem(r.id, { status: 'done' });
  }
  return matching.map((r) => getWorkItem(r.id)!);
}

/** Plan-editor · flip every `phase='plan'` work_item for this brief back to
 *  `in_progress` so the Progress tracker reflects the regeneration. Called
 *  from the /plan/regenerate route BEFORE the fresh pipeline starts.
 *
 *  Also clears `claudeSessionId` — CRITICAL for Regenerate: the previous run
 *  minted a Claude session UUID + created its .jsonl file at
 *  `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`. If we re-spawn with the
 *  same `--session-id X`, Claude Code errors "Session ID X is already in
 *  use" → the child exits with 0 tokens → Regenerate looks like a silent
 *  no-op. Nulling `claudeSessionId` here makes resolveTaskSession() mint a
 *  FRESH UUID on the next Phase 1, so the spawn creates a NEW session file
 *  and Phase 1 actually runs. The OLD .jsonl stays on disk as history. */
export function revertPlanWorkItemsToInProgress(args: {
  workspaceId: string;
  briefId: string;
}): number {
  const db = getDb();
  const now = Date.now();
  const matching = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId
      && r.briefId === args.briefId
      && r.phase === 'plan'
      && r.status !== 'cancelled');
  for (const r of matching) {
    updateWorkItem(r.id, { status: 'in_progress' });
    // Reset completedAt + null claudeSessionId so a fresh session is minted
    // on the next Phase 1 spawn. See docblock for the rationale.
    try {
      db.update(schema.workItems)
        .set({
          completedAt: null as any,
          updatedAt: now,
          startedAt: now,
          claudeSessionId: null as any,
        } as any)
        .where(eq(schema.workItems.id, r.id))
        .run();
    } catch {}
  }
  return matching.length;
}

/** Mark all items matching a (briefId, phase) as blocked (UI shows this as
 *  "Failed"). Called from runPipeline when a phase throws so the task
 *  Kanban reflects the failure per-task, not just per-brief. */
export function markPhaseFailed(args: {
  workspaceId: string;
  briefId: string;
  phase: WorkPhase;
}): WorkItem[] {
  const db = getDb();
  const matching = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId
      && r.briefId === args.briefId
      && r.phase === args.phase
      && r.status !== 'done' && r.status !== 'cancelled');
  for (const r of matching) {
    updateWorkItem(r.id, { status: 'blocked' });
  }
  return matching.map((r) => getWorkItem(r.id)!);
}

/**
 * Bump last_heartbeat_at on every in_progress item for a brief. Called on
 * an interval by runPipeline so the sweeper can tell a phase is alive.
 * Returns how many rows were touched.
 */
export function bumpHeartbeatFor(args: { workspaceId: string; briefId: string }): number {
  const db = getDb();
  const now = Date.now();
  const items = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId
      && r.briefId === args.briefId
      && r.status === 'in_progress');
  for (const it of items) {
    db.update(schema.workItems).set({ lastHeartbeatAt: now } as any)
      .where(eq(schema.workItems.id, it.id)).run();
  }
  return items.length;
}

/**
 * Revert any in_progress item whose heartbeat is stale back to 'todo'. Runs
 * on server boot + on a periodic timer. Catches:
 *   - Server crashed mid-phase (heartbeat frozen)
 *   - User killed the orchestrator manually
 *   - A user dragged a card to Active but never released the gate
 * Stale = no heartbeat ever recorded AND startedAt > staleMs ago, OR
 *         heartbeat > staleMs ago.
 */
export function sweepStuckTasks(staleMs = 60_000): {
  reverted: Array<{ id: string; workspaceId: string; briefId: string | null; phase: string | null }>;
} {
  const db = getDb();
  const now = Date.now();
  const cutoff = now - staleMs;
  const stuck = db.select().from(schema.workItems).all()
    .filter((r) => r.status === 'in_progress')
    .filter((r) => {
      const hb = (r as any).lastHeartbeatAt as number | null | undefined;
      if (hb != null) return hb < cutoff;
      // No heartbeat ever — only revert if it's been in_progress for a while.
      const st = (r as any).startedAt as number | null;
      return st != null && st < cutoff;
    });
  for (const r of stuck) {
    db.update(schema.workItems).set({
      status: 'todo', updatedAt: now,
    }).where(eq(schema.workItems.id, r.id)).run();
  }
  return {
    reverted: stuck.map((r) => ({
      id: r.id, workspaceId: r.workspaceId,
      briefId: r.briefId ?? null, phase: r.phase ?? null,
    })),
  };
}

/**
 * Resolve which Claude session a task should use, keyed by
 * (workspaceId, featureTag, assignedRole). The first task with that combo
 * mints a fresh UUID; every subsequent task with the same combo — including
 * tasks under a DIFFERENT brief — reuses it so the conversation grows
 * across briefs that touch the same feature.
 *
 * Side effect: writes the resolved UUID back onto the work_item row so the
 * project / feature .md generators can list it.
 */
export function resolveTaskSession(args: {
  workspaceId: string;
  featureTag: string | null;
  role: string | null;
  taskId: string;          // the work_item being run right now
}): string {
  const db = getDb();
  if (!args.featureTag || !args.role) {
    // Fallback for legacy rows without a featureTag — mint a per-task UUID
    // so behaviour at least keeps the per-task isolation the user asked for.
    const fresh = randomUUID();
    db.update(schema.workItems).set({ claudeSessionId: fresh, updatedAt: Date.now() } as any)
      .where(eq(schema.workItems.id, args.taskId)).run();
    return fresh;
  }
  const existing = db.select().from(schema.workItems).all().find((r) => {
    if (r.workspaceId !== args.workspaceId) return false;
    if ((r as any).featureTag !== args.featureTag) return false;
    if (r.assignedRole !== args.role) return false;
    const sid = (r as any).claudeSessionId;
    return typeof sid === 'string' && sid.length > 0;
  });
  const sessionId = existing ? (existing as any).claudeSessionId as string : randomUUID();
  db.update(schema.workItems).set({ claudeSessionId: sessionId, updatedAt: Date.now() } as any)
    .where(eq(schema.workItems.id, args.taskId)).run();
  return sessionId;
}

/**
 * Is a runPipeline actively driving this brief right now? Yes iff any of
 * its work items has a heartbeat newer than `freshMs`. We use this on the
 * release-gate endpoint so dragging a phase to Active auto-spawns the
 * pipeline if the previous orchestrator process is gone.
 */
export function isPipelineAlive(briefId: string, freshMs = 30_000): boolean {
  const db = getDb();
  const cutoff = Date.now() - freshMs;
  return db.select().from(schema.workItems).all()
    .some((r) => r.briefId === briefId
      && (r as any).lastHeartbeatAt != null
      && (r as any).lastHeartbeatAt >= cutoff);
}

/**
 * Briefs whose pipeline appears to have died mid-flight — they have at least
 * one work item that's been through 'in_progress' (i.e. has startedAt set)
 * and no terminal state for any phase. The Resume action shows up for these.
 */
export function findResumableBriefs(workspaceId: string): Array<{ briefId: string; pendingPhases: string[] }> {
  const db = getDb();
  const rows = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === workspaceId && r.briefId);
  const byBrief = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byBrief.get(r.briefId!) ?? [];
    arr.push(r);
    byBrief.set(r.briefId!, arr);
  }
  const result: Array<{ briefId: string; pendingPhases: string[] }> = [];
  for (const [briefId, items] of byBrief) {
    const hasOpen = items.some((r) => r.status === 'todo' || r.status === 'in_progress');
    const wasStarted = items.some((r) => (r as any).startedAt != null);
    if (!hasOpen || !wasStarted) continue;
    const pendingPhases = Array.from(new Set(
      items.filter((r) => r.status !== 'done' && r.status !== 'cancelled')
        .map((r) => r.phase).filter(Boolean) as string[]
    ));
    result.push({ briefId, pendingPhases });
  }
  return result;
}

// ---------- helpers ----------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId,
    kind: 'system', level, text,
  };
}
