// Phase 10 — Cross-workspace agent memory.
//
// Each role accumulates lightweight notes per workspace. When a role runs in
// any workspace, GuideAI loads notes from workspaces whose ACL permits sharing.
// Notes get injected into the agent's system prompt as a small block.
//
// Inspired by gstack's GBrain (per-repo trust tiers). v1 is manual-only —
// the user adds notes via UI; we don't auto-distill from traces (skill
// promotion already covers that lane).

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { appendEvent } from '@guideai/messaging/events';
import type { SystemChunk } from '@guideai/shared/chunks';
import { readProjectContext } from './projectContext.js';

export type MemoryShare = 'all' | 'read-only' | 'deny';

export interface MemoryEntry {
  id: string;
  role: string;
  sourceWorkspaceId: string;
  body: string;
  source: 'manual' | 'auto';
  createdAt: number;
  updatedAt: number;
}

function rowToEntry(row: any): MemoryEntry {
  return {
    id: row.id, role: row.role, sourceWorkspaceId: row.sourceWorkspaceId,
    body: row.body, source: row.source as 'manual' | 'auto',
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

// ---------- ACL ----------

export function getMemoryShare(workspaceId: string): MemoryShare {
  const db = getDb();
  const ws = db.select().from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId)).all()[0];
  return ((ws as any)?.memoryShare as MemoryShare) ?? 'read-only';
}

export function setMemoryShare(workspaceId: string, share: MemoryShare): void {
  if (!['all', 'read-only', 'deny'].includes(share)) {
    throw new Error(`invalid share: ${share}`);
  }
  const db = getDb();
  db.update(schema.workspaces).set({ memoryShare: share } as any)
    .where(eq(schema.workspaces.id, workspaceId)).run();
  appendEvent(workspaceId, sys(workspaceId, `memory share set to ${share}`));
}

// ---------- entries ----------

export function listMemoryByWorkspace(workspaceId: string, opts?: { role?: string }): MemoryEntry[] {
  const db = getDb();
  let rows = db.select().from(schema.agentMemory).all()
    .filter((r) => r.sourceWorkspaceId === workspaceId);
  if (opts?.role) rows = rows.filter((r) => r.role === opts.role);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(rowToEntry);
}

export function createMemory(args: {
  workspaceId: string; role: string; body: string; source?: 'manual' | 'auto';
}): MemoryEntry {
  if (!args.role.trim() || !args.body.trim()) {
    throw new Error('role and body are required');
  }
  const db = getDb();
  const id = `mem-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.insert(schema.agentMemory).values({
    id,
    role: args.role.trim(),
    sourceWorkspaceId: args.workspaceId,
    body: args.body.trim(),
    source: args.source ?? 'manual',
    createdAt: now, updatedAt: now,
  } as any).run();
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `memory note added for ${args.role} (${args.source ?? 'manual'})`));
  return {
    id, role: args.role.trim(), sourceWorkspaceId: args.workspaceId,
    body: args.body.trim(), source: args.source ?? 'manual',
    createdAt: now, updatedAt: now,
  };
}

export function deleteMemory(id: string): { ok: true } {
  const db = getDb();
  const row = db.select().from(schema.agentMemory)
    .where(eq(schema.agentMemory.id, id)).all()[0];
  db.delete(schema.agentMemory).where(eq(schema.agentMemory.id, id)).run();
  if (row) {
    appendEvent(row.sourceWorkspaceId, sys(row.sourceWorkspaceId,
      `memory note deleted: ${id}`, 'warn'));
  }
  return { ok: true };
}

// ---------- cross-workspace read ----------

/**
 * Return memory entries the given role can see when running in `currentWorkspaceId`.
 *
 * Rules:
 *   - Entries from currentWorkspaceId are always included.
 *   - Entries from other workspaces are included if their `memory_share` is
 *     `all` or `read-only` (deny = excluded).
 *   - Newer notes first; capped at 6 entries to keep prompts lean.
 */
export function loadAgentMemoryForRole(args: {
  role: string;
  currentWorkspaceId: string;
  limit?: number;
}): MemoryEntry[] {
  const db = getDb();
  const all = db.select().from(schema.workspaces).all()
    .filter((w: any) => w.memoryShare !== 'deny' || w.id === args.currentWorkspaceId);
  const allowed = new Set(all.map((w: any) => w.id));

  const rows = db.select().from(schema.agentMemory).all()
    .filter((r) => r.role === args.role && allowed.has(r.sourceWorkspaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, args.limit ?? 6);
  return rows.map(rowToEntry);
}

/**
 * Render the memory block that gets prepended to a role's system prompt.
 *
 * Two layers, concatenated when present:
 *   1. **Project context** — requirements.md + this role's rolling summary +
 *      past analyses of this role's work in prior briefs (read from disk).
 *      Always-relevant scaffolding for fix/feature work.
 *   2. **Cross-workspace memory** — distilled notes from agentMemory table
 *      (manual + auto-promoted via skills).
 *
 * Returns an empty string when both layers are empty.
 */
export function renderMemoryBlock(args: {
  role: string;
  currentWorkspaceId: string;
}): string {
  const blocks: string[] = [];

  // Layer 1 — project-level requirements + this role's history in THIS project.
  try {
    const projectCtx = readProjectContext({
      workspaceId: args.currentWorkspaceId,
      role: args.role,
    });
    if (projectCtx) blocks.push(projectCtx);
  } catch {}

  // Layer 2 — distilled cross-workspace notes for this role.
  const entries = loadAgentMemoryForRole(args);
  if (entries.length > 0) {
    const lines = ['## Past notes (from previous projects)', ''];
    for (const e of entries) {
      const where = e.sourceWorkspaceId === args.currentWorkspaceId ? 'this workspace' : `from \`${e.sourceWorkspaceId}\``;
      lines.push(`- ${e.body} _(${where})_`);
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n---\n\n');
}

// ---------- helpers ----------

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return { id: randomUUID(), ts: Date.now(), workspaceId, kind: 'system', level, text };
}
