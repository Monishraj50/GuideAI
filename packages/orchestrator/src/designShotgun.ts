// Phase 11 — Design-shotgun.
//
// When a brief is tagged `[design]` (mirroring the `[security]` tag), the
// implement phase generates N parallel variants instead of one. Each variant
// is persisted as a `design-variant` deliverable; the user picks one in the
// UI, and that pick feeds future design briefs as taste-memory context.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { appendEvent } from '@guideai/messaging/events';
import type { SystemChunk } from '@guideai/shared/chunks';
import {
  createDeliverable, getDeliverable, listDeliverables, type Deliverable,
} from './deliverables.js';

export const DESIGN_TAG_RE = /^\s*\[(design|ux|ui)\]/i;
export const DESIGN_VARIANTS = 4;

/** Eight different angles a designer might take. Indexed into per attempt. */
export const DESIGN_LENSES: { lens: string; instructions: string }[] = [
  { lens: 'mvp-first',     instructions: 'Prioritise simplicity and shipping the smallest useful slice.' },
  { lens: 'power-user',    instructions: 'Optimise for speed and density; assume the user already knows the domain.' },
  { lens: 'first-timer',   instructions: 'Guide a new user with explicit hand-holding, empty states, and progressive disclosure.' },
  { lens: 'accessibility', instructions: 'Lead with keyboard navigability, contrast, and screen-reader semantics.' },
];

export function isDesignTagged(briefBody: string): boolean {
  return DESIGN_TAG_RE.test(briefBody);
}

export interface DesignPick {
  id: string;
  workspaceId: string;
  briefId: string | null;
  pickedDeliverableId: string;
  rejectedDeliverableIds: string[];
  notes: string | null;
  createdAt: number;
}

function rowToPick(row: any): DesignPick {
  return {
    id: row.id, workspaceId: row.workspaceId, briefId: row.briefId,
    pickedDeliverableId: row.pickedDeliverableId,
    rejectedDeliverableIds: safeJsonArray(row.rejectedDeliverableIds),
    notes: row.notes, createdAt: row.createdAt,
  };
}
function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export function listDesignPicks(workspaceId: string): DesignPick[] {
  const db = getDb();
  return db.select().from(schema.designPicks).all()
    .filter((p) => p.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(rowToPick);
}

/**
 * Mark a deliverable as the picked variant. Any other `design-variant`
 * deliverable from the same brief gets recorded as rejected. Replaces any
 * prior pick for the same brief.
 */
export function pickVariant(args: {
  pickedDeliverableId: string;
  notes?: string;
}): DesignPick {
  const picked = getDeliverable(args.pickedDeliverableId);
  if (!picked) throw new Error(`deliverable ${args.pickedDeliverableId} not found`);
  if (picked.kind !== 'design-variant') throw new Error('pick targets a non-variant deliverable');

  const db = getDb();
  const siblings = (picked.briefId
    ? listDeliverables(picked.workspaceId, { briefId: picked.briefId, kind: 'design-variant' })
    : []
  ).filter((d) => d.id !== picked.id);

  // Replace any prior pick for the same brief.
  if (picked.briefId) {
    const prior = db.select().from(schema.designPicks).all()
      .filter((p) => p.workspaceId === picked.workspaceId && p.briefId === picked.briefId);
    for (const p of prior) {
      db.delete(schema.designPicks).where(eq(schema.designPicks.id, p.id)).run();
    }
  }

  const id = `pick-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.insert(schema.designPicks).values({
    id,
    workspaceId: picked.workspaceId,
    briefId: picked.briefId,
    pickedDeliverableId: picked.id,
    rejectedDeliverableIds: JSON.stringify(siblings.map((s) => s.id)),
    notes: args.notes ?? null,
    createdAt: now,
  } as any).run();

  appendEvent(picked.workspaceId, sys(picked.workspaceId,
    `design pick: ${picked.title} (rejected ${siblings.length} siblings)`));

  return {
    id, workspaceId: picked.workspaceId, briefId: picked.briefId,
    pickedDeliverableId: picked.id,
    rejectedDeliverableIds: siblings.map((s) => s.id),
    notes: args.notes ?? null,
    createdAt: now,
  };
}

/** Persist one variant attempt as a deliverable. Called by the pipeline per attempt. */
export function persistVariant(args: {
  workspaceId: string;
  briefId: string;
  lens: string;
  body: string;
  index: number;
}): Deliverable {
  return createDeliverable({
    workspaceId: args.workspaceId,
    briefId: args.briefId,
    kind: 'design-variant',
    title: `Variant ${args.index + 1} · ${args.lens}`,
    body: args.body,
    source: 'auto',
  } as any);
}

/**
 * Render past picks as a "taste memory" block for future design briefs in the
 * same workspace. Caps at 4 entries so the prompt stays cheap.
 */
export function renderTasteMemory(workspaceId: string, limit = 4): string {
  const picks = listDesignPicks(workspaceId).slice(0, limit);
  if (picks.length === 0) return '';
  const lines: string[] = [
    '## Taste memory — variants the user has picked before:',
  ];
  for (const p of picks) {
    const d = getDeliverable(p.pickedDeliverableId);
    if (!d) continue;
    const headline = d.title.replace(/^Variant \d+\s*·\s*/, '');
    lines.push(`- _${headline}_: ${(d.body ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}

// ---------- helpers ----------

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return { id: randomUUID(), ts: Date.now(), workspaceId, kind: 'system', level, text };
}
