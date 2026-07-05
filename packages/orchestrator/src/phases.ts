import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { routeModel } from '@guideai/policies/router';
import { CAPS, type Phase } from '@guideai/policies/caps';
import {
  loadBudget, summarizeUsage, forecastPhaseCost, checkBudget, recordUsage, modelToTier,
  type Tier,
} from '@guideai/policies/budgets';
import { markPhaseComplete, markPhaseFailed, markPhaseStarted, bumpHeartbeatFor, resolveTaskSession, type WorkPhase } from './wbs.js';
import { writeTaskTranscript, makeStreamingAppender } from './transcriptWriter.js';
import { writeOverallPlanMd, writeProjectIndexMd, writeFeatureContextMd } from './projectContext.js';
// S1 strip: diagnoseFailure removed.
import { normalizeSessionJsonl } from './normalizeSessionJsonl.js';
import { getDb as getDbForOverall, schema as schemaForOverall } from '@guideai/shared/db';
import * as taskGate from './taskGate.js';
// secondOpinion / designShotgun / pass@k removed in S0 (Claude-only).
import { renderMemoryBlock } from './memory.js';
import { loadSkills, skillsForPhase, renderSkillsAsContext, pickSkill, renderSkillAsRunbook } from '@guideai/skills';
import type { AIChunk, Chunk, PhaseChunk, SystemChunk } from '@guideai/shared/chunks';
import type { RoutableAgent, RouteDecision } from './routing.js';

// S3: 3-phase pipeline. Research is now the opening beat of Plan; Verify is
// the closing beat of Review. Cuts ~40% wall time vs the old 5-phase run.
export const PHASE_ORDER: Phase[] = ['plan', 'implement', 'review'];

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/** Phase-specific instructions. Each is intentionally short to keep token cost
 *  low. Plan folds in research; Review folds in verify. */
const PHASE_PROMPT: Record<Phase, string> = {
  plan:
    'You are the PLAN phase. Do two things in order:\n' +
    '1. RESEARCH — read the brief, identify constraints, list 4 bullets (each ≤ 20 words) covering context, unknowns, related files, and risks.\n' +
    '2. PLAN — produce a numbered 3-step plan (each step ≤ 25 words) that addresses those constraints.\n' +
    'Output both sections under `## Research` and `## Plan` headings.',
  implement:
    'You are the IMPLEMENT phase. You are given the brief and the plan (which includes the research). Sketch the implementation as 3-5 bullets. Be concrete; reference files/functions where applicable.',
  review:
    'You are the REVIEW phase. Do two things in order:\n' +
    '1. REVIEW — critically assess the implementation sketch: list ≤ 3 risks and ≤ 2 suggested mitigations under `## Review`.\n' +
    '2. VERDICT — under `## Verdict`, output one paragraph (≤ 60 words) summarising whether the plan looks shippable, citing the review.',
};

function briefDir(workspaceId: string, briefId: string) {
  // Phase artifacts (research.md, plan.md, …) are user-readable markdown,
  // so they live in the visible markdown root next to the project, not
  // inside the hidden .atrune/ system folder.
  return path.join(paths.workspaceMdDir(workspaceId), 'briefs', briefId);
}

function ensureBriefDir(workspaceId: string, briefId: string) {
  const d = briefDir(workspaceId, briefId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function artifactPath(workspaceId: string, briefId: string, phase: Phase) {
  return path.join(briefDir(workspaceId, briefId), `${phase}.md`);
}

function makePhaseChunk(workspaceId: string, agentId: string, briefId: string, phase: Phase, status: PhaseChunk['status'], artifact?: string): PhaseChunk {
  return {
    id: randomUUID(),
    ts: Date.now(),
    workspaceId,
    agentId,
    kind: 'phase',
    taskId: briefId,
    phase,
    status,
    ...(artifact ? { artifactPath: artifact } : {}),
  };
}

export interface RunPipelineArgs {
  workspaceId: string;
  /** CoS — owns phase metadata events; also the fallback worker. */
  agentId: string;
  briefId: string;
  brief: string;
  cwd: string;
  /** When true, security-tagged phases (review) run pass@3. */
  securityTagged?: boolean;
  /** When true, the implement phase produces N parallel variants for the user
   *  to pick (gstack-style design-shotgun). */
  designTagged?: boolean;
  /** Per-phase routing: agent that should actually run each phase. If absent
   *  for a phase, the CoS (agentId above) runs it. */
  route?: Record<Phase, RouteDecision>;
}

export interface PhaseResult {
  phase: Phase;
  tier: string;
  artifactPath: string;
  text: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Agent that actually ran the phase (may differ from CoS when dispatched). */
  workerAgentId: string;
  workerRole?: string;
  workerDisplayName?: string;
  k?: number;            // > 1 only when pass@k was run
  passes?: number;
  verdict?: 'pass' | 'fail';
}

export interface PipelineResult {
  briefId: string;
  artifacts: Record<Phase, string>;
  phaseResults: PhaseResult[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
}

/**
 * Run the full ECC sequential pipeline. Each phase consumes prior artifacts as
 * context and writes a markdown file to the brief's artifact directory.
 */
export async function runPipeline(args: RunPipelineArgs): Promise<PipelineResult> {
  const { workspaceId, agentId, briefId, brief, cwd, securityTagged, designTagged, route } = args;
  ensureBriefDir(workspaceId, briefId);

  // Sessions are now keyed per-task by (workspaceId, featureTag, role).
  // We resolve at the top of each phase loop iteration. The brief-row's
  // claudeSessionId stays populated by submitBrief() for legacy callers
  // (Resume Quick Pick) but is NOT the source of truth anymore.
  // Helper: pull the feature tag from any work item of this brief — every
  // auto-seeded item for the same brief shares the same tag.
  const featureTagForBrief: string | null = (() => {
    try {
      const wi = getDbForOverall().select().from(schemaForOverall.workItems).all()
        .find((r) => r.briefId === briefId && (r as any).featureTag);
      return ((wi as any)?.featureTag ?? null) as string | null;
    } catch { return null; }
  })();

  // Phase C — defer-dispatch flow. If the brief was registered with
  // mode='pending', this awaits until the user clicks "Start Implementing"
  // (which calls taskGate.start(briefId, 'auto' | 'manual')). 'auto' and
  // 'manual' modes short-circuit awaitRelease immediately.
  if (taskGate.modeOf(briefId) === 'pending') {
    appendEvent(workspaceId, {
      id: randomUUID(), ts: Date.now(), workspaceId, agentId,
      kind: 'system', level: 'info',
      text: `pending dispatch: brief ${briefId} awaiting Start Implementing`,
    });
  }
  await taskGate.awaitRelease(briefId, taskGate.START_GATE);

  const skills = loadSkills();
  if (skills.length > 0) {
    appendEvent(workspaceId, {
      id: randomUUID(),
      ts: Date.now(),
      workspaceId,
      agentId,
      kind: 'system',
      level: 'info',
      text: `skills loaded: ${skills.length} (${skills.map((s) => s.name).join(', ')})`,
    });
  }
  const artifacts: Partial<Record<Phase, string>> = {};
  const phaseResults: PhaseResult[] = [];
  let totalIn = 0;
  let totalOut = 0;
  const startedAt = Date.now();

  // Default route: every phase runs as CoS.
  const defaultAgent: RoutableAgent = {
    id: agentId, role: 'chief-of-staff', displayName: 'Chief of Staff',
  };

  let previousWorker: RoutableAgent | null = null;
  const budgetCfg = loadBudget(workspaceId);

  // Helper to record token usage after each phase call. Centralised so pass@k
  // and single-call paths share the same accounting.
  const account = (model: string, tIn: number, tOut: number, workerId: string, phase: string) => {
    recordUsage({
      workspaceId, agentId: workerId, briefId, phase,
      model, tokensIn: tIn, tokensOut: tOut,
    });
  };

  // Liveness heartbeat — bumps last_heartbeat_at on every in_progress
  // work item for this brief every ~10s, so the stuck-task sweeper can tell
  // the pipeline is actually alive. Cleared in the `finally` block below.
  const heartbeat = setInterval(() => {
    try { bumpHeartbeatFor({ workspaceId, briefId }); } catch {}
  }, 10_000);
  // Bump once immediately so newly-released items don't look stale.
  try { bumpHeartbeatFor({ workspaceId, briefId }); } catch {}

  try {
  for (const phase of PHASE_ORDER) {
    // Resume support — if a previous run already finished this phase (the
    // canonical artifact is on disk), skip it. Lets the user kick off
    // POST /api/briefs/:briefId/resume after a crash without redoing work.
    const expectedArtifact = artifactPath(workspaceId, briefId, phase);
    if (fs.existsSync(expectedArtifact)) {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: 'info',
        text: `resume: skipping phase ${phase} (artifact already on disk)`,
      });
      // Make sure WBS reflects this even on resume.
      try { markPhaseComplete({ workspaceId, briefId, phase: phase as WorkPhase }); } catch {}
      continue;
    }
    const decision = route?.[phase];
    const worker: RoutableAgent = decision?.agent ?? defaultAgent;
    // Per-phase session resolution moved BELOW markPhaseStarted — see the
    // declaration just before runOnce — so the work_items are guaranteed
    // seeded by then (autoSeedFromPlan races against runPipeline).
    let claudePhaseSessionId: string | null = null;

    // Handoff note: phase N → phase N+1 with a worker change → surface as
    // a routing-channel note so #channels shows real "who passed what".
    if (previousWorker && previousWorker.id !== worker.id) {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: 'info',
        text: `handoff: ${previousWorker.displayName} → ${worker.displayName} (${phase})`,
      });
    }
    previousWorker = worker;
    let routing = routeModel({ phase, override: (worker.model as any) ?? undefined });

    // Budget + rate-limit gate. May downgrade the model tier, warn, or pause.
    {
      // S0: k is always 1 (no pass@k fan-out). Budget gate forecasts a
      // single-call phase. Tier sizing in S1 will replace this entirely.
      let currentTier = modelToTier(routing.tier as Tier);
      let downgrades = 0;
      while (downgrades < 3) {
        const forecast = forecastPhaseCost({
          tier: currentTier,
          briefLength: brief.length,
          artifactsLength: Object.values(artifacts).reduce((s, t) => s + (t?.length ?? 0), 0),
          k: 1,
        });
        const usage = summarizeUsage(workspaceId, budgetCfg);
        const outcome = checkBudget({ cfg: budgetCfg, usage, forecast, tier: currentTier });
        if (outcome.action === 'ok') break;
        if (outcome.action === 'warn') {
          appendEvent(workspaceId, {
            id: randomUUID(), ts: Date.now(), workspaceId, agentId,
            kind: 'system', level: 'warn',
            text: `budget warn (${phase}): ${outcome.reason}`,
          });
          break;
        }
        if (outcome.action === 'downgrade') {
          appendEvent(workspaceId, {
            id: randomUUID(), ts: Date.now(), workspaceId, agentId,
            kind: 'system', level: 'warn',
            text: `budget downgrade (${phase}): ${outcome.from} → ${outcome.to} · ${outcome.reason}`,
          });
          currentTier = outcome.to;
          routing = { ...routing, tier: outcome.to } as typeof routing;
          downgrades++;
          continue;
        }
        // pause: stop the pipeline with a clear error.
        appendEvent(workspaceId, {
          id: randomUUID(), ts: Date.now(), workspaceId, agentId,
          kind: 'system', level: 'error',
          text: `budget pause (${phase}): ${outcome.reason} · resume at ${new Date(outcome.resumeAt).toLocaleTimeString()}`,
        });
        appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'paused'));
        throw new Error(`budget pause: ${outcome.reason}`);
      }
    }
    // Manual-mode gate: block until the user drags this phase to Active in
    // the Kanban. In Auto mode this resolves immediately.
    if (taskGate.modeOf(briefId) === 'manual') {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: 'info',
        text: `manual mode: awaiting release for phase ${phase}…`,
      });
    }
    await taskGate.awaitRelease(briefId, phase);

    const phaseStartedAt = Date.now();

    // Flip every work_item of this phase to in_progress so the Kanban
    // shows the active column populated while the agent runs. Without
    // this, items go straight Inactive → Done on phase completion.
    try { markPhaseStarted({ workspaceId, briefId, phase: phase as WorkPhase }); } catch {}

    // Per-phase session resolution. We do this AFTER markPhaseStarted so
    // by now autoSeedFromPlan has populated the work_items table — the
    // resolver stamps a (featureTag, role) session UUID on every row.
    // Keyed across the workspace so the same (feature, role) reuses the
    // same Claude conversation across briefs.
    const phaseWorkItems = getDbForOverall().select().from(schemaForOverall.workItems).all()
      .filter((r) => r.briefId === briefId && r.phase === phase);
    for (const wi of phaseWorkItems) {
      const sid = resolveTaskSession({
        workspaceId,
        featureTag: ((wi as any).featureTag as string | null) ?? featureTagForBrief,
        role: wi.assignedRole ?? worker.role,
        taskId: wi.id,
      });
      if (!claudePhaseSessionId) claudePhaseSessionId = sid;
    }
    if (!claudePhaseSessionId) {
      claudePhaseSessionId = resolveTaskSession({
        workspaceId,
        featureTag: featureTagForBrief,
        role: worker.role,
        taskId: `${briefId}-${phase}-virtual`,
      });
    }

    // Phase metadata chunk is owned by CoS (the conductor).
    appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'started'));

    // Surface the dispatch decision so the feed shows who's working.
    if (decision && !decision.fallback) {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: 'info',
        text: `dispatch: ${phase} → ${worker.displayName} (${worker.role}) · ${decision.reason}`,
      });
    }

    const context = [
      '## Brief',
      brief,
      ...Object.entries(artifacts).map(([p, body]) => `## ${p.toUpperCase()} artifact\n${body}`),
    ].join('\n\n');

    // S5 — skill-first executor. Try to pick ONE skill for this (task, phase);
    // if we get a hit, its runbook becomes the primary instruction. If nothing
    // scores, fall back to the phase prompt + the full skill menu (legacy S0).
    const picked = pickSkill({ taskText: brief, phase, skills: skillsForPhase(skills, phase) });
    if (picked) {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId: worker.id,
        kind: 'system', level: 'info',
        text: `Selected skill: ${picked.skill.name} (${picked.skill.source}) · score ${picked.score} · matched ${picked.matched.join(', ') || '—'}`,
      });
    }
    const skillBlock = picked
      ? renderSkillAsRunbook(picked.skill, brief)
      : renderSkillsAsContext(skillsForPhase(skills, phase));
    // System prompt layering: specialist persona (if any) → phase task → skill.
    const personaBlock = worker.systemPrompt && worker.role !== 'chief-of-staff'
      ? `## Your role\n\nYou are **${worker.displayName}** (${worker.role}).\n\n${worker.systemPrompt.slice(0, 1500)}`
      : '';
    const memoryBlock = renderMemoryBlock({
      role: worker.role, currentWorkspaceId: workspaceId,
    });
    const systemPrompt = [personaBlock, memoryBlock, PHASE_PROMPT[phase], skillBlock].filter(Boolean).join('\n\n');
    const workerTools = worker.toolWhitelist && worker.toolWhitelist.length > 0
      ? worker.toolWhitelist
      : READ_ONLY_TOOLS;

    // S0 cleanup: pass@k, cross-vendor second-opinion and design-shotgun
    // variant fan-out are gone. Every phase runs as a single direct call.
    // Tier-aware sizing replaces this in S1 (tiny/small/medium/big).
    let result;
    // Stream chunks directly to the transcript file as they arrive — so VS
    // Code's markdown preview shows the live "Claude chat" view (turns +
    // tool calls + file edits) the moment the agent emits them.
    const streamer = makeStreamingAppender({
      workspaceId, role: worker.role, taskId: `${briefId}-${phase}`,
      taskTitle: `${phase} — ${worker.displayName}`,
      briefId, systemPrompt,
    });
    try {
      result = await resolveActiveAdapter().runOnce(
        {
          agentId: worker.id,
          workspaceId,
          cwd,
          systemPrompt,
          allowedTools: workerTools,
          model: routing.tier,
          onChunk: (c) => streamer.append(c),
          ...(claudePhaseSessionId ? { sessionId: claudePhaseSessionId } : {}),
        },
        context,
      );
    } catch (err: any) {
      const note: SystemChunk = {
        id: randomUUID(),
        ts: Date.now(),
        workspaceId,
        agentId: worker.id,
        kind: 'system',
        level: 'error',
        text: `phase ${phase} failed to start: ${err?.message ?? err}`,
      };
      appendEvent(workspaceId, note);
      appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'failed'));
      // Cascade per-task: every work-item in this phase moves to 'blocked'
      // so the Task Kanban shows them in the Failed column.
      try { markPhaseFailed({ workspaceId, briefId, phase: phase as WorkPhase }); } catch {}
      // Fixer agent — explains why it broke + suggests a one-line fix. Runs
      // in the same Claude session so the diagnosis appears as the next
      // turn in the live chat tail. Surfaces on blocked work_items as a
      // Retry tooltip in the Kanban.
      // Failure diagnosis removed in S1.
      throw err;
    }

    // Forward all chunks the adapter emitted so the live feed shows them.
    for (const c of result.chunks) appendEvent(workspaceId, c);

    // Transcript already streamed live via `streamer.append` above. Just
    // finalize (no-op today; reserved for future "task complete" footer).
    try { streamer.finalize(); } catch {}

    // Normalize the session jsonl so it shows up in Claude's interactive
    // `--resume` picker. SDK-spawned sessions open with a `queue-operation`
    // record which the picker filters out; we prepend the two-line `mode`
    // header that interactive sessions emit. Cheap idempotent op.
    if (claudePhaseSessionId) {
      try { normalizeSessionJsonl({ cwd, sessionId: claudePhaseSessionId }); } catch {}
    }

    const aiText = result.chunks
      .filter((c): c is AIChunk => c.kind === 'ai')
      .map((c) => c.text)
      .join('\n');
    const tokensIn = result.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((a, c) => a + (c.tokensIn ?? 0), 0);
    const tokensOut = result.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((a, c) => a + (c.tokensOut ?? 0), 0);
    totalIn += tokensIn; totalOut += tokensOut;
    account(routing.tier, tokensIn, tokensOut, worker.id, phase);

    const artifact = artifactPath(workspaceId, briefId, phase);
    const md = `# ${phase} — brief ${briefId}\n\n` +
      `_worker: ${worker.displayName} (${worker.role}) · model: ${routing.tier} · tokens: ${tokensIn} in / ${tokensOut} out_\n\n` +
      `${aiText.trim() || '(no output)'}\n`;
    fs.writeFileSync(artifact, md);

    artifacts[phase] = aiText;
    const phaseEndedAt = Date.now();
    phaseResults.push({
      phase,
      tier: routing.tier,
      artifactPath: artifact,
      text: aiText,
      startedAt: phaseStartedAt,
      endedAt: phaseEndedAt,
      durationMs: phaseEndedAt - phaseStartedAt,
      tokensIn,
      tokensOut,
      workerAgentId: worker.id,
      workerRole: worker.role,
      workerDisplayName: worker.displayName,
    });

    appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'completed', artifact));
    try { markPhaseComplete({ workspaceId, briefId, phase: phase as WorkPhase }); } catch {}
    // Refresh overallplan.md after each phase completion. The user has it
    // open as a markdown preview from Active Work and sees the live tasks /
    // status updates as the pipeline marches.
    try { refreshOverallPlan(workspaceId, briefId, brief); } catch {}
    // Refresh PROJECT.md + per-feature .md so the per-(feature, role)
    // session UUIDs reflect the just-resolved session for this phase.
    try { writeProjectIndexMd(workspaceId); } catch {}
    if (featureTagForBrief) {
      try { writeFeatureContextMd(workspaceId, featureTagForBrief); } catch {}
    }
  }
  } finally {
    clearInterval(heartbeat);
  }

  return {
    briefId,
    artifacts: artifacts as Record<Phase, string>,
    phaseResults,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
    totalDurationMs: Date.now() - startedAt,
  };
}

/** Re-render <mdRoot>/briefs/<id>/overallplan.md using the current DB state.
 *  Called after each phase completes so the file the user has open in the
 *  preview reflects the latest task statuses. */
function refreshOverallPlan(workspaceId: string, briefId: string, body: string): void {
  const db = getDbForOverall();
  const items = db.select().from(schemaForOverall.workItems).all()
    .filter((w) => w.briefId === briefId);
  writeOverallPlanMd({
    workspaceId, briefId, body,
    workItems: items.map((w) => ({
      id: w.id,
      title: w.title,
      description: w.description,
      assignedRole: w.assignedRole,
      phase: w.phase,
      status: w.status,
      parentId: w.parentId,
    })),
  });
}
