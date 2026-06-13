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
  systemPrompt?: string;
  model?: string | null;
  custom?: boolean;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
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
      systemPrompt: a.systemPrompt,
      model: a.model,
      custom: a.role.startsWith('custom-'),
    }));
}

export interface CustomAgentInput {
  displayName: string;
  role?: string;            // optional; derived from displayName when missing
  description?: string;     // unused server-side today but accepted for future fields
  systemPrompt: string;
  toolWhitelist?: string[];
  model?: string | null;    // 'haiku' | 'sonnet' | 'opus' | null = router decides
}

export function createCustomAgent(workspaceId: string, input: CustomAgentInput): HiredAgent {
  const db = getDb();

  // Make sure the workspace exists.
  const ws = db.select().from(schema.workspaces).all().find((w) => w.id === workspaceId);
  if (!ws) {
    db.insert(schema.workspaces).values({
      id: workspaceId, name: workspaceId,
      autonomyMode: 'approval-gated', createdAt: Date.now(),
    }).run();
  }

  if (!input.displayName.trim()) throw new Error('displayName is required');
  if (!input.systemPrompt.trim()) throw new Error('systemPrompt is required');

  const slug = slugify(input.role ?? input.displayName);
  const role = slug.startsWith('custom-') ? slug : `custom-${slug}`;
  const id = `${role}-${randomUUID().slice(0, 6)}`;

  db.insert(schema.agents).values({
    id, workspaceId, role,
    displayName: input.displayName.trim(),
    runtime: 'claude',
    model: input.model ?? null,
    systemPrompt: input.systemPrompt.trim(),
    toolWhitelist: JSON.stringify(input.toolWhitelist ?? ['Read', 'Glob', 'Grep']),
    status: 'idle',
    createdAt: Date.now(),
  }).run();

  appendEvent(workspaceId, {
    id: randomUUID(), ts: Date.now(), workspaceId, agentId: id,
    kind: 'system', level: 'info',
    text: `created custom agent ${input.displayName} (${role})`,
  } as SystemChunk);

  return {
    id, workspaceId, role,
    displayName: input.displayName.trim(),
    status: 'idle',
    toolWhitelist: input.toolWhitelist ?? ['Read', 'Glob', 'Grep'],
    systemPrompt: input.systemPrompt.trim(),
    model: input.model ?? null,
    custom: true,
  };
}

export interface UpdateAgentInput {
  displayName?: string;
  systemPrompt?: string;
  toolWhitelist?: string[];
  model?: string | null;
}

export function updateAgent(workspaceId: string, agentId: string, input: UpdateAgentInput): HiredAgent {
  const db = getDb();
  const row = db.select().from(schema.agents).all()
    .find((a) => a.id === agentId && a.workspaceId === workspaceId);
  if (!row) throw new Error(`agent ${agentId} not found in workspace ${workspaceId}`);

  const patch: Record<string, any> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName.trim();
  if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
  if (input.toolWhitelist !== undefined) patch.toolWhitelist = JSON.stringify(input.toolWhitelist);
  if (input.model !== undefined) patch.model = input.model;
  if (Object.keys(patch).length === 0) {
    return {
      id: row.id, workspaceId, role: row.role, displayName: row.displayName,
      status: row.status, toolWhitelist: safeArray(row.toolWhitelist),
      systemPrompt: row.systemPrompt, model: row.model, custom: row.role.startsWith('custom-'),
    };
  }

  db.update(schema.agents).set(patch)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .run();

  appendEvent(workspaceId, {
    id: randomUUID(), ts: Date.now(), workspaceId, agentId,
    kind: 'system', level: 'info',
    text: `edited agent ${patch.displayName ?? row.displayName} (${Object.keys(patch).join(', ')})`,
  } as SystemChunk);

  return {
    id: row.id, workspaceId, role: row.role,
    displayName: patch.displayName ?? row.displayName,
    status: row.status,
    toolWhitelist: patch.toolWhitelist ? JSON.parse(patch.toolWhitelist) : safeArray(row.toolWhitelist),
    systemPrompt: patch.systemPrompt ?? row.systemPrompt,
    model: patch.model !== undefined ? patch.model : row.model,
    custom: row.role.startsWith('custom-'),
  };
}

export function getAgent(workspaceId: string, agentId: string): HiredAgent | null {
  const db = getDb();
  const row = db.select().from(schema.agents).all()
    .find((a) => a.id === agentId && a.workspaceId === workspaceId);
  if (!row) return null;
  return {
    id: row.id, workspaceId, role: row.role,
    displayName: row.displayName, status: row.status,
    toolWhitelist: safeArray(row.toolWhitelist),
    systemPrompt: row.systemPrompt,
    model: row.model,
    custom: row.role.startsWith('custom-'),
  };
}

function safeArray(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
