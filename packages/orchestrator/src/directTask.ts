// Phase 3 — Direct-task mode.
//
// Skip the full 5-phase pipeline ("brief → research → ... → verify") for moments
// where the user just wants ONE agent to do ONE thing. Two entry points:
//
//   runSingleAgent — you pick the agent (manual hire); we just call them.
//   runAutoFix      — describe the fix; we route to a likely specialist + run them.
//
// Both reuse every existing safety primitive: budget gate forecast, memory
// injection, PreToolUse hook, recordUsage. They only skip the discovery
// round-table and critic gate, which are heavyweight for a one-shot fix.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { paths } from '@guideai/shared/paths';
import { appendEvent } from '@guideai/messaging/events';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import type { AIChunk, Chunk, SystemChunk } from '@guideai/shared/chunks';
import { routeModel } from '@guideai/policies/router';
import {
  loadBudget, summarizeUsage, forecastPhaseCost, checkBudget, recordUsage,
  modelToTier, type Tier,
} from '@guideai/policies/budgets';
import { loadCatalog, findAgent } from '@guideai/agents-catalog';
import { renderMemoryBlock } from './memory.js';
import { hireAgent } from './hiring.js';
import { scoreAgent, type RoutableAgent } from './routing.js';

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

export interface DirectTaskRun {
  id: string;
  workspaceId: string;
  agentId: string;
  prompt: string;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  cwd: string;
  status: 'ok' | 'budget-blocked' | 'error';
  error?: string;
}

// ---------- runSingleAgent ----------

export async function runSingleAgent(args: {
  workspaceId: string;
  agentId: string;
  prompt: string;
  cwd?: string;
}): Promise<DirectTaskRun> {
  const db = getDb();
  const agentRow = db.select().from(schema.agents).all()
    .find((a) => a.id === args.agentId && a.workspaceId === args.workspaceId);
  if (!agentRow) throw new Error(`agent ${args.agentId} not in workspace ${args.workspaceId}`);

  const runId = `task-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const cwd = args.cwd ?? paths.agentCwd(args.workspaceId, args.agentId);
  fs.mkdirSync(cwd, { recursive: true });

  // Persona + memory block — same composition pattern as the pipeline.
  const persona = agentRow.role !== 'chief-of-staff' && agentRow.systemPrompt
    ? `## Your role\n\nYou are **${agentRow.displayName}** (${agentRow.role}).\n\n${agentRow.systemPrompt.slice(0, 1500)}`
    : '';
  const memory = renderMemoryBlock({
    role: agentRow.role, currentWorkspaceId: args.workspaceId,
  });
  const taskBlock =
    '## Direct task\n\n' +
    'You are running OUTSIDE the standard 5-phase pipeline. Treat this as a focused, ' +
    'single-shot task. Be concise. Do exactly what is asked; flag uncertainty rather than guessing.';
  const systemPrompt = [persona, memory, taskBlock].filter(Boolean).join('\n\n');

  // Budget gate.
  const routing = routeModel({ phase: 'implement', override: (agentRow.model as any) ?? undefined });
  const tier = modelToTier(routing.tier as Tier);
  const budgetCfg = loadBudget(args.workspaceId);
  const usage = summarizeUsage(args.workspaceId, budgetCfg);
  const forecast = forecastPhaseCost({
    tier, briefLength: args.prompt.length, artifactsLength: 0, k: 1,
  });
  const outcome = checkBudget({ cfg: budgetCfg, usage, forecast, tier });
  if (outcome.action === 'pause') {
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `direct-task ${runId} blocked: ${outcome.reason}`, 'error'));
    return {
      id: runId, workspaceId: args.workspaceId, agentId: args.agentId,
      prompt: args.prompt, text: '', tokensIn: 0, tokensOut: 0, costUsd: 0,
      durationMs: Date.now() - startedAt, cwd, status: 'budget-blocked', error: outcome.reason,
    };
  }
  if (outcome.action === 'warn') {
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `direct-task ${runId} budget warn: ${outcome.reason}`, 'warn'));
  }

  appendEvent(args.workspaceId, sys(args.workspaceId,
    `direct-task ${runId} → ${agentRow.displayName} (${agentRow.role}) · tier ${tier}`));

  // Run.
  try {
    const adapter = resolveActiveAdapter();
    const res = await adapter.runOnce(
      {
        agentId: agentRow.id, workspaceId: args.workspaceId, cwd, systemPrompt,
        allowedTools: safeArr(agentRow.toolWhitelist).length > 0 ? safeArr(agentRow.toolWhitelist) : READ_ONLY_TOOLS,
        model: routing.tier,
      },
      args.prompt,
    );
    for (const c of res.chunks) appendEvent(args.workspaceId, c);

    const text = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n');
    const tIn  = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensIn ?? 0), 0);
    const tOut = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensOut ?? 0), 0);

    recordUsage({
      workspaceId: args.workspaceId, agentId: agentRow.id, phase: 'direct-task',
      model: routing.tier, tokensIn: tIn, tokensOut: tOut,
    });

    appendEvent(args.workspaceId, sys(args.workspaceId,
      `direct-task ${runId} ✓ · ${tIn}↓/${tOut}↑ · ${Math.round((Date.now() - startedAt))}ms`));

    return {
      id: runId, workspaceId: args.workspaceId, agentId: agentRow.id,
      prompt: args.prompt, text, tokensIn: tIn, tokensOut: tOut,
      costUsd: tierCost(tier, tIn, tOut),
      durationMs: Date.now() - startedAt, cwd, status: 'ok',
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `direct-task ${runId} failed: ${msg}`, 'error'));
    return {
      id: runId, workspaceId: args.workspaceId, agentId: args.agentId,
      prompt: args.prompt, text: '', tokensIn: 0, tokensOut: 0, costUsd: 0,
      durationMs: Date.now() - startedAt, cwd, status: 'error', error: msg,
    };
  }
}

// ---------- runAutoFix ----------

/** Pick the best-matching agent from the roster (or hire one from the catalog)
 *  for a free-text fix description. Reuses scoring from routing.ts. */
export async function runAutoFix(args: {
  workspaceId: string;
  description: string;
  cwd?: string;
  hire?: boolean;       // when true, auto-hire from catalog if no good match
}): Promise<DirectTaskRun & { pickedAgentRole: string }> {
  const db = getDb();
  const roster = db.select().from(schema.agents).all()
    .filter((a) => a.workspaceId === args.workspaceId && a.status !== 'retired')
    .map((a): RoutableAgent => ({
      id: a.id, role: a.role, displayName: a.displayName,
      systemPrompt: a.systemPrompt, toolWhitelist: safeArr(a.toolWhitelist), model: a.model,
    }))
    .filter((a) => a.role !== 'chief-of-staff');

  const tokensFromDesc = args.description.toLowerCase().split(/\s+/).filter((t) => t.length >= 4).slice(0, 30);
  let best: { agent: RoutableAgent; score: number } | null = null;
  for (const a of roster) {
    const s = scoreAgent(a, 'implement', tokensFromDesc);
    if (!best || s > best.score) best = { agent: a, score: s };
  }

  // No good match on roster — auto-hire a sensible default if allowed.
  if ((!best || best.score <= 0) && (args.hire ?? true)) {
    const cat = loadCatalog();
    // v2 catalog has 8 core roles; 'coder' is the natural catch-all for one-shot
    // fixes. Fall back to 'fullstack-developer' (v1 legacy) if a custom seed
    // still ships it.
    const defaultRole = (cat && (findAgent(cat, 'coder')
                        || findAgent(cat, 'fullstack-developer')
                        || findAgent(cat, 'backend-developer')))?.role
                     ?? 'coder';
    try {
      const hired = hireAgent(args.workspaceId, defaultRole);
      appendEvent(args.workspaceId, sys(args.workspaceId,
        `auto-fix: hired ${hired.displayName} on-demand for: "${args.description.slice(0, 60)}"`));
      best = {
        agent: {
          id: hired.id, role: hired.role, displayName: hired.displayName,
          systemPrompt: hired.systemPrompt, toolWhitelist: hired.toolWhitelist, model: hired.model,
        },
        score: 1,
      };
    } catch (err: any) {
      throw new Error(`no roster match and auto-hire failed: ${err?.message ?? err}`);
    }
  }
  if (!best) throw new Error('no agent available for auto-fix');

  appendEvent(args.workspaceId, sys(args.workspaceId,
    `auto-fix → ${best.agent.displayName} (${best.agent.role}) · score ${best.score}`));

  const run = await runSingleAgent({
    workspaceId: args.workspaceId,
    agentId: best.agent.id,
    prompt: args.description,
    cwd: args.cwd,
  });
  return { ...run, pickedAgentRole: best.agent.role };
}

// ---------- helpers ----------

function tierCost(tier: Tier, tIn: number, tOut: number): number {
  // Inlined from policies/budgets to avoid a circular import shape;
  // keep in sync with PRICE there.
  const PRICE: Record<Tier, { in: number; out: number }> = {
    haiku:  { in: 1.00, out: 5.00 },
    sonnet: { in: 3.00, out: 15.00 },
    opus:   { in: 15.00, out: 75.00 },
  };
  const p = PRICE[tier];
  return (tIn * p.in + tOut * p.out) / 1_000_000;
}

function safeArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId,
    kind: 'system', level, text,
  };
}
