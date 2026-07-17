// S10 · Vessel × Talent × Task runtime.
//
// Two factories + one executor. Every phase call + every direct-task call
// funnels through here now; adapter invocation is centralized so future
// concerns (retry, timeout, per-vessel sandbox posture) land in ONE place.
//
// The factories are read-only lookups against DB + memory + catalog — no
// side effects. `runTask` is the only surface that spawns a Claude adapter.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import type { Vessel, Talent, Task, TalentSkill } from '@guideai/shared/types';
import type { AIChunk, Chunk, SystemChunk } from '@guideai/shared/chunks';
import { appendEvent } from '@guideai/messaging/events';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import { loadSkills, skillsForPhase, pickSkill, renderSkillAsRunbook, renderSkillsAsContext } from '@guideai/skills';
import { renderMemoryBlock } from './memory.js';
import { firstUserChunkTag, isFirstTurn } from './sessions.js';

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

// ─── makeVessel ────────────────────────────────────────────────

export interface MakeVesselArgs {
  workspaceId: string;
  role: string;
  cwd: string;
  model: string;
  /** Explicit tool whitelist. Falls back to the role's persisted list, then
   *  to READ_ONLY_TOOLS. */
  toolWhitelist?: string[] | null;
  sessionId?: string;
  timeoutMs?: number;
  retry?: { max: number; backoffMs: number };
}

/** Build a Vessel from a role + workspace context. Reads the agent row for
 *  its persisted tool whitelist unless the caller explicitly overrides. */
export function makeVessel(args: MakeVesselArgs): Vessel {
  const tools = normalizeTools(args.toolWhitelist)
    ?? readAgentTools(args.workspaceId, args.role)
    ?? READ_ONLY_TOOLS;
  return {
    workspaceId: args.workspaceId,
    cwd: args.cwd,
    allowedTools: tools,
    model: args.model,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.retry ? { retry: args.retry } : {}),
  };
}

function readAgentTools(workspaceId: string, role: string): string[] | null {
  const db = getDb();
  const row = db.select().from(schema.agents).all()
    .find((a) => a.workspaceId === workspaceId && a.role === role && a.status !== 'retired');
  if (!row?.toolWhitelist) return null;
  try {
    const v = JSON.parse(row.toolWhitelist);
    return Array.isArray(v) && v.length > 0 ? v : null;
  } catch { return null; }
}

function normalizeTools(v: string[] | null | undefined): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.length > 0 ? v : null;
}

// ─── pickTalent ────────────────────────────────────────────────

export interface PickTalentArgs {
  workspaceId: string;
  role: string;
  /** Optional agent id override — bypass the by-role lookup. */
  agentId?: string;
  /** Task text used to score which skill (if any) should be selected. */
  taskText?: string;
  /** Phase tag for skill filtering (plan|implement|review). */
  phase?: string;
}

/** Hydrate a Talent from the roster + memory + skills. Returns a "cos"
 *  fallback (with empty persona) when no matching agent is on the roster
 *  — the caller can still run against it. */
export function pickTalent(args: PickTalentArgs): Talent {
  const db = getDb();
  const rows = db.select().from(schema.agents).all()
    .filter((a) => a.workspaceId === args.workspaceId && a.status !== 'retired');
  const agent = args.agentId
    ? rows.find((a) => a.id === args.agentId)
    : rows.find((a) => a.role === args.role && a.role !== 'chief-of-staff')
      ?? rows.find((a) => a.role === args.role)
      ?? rows.find((a) => a.role === 'chief-of-staff');

  const memory = renderMemoryBlock({
    role: args.role, currentWorkspaceId: args.workspaceId,
  });

  const allSkills = loadSkills();
  const applicable = args.phase ? skillsForPhase(allSkills, args.phase) : allSkills;
  const picked = args.taskText
    ? pickSkill({ taskText: args.taskText, phase: args.phase, skills: applicable })
    : null;
  const menu: TalentSkill[] = applicable.map((s) => ({ name: s.name, body: s.body, source: s.source }));

  return {
    agentId: agent?.id ?? `cos-${randomUUID().slice(0, 8)}`,
    role: agent?.role ?? args.role,
    displayName: agent?.displayName ?? args.role,
    systemPrompt: agent?.systemPrompt ?? '',
    memoryBlock: memory,
    skill: picked ? { name: picked.skill.name, body: picked.skill.body, source: picked.skill.source } : null,
    skillsMenu: menu,
  };
}

// ─── runTask ───────────────────────────────────────────────────

export interface RunTaskResult {
  text: string;
  chunks: Chunk[];
  tokensIn: number;
  tokensOut: number;
}

export interface RunTaskOpts {
  onChunk?: (c: Chunk) => void;
}

/**
 * Combine vessel + talent + task into a single adapter call. Emits the same
 * pattern of chunks phases.ts + directTask.ts used to emit inline — but now
 * the composition lives in one place. Returns the full result so the caller
 * can persist artifacts, account usage, etc.
 */
export async function runTask(
  vessel: Vessel, talent: Talent, task: Task, opts: RunTaskOpts = {},
): Promise<RunTaskResult> {
  const personaBlock = talent.systemPrompt && talent.role !== 'chief-of-staff'
    ? `## Your role\n\nYou are **${talent.displayName}** (${talent.role}).\n\n${talent.systemPrompt.slice(0, 1500)}`
    : '';
  const skillBlock = talent.skill
    ? renderSkillAsRunbook(
        { name: talent.skill.name, body: talent.skill.body, source: (talent.skill.source ?? '_seed') as any, description: '', appliesTo: [], keywords: [] },
        task.prompt,
      )
    : renderSkillsAsContext(
        talent.skillsMenu.map((s) => ({ name: s.name, body: s.body, source: (s.source ?? '_seed') as any, description: '', appliesTo: [], keywords: [] })),
      );
  const extras = (task.systemPromptExtras ?? []).filter(Boolean).join('\n\n');
  const systemPrompt = [personaBlock, talent.memoryBlock, extras, skillBlock].filter(Boolean).join('\n\n');

  // Tag first turn if requested + this session hasn't seen one yet.
  const firstTurn = !!vessel.sessionId && !!task.tagFirstTurn && isFirstTurn(vessel.sessionId);
  const tag = firstUserChunkTag({ featureSlug: task.featureSlug ?? null });
  const prompt = firstTurn ? `${tag} ${task.prompt}` : task.prompt;
  if (firstTurn) {
    appendEvent(vessel.workspaceId, {
      id: randomUUID(), ts: Date.now(),
      workspaceId: vessel.workspaceId, agentId: talent.agentId,
      kind: 'system', level: 'info',
      text: `session ${vessel.sessionId!.slice(0, 8)}… first turn tagged ${tag}`,
    } as SystemChunk);
  }

  const res = await resolveActiveAdapter().runOnce(
    {
      agentId: talent.agentId,
      workspaceId: vessel.workspaceId,
      cwd: vessel.cwd,
      systemPrompt,
      allowedTools: vessel.allowedTools,
      model: vessel.model,
      onChunk: opts.onChunk,
      ...(vessel.sessionId ? { sessionId: vessel.sessionId } : {}),
      ...(task.briefId ? { briefId: task.briefId } : {}),
    },
    prompt,
  );

  const text = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n');
  const tokensIn = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensIn ?? 0), 0);
  const tokensOut = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensOut ?? 0), 0);
  return { text, chunks: res.chunks, tokensIn, tokensOut };
}
