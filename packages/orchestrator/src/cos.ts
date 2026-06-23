import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { getDb, schema } from '@guideai/shared/db';
import type { UserChunk, SystemChunk } from '@guideai/shared/chunks';
import { runPipeline, PHASE_ORDER } from './phases.js';
import { routeRoster, type RoutableAgent } from './routing.js';
import { promoteSkillFromTrace } from '@guideai/skills';
import { harvestBriefDeliverables } from './deliverables.js';
import { loadTarget, runValidation } from './validate.js';
import { loadIntake } from './discovery.js';
import { isDesignTagged } from './designShotgun.js';
import { hireAgent } from './hiring.js';
import { writeBriefAnalyses, appendAgentSummary, writeBriefChat } from './projectContext.js';
import * as taskGate from './taskGate.js';
import { eq } from 'drizzle-orm';

const COS_AGENT_ROLE = 'chief-of-staff';
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

function now() { return Date.now(); }
function base(workspaceId: string, agentId?: string) {
  return { id: randomUUID(), ts: now(), workspaceId, ...(agentId ? { agentId } : {}) };
}
function safeArray(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Read the workspace's meta.json to find its configured project folder.
 *  Returns null if unset or unreadable — caller falls back. */
function readWorkspaceTargetFolder(workspaceId: string): string | null {
  // Try the registered storage root first (where new workspaces live), then
  // the sandbox fallback (for pre-registry workspaces).
  const candidates = [paths.workspaceDir(workspaceId), path.join(paths.workspaces, workspaceId)];
  for (const root of candidates) {
    try {
      const p = path.join(root, 'meta.json');
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (typeof j?.targetFolder === 'string' && j.targetFolder.trim()) {
        return j.targetFolder.trim();
      }
    } catch {}
  }
  return null;
}

async function ensureWorkspace(workspaceId: string, name?: string) {
  const db = getDb();
  const existing = db.select().from(schema.workspaces).all().find((w) => w.id === workspaceId);
  if (!existing) {
    db.insert(schema.workspaces).values({
      id: workspaceId,
      name: name ?? workspaceId,
      autonomyMode: 'approval-gated',
      createdAt: now(),
    }).run();
  }
}

async function ensureCosAgent(workspaceId: string): Promise<string> {
  const db = getDb();
  const all = db.select().from(schema.agents).all().filter((a) => a.workspaceId === workspaceId && a.role === COS_AGENT_ROLE);
  if (all.length > 0) return all[0]!.id;
  const id = `cos-${randomUUID().slice(0, 8)}`;
  db.insert(schema.agents).values({
    id,
    workspaceId,
    role: COS_AGENT_ROLE,
    displayName: 'Chief of Staff',
    runtime: 'claude',
    model: null,
    systemPrompt: 'Chief of Staff for an autonomous team.',
    toolWhitelist: JSON.stringify(READ_ONLY_TOOLS),
    status: 'idle',
    createdAt: now(),
  }).run();
  return id;
}

export interface SubmitBriefResult {
  briefId: string;
  agentId: string;
  phases: string[];
  securityTagged: boolean;
  pipeline: 'started';
  approvalId?: string;  // legacy field, kept for response shape compatibility
}

/**
 * Submit a brief, then kick off the full pipeline in the background. Returns
 * immediately so the UI can light up via SSE without holding an HTTP request
 * open for the duration. Phase events + the synthetic approval are appended to
 * the workspace event stream as the pipeline progresses.
 */
export async function submitBrief(args: {
  workspaceId: string;
  body: string;
  securityTagged?: boolean;
  /** Local filesystem path where agents should write code. Becomes the pipeline's cwd. */
  targetFolder?: string;
  /** Catalog roles to ensure are hired before phase 1. Missing ones auto-hire. */
  taggedAgents?: string[];
  /** Soft budget hint surfaced as a system event for the UI. */
  budget?: { mode: 'tokens' | 'currency'; amount: number };
  /** Execution mode. 'auto' (default) runs end-to-end. 'manual' awaits a
   *  per-phase release call (the Kanban drives this). 'pending' (Phase C —
   *  defer-dispatch) blocks at the synthetic start gate until the user clicks
   *  Start Implementing in the project UI; the /start endpoint then promotes
   *  the brief to auto or manual and releases the gate. */
  mode?: 'pending' | 'auto' | 'manual';
}): Promise<SubmitBriefResult> {
  const { workspaceId, body } = args;
  // A brief is security-tagged if the caller asks for it OR the body contains
  // a [security] / [sec] tag near the start.
  const securityTagged = !!args.securityTagged || /^\s*\[(security|sec)\]/i.test(body);
  await ensureWorkspace(workspaceId);
  const agentId = await ensureCosAgent(workspaceId);

  // Auto-hire any tagged agents not already on the roster. Failures are
  // logged but non-fatal — the pipeline still runs with whoever IS hired.
  if (args.taggedAgents?.length) {
    const db = getDb();
    const have = new Set(
      db.select().from(schema.agents).all()
        .filter((a) => a.workspaceId === workspaceId && a.status !== 'retired')
        .map((a) => a.role),
    );
    for (const role of args.taggedAgents) {
      if (have.has(role)) continue;
      try {
        await hireAgent(workspaceId, role);
        const hireNote: SystemChunk = {
          ...base(workspaceId), kind: 'system',
          text: `auto-hired ${role} from marketplace (brief-tagged)`,
        };
        appendEvent(workspaceId, hireNote);
      } catch (err: any) {
        const failNote: SystemChunk = {
          ...base(workspaceId), kind: 'system',
          text: `could not auto-hire ${role}: ${String(err?.message ?? err)}`,
        };
        appendEvent(workspaceId, failNote);
      }
    }
  }

  const db = getDb();
  const briefId = `brief-${randomUUID().slice(0, 8)}`;
  db.insert(schema.briefs).values({
    id: briefId, workspaceId, body, status: 'active', createdAt: now(),
  }).run();

  // Register the brief's execution mode before any phase awaits a release.
  taskGate.registerBrief(briefId, args.mode ?? 'auto');

  const userChunk: UserChunk = { ...base(workspaceId), kind: 'user', text: body };
  appendEvent(workspaceId, userChunk);

  // Surface the budget intent so the live narrator + UI can show it.
  if (args.budget && args.budget.amount > 0) {
    const label = args.budget.mode === 'tokens'
      ? `${(args.budget.amount / 1000).toFixed(0)}k tokens`
      : `$${args.budget.amount.toFixed(2)}`;
    const budgetNote: SystemChunk = {
      ...base(workspaceId), kind: 'system',
      text: `budget hint: ${label} (${args.budget.mode})`,
    };
    appendEvent(workspaceId, budgetNote);
  }

  // Cwd resolution. Code MUST land outside the workspace's .atrune storage:
  //   1. Per-brief override (rarely used; kept for API back-compat)
  //   2. Workspace's configured targetFolder (the project's repo root)
  //   3. Global sandbox dir under ~/.guideai/sandbox/<id>/ — never inside any .atrune
  const cwd = args.targetFolder?.trim()
    || readWorkspaceTargetFolder(workspaceId)
    || path.join(paths.home, 'sandbox', workspaceId);

  // Build the dispatch plan: each phase → specialist (or CoS fallback).
  const rosterRows = db.select().from(schema.agents).all()
    .filter((a) => a.workspaceId === workspaceId && a.status !== 'retired');
  const roster: RoutableAgent[] = rosterRows.map((a) => ({
    id: a.id, role: a.role, displayName: a.displayName,
    systemPrompt: a.systemPrompt,
    toolWhitelist: safeArray(a.toolWhitelist),
    model: a.model,
  }));
  const cosLite: RoutableAgent = {
    id: agentId, role: 'chief-of-staff', displayName: 'Chief of Staff',
  };
  const route = routeRoster({ brief: body, roster, cos: cosLite, phases: PHASE_ORDER });

  // Surface the route plan in the feed as a single system note for visibility.
  const planLine = PHASE_ORDER.map((p) => {
    const d = route[p]!;
    return d.fallback ? `${p}→CoS` : `${p}→${d.agent.displayName}`;
  }).join(' · ');
  appendEvent(workspaceId, {
    ...base(workspaceId, agentId),
    kind: 'system', level: 'info',
    text: `routing plan: ${planLine}`,
  } as SystemChunk);

  // Fire-and-forget the pipeline. Any failure is surfaced in the event stream
  // via runPipeline()'s internal error chunk; we also log it here for the
  // server console.
  void (async () => {
    try {
      const pipelineResult = await runPipeline({
        workspaceId, agentId, briefId, brief: body, cwd, securityTagged,
        designTagged: isDesignTagged(body), route,
      });

      for (const r of pipelineResult.phaseResults) {
        db.insert(schema.tasks).values({
          id: `${briefId}-${r.phase}`,
          briefId,
          // Attribute the task row to whoever actually ran this phase.
          agentId: r.workerAgentId,
          phase: r.phase,
          status: 'completed',
          artifactPath: r.artifactPath,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        }).run();
      }

      db.update(schema.briefs).set({ status: 'done' })
        .where(eq(schema.briefs.id, briefId)).run();

      // Project context — write per-role analyses for this brief + append
      // a one-line entry to each participating role's rolling summary.
      // Both are derived from the just-inserted `tasks` rows + on-disk
      // artifacts; no LLM call.
      try {
        writeBriefAnalyses(workspaceId, briefId);
        // Persist the chat transcript so clicking a task in VS Code opens
        // the saved session as a markdown file.
        await writeBriefChat(workspaceId, briefId);

        // Per-role rollups for the summary log.
        const ownAgents = db.select().from(schema.agents).all();
        const idToRole = new Map(ownAgents.map((a) => [a.id, a.role]));
        const tasksForBrief = db.select().from(schema.tasks).all()
          .filter((t) => t.briefId === briefId);
        const rollups = new Map<string, { tokensIn: number; tokensOut: number; done: number; failed: number }>();
        for (const t of tasksForBrief) {
          if (!t.agentId) continue;
          const role = idToRole.get(t.agentId);
          if (!role) continue;
          const r = rollups.get(role) ?? { tokensIn: 0, tokensOut: 0, done: 0, failed: 0 };
          r.tokensIn += t.tokensIn ?? 0;
          r.tokensOut += t.tokensOut ?? 0;
          if (t.status === 'failed') r.failed++;
          else r.done++;
          rollups.set(role, r);
        }
        const briefTitle = body.split('\n')[0]?.slice(0, 120) ?? briefId;
        for (const [role, r] of rollups) {
          appendAgentSummary({
            workspaceId, role, briefId, briefTitle,
            tokensIn: r.tokensIn, tokensOut: r.tokensOut,
            tasksDone: r.done, tasksFailed: r.failed,
          });
        }
      } catch (err: any) {
        appendEvent(workspaceId, {
          ...base(workspaceId, agentId),
          kind: 'system', level: 'warn',
          text: `project-context update skipped: ${err?.message ?? err}`,
        } as SystemChunk);
      }

      // ECC Principle 6/7: Stop-hook → promote a draft skill from the trace.
      try {
        const artifactsByPhase: Record<string, string> = {};
        for (const r of pipelineResult.phaseResults) artifactsByPhase[r.phase] = r.text;
        const promoted = promoteSkillFromTrace({ briefBody: body, artifacts: artifactsByPhase });
        const skillId = `skill-${randomUUID().slice(0, 8)}`;
        db.insert(schema.skills).values({
          id: skillId, name: promoted.name, body: '', sourceTaskId: briefId,
          uses: 0, createdAt: now(),
        }).run();
        const promoteNote: SystemChunk = {
          ...base(workspaceId, agentId),
          kind: 'system', level: 'info',
          text: `skill promoted: ${promoted.name} → ${promoted.filePath}`,
        };
        appendEvent(workspaceId, promoteNote);
      } catch (err: any) {
        const warn: SystemChunk = {
          ...base(workspaceId, agentId),
          kind: 'system', level: 'warn',
          text: `skill promotion skipped: ${err?.message ?? err}`,
        };
        appendEvent(workspaceId, warn);
      }

      // Step 8's synthetic Bash chunk was removed in Plan B — real tool calls
      // are now intercepted via the PreToolUse hook at every adapter spawn,
      // routed through /api/permissions/evaluate. Any approvals you see in the
      // feed correspond to actual tool requests the agent tried to make.

      // Phase 6/7 — harvest deliverables (artifacts + slide deck + explainer).
      // Try to find the synthesis from the plan that produced this brief.
      let synthesisForHooks: any = null;
      try {
        const plan = db.select().from(schema.plans).all()
          .find((p) => p.briefId === briefId);
        synthesisForHooks = plan?.editedSynthesisJson
          ? (JSON.parse(plan.editedSynthesisJson) as any) : null;
        await harvestBriefDeliverables({
          workspaceId, briefId, briefBody: body, synthesis: synthesisForHooks,
        });
      } catch (err: any) {
        appendEvent(workspaceId, {
          ...base(workspaceId, agentId),
          kind: 'system', level: 'warn',
          text: `deliverables harvest skipped: ${err?.message ?? err}`,
        } as SystemChunk);
      }

      // Phase 8B — browser-driven validation, if a target_url is configured.
      try {
        const cfg = loadTarget(workspaceId);
        if (cfg.targetUrl) {
          const intake = loadIntake(workspaceId);
          await runValidation({
            workspaceId, briefId, briefBody: body,
            synthesis: synthesisForHooks, intake,
            source: 'auto',
          });
        }
      } catch (err: any) {
        appendEvent(workspaceId, {
          ...base(workspaceId, agentId),
          kind: 'system', level: 'warn',
          text: `auto validation skipped: ${err?.message ?? err}`,
        } as SystemChunk);
      }

      const doneNote: SystemChunk = {
        ...base(workspaceId, agentId),
        kind: 'system', level: 'info',
        text: `brief ${briefId} pipeline complete · ${pipelineResult.totalTokensIn}↓/${pipelineResult.totalTokensOut}↑ tokens · ${pipelineResult.totalDurationMs}ms`,
      };
      appendEvent(workspaceId, doneNote);
    } catch (err: any) {
      const fail: SystemChunk = {
        ...base(workspaceId, agentId),
        kind: 'system', level: 'error',
        text: `pipeline failed for ${briefId}: ${err?.message ?? err}`,
      };
      appendEvent(workspaceId, fail);
      db.update(schema.briefs).set({ status: 'failed' })
        .where(eq(schema.briefs.id, briefId)).run();
    }
  })();

  return {
    briefId,
    agentId,
    phases: PHASE_ORDER as unknown as string[],
    securityTagged,
    pipeline: 'started',
  };
}
