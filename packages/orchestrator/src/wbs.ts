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
export type WorkPhase = 'research' | 'plan' | 'implement' | 'review' | 'verify' | 'other';
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
  };
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
  } as any).run();
  return getWorkItem(id)!;
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
}): WorkItem[] {
  const db = getDb();
  // Idempotency: if any auto items already exist for this brief, skip.
  const existing = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId && r.briefId === args.briefId && r.source === 'auto');
  if (existing.length > 0) return existing.map(rowToItem);

  const items: WorkItem[] = [];
  const { workspaceId, briefId, planId, synthesis } = args;
  const common = { workspaceId, briefId, planId, source: 'auto' as const };

  // Roles: 1 research + 1 implement per recommended role.
  for (const role of synthesis.recommendedRoles.slice(0, 8)) {
    items.push(createWorkItem({
      ...common,
      title: `Scope ${role}'s slice`,
      description: `Define inputs, outputs, and acceptance for the ${role} thread.`,
      assignedRole: role, phase: 'research', priority: 'normal',
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

  // One verify item per success metric (capped at 6).
  for (const metric of synthesis.successMetrics.slice(0, 6)) {
    items.push(createWorkItem({
      ...common,
      title: `Verify: ${truncate(metric, 60)}`,
      description: `Confirm: ${metric}`,
      assignedRole: 'qa-expert', phase: 'verify', priority: 'normal',
    }));
  }

  appendEvent(workspaceId, sys(workspaceId,
    `WBS auto-generated · ${items.length} items from plan ${planId} → brief ${briefId}`));
  return items;
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
