import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { loadCatalog, findAgent } from '@guideai/agents-catalog';
import { appendEvent } from '@guideai/messaging/events';
import type { SystemChunk } from '@guideai/shared/chunks';

export interface HiredAgent {
  id: string;
  workspaceId: string;
  role: string;
  displayName: string;
  status: string;
  toolWhitelist: string[];
}

function ensureWorkspaceExists(workspaceId: string) {
  const db = getDb();
  const existing = db.select().from(schema.workspaces).all().find((w) => w.id === workspaceId);
  if (!existing) {
    db.insert(schema.workspaces).values({
      id: workspaceId, name: workspaceId,
      autonomyMode: 'approval-gated', createdAt: Date.now(),
    }).run();
  }
}

export function hireAgent(workspaceId: string, role: string): HiredAgent {
  const catalog = loadCatalog();
  if (!catalog) throw new Error('catalog not seeded yet — run `pnpm --filter @guideai/agents-catalog seed`');
  const def = findAgent(catalog, role);
  if (!def) throw new Error(`role ${role} not found in catalog`);

  ensureWorkspaceExists(workspaceId);

  const db = getDb();
  const existing = db.select().from(schema.agents).all()
    .find((a) => a.workspaceId === workspaceId && a.role === role && a.status !== 'retired');
  if (existing) {
    return {
      id: existing.id, workspaceId, role,
      displayName: existing.displayName, status: existing.status,
      toolWhitelist: safeArray(existing.toolWhitelist),
    };
  }

  const id = `${role}-${randomUUID().slice(0, 6)}`;
  db.insert(schema.agents).values({
    id, workspaceId, role,
    displayName: def.displayName,
    runtime: 'claude',
    model: def.model ?? null,
    systemPrompt: def.body,
    toolWhitelist: JSON.stringify(def.tools),
    status: 'idle',
    createdAt: Date.now(),
  }).run();

  const note: SystemChunk = {
    id: randomUUID(), ts: Date.now(), workspaceId, agentId: id,
    kind: 'system', level: 'info',
    text: `hired ${def.displayName} (${role}) into workspace`,
  };
  appendEvent(workspaceId, note);

  return {
    id, workspaceId, role, displayName: def.displayName,
    status: 'idle', toolWhitelist: def.tools,
  };
}

export function retireAgent(workspaceId: string, agentId: string): { ok: true } {
  const db = getDb();
  const row = db.select().from(schema.agents).all()
    .find((a) => a.id === agentId && a.workspaceId === workspaceId);
  if (!row) throw new Error(`agent ${agentId} not found in workspace ${workspaceId}`);
  db.update(schema.agents).set({ status: 'retired' })
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .run();
  const note: SystemChunk = {
    id: randomUUID(), ts: Date.now(), workspaceId, agentId,
    kind: 'system', level: 'info',
    text: `retired ${row.displayName}`,
  };
  appendEvent(workspaceId, note);
  return { ok: true };
}

export function listRoster(workspaceId: string): HiredAgent[] {
  const db = getDb();
  return db.select().from(schema.agents).all()
    .filter((a) => a.workspaceId === workspaceId && a.status !== 'retired')
    .map((a) => ({
      id: a.id, workspaceId, role: a.role,
      displayName: a.displayName, status: a.status,
      toolWhitelist: safeArray(a.toolWhitelist),
    }));
}

function safeArray(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
