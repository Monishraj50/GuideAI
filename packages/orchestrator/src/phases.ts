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
import { markPhaseComplete, type WorkPhase } from './wbs.js';
import { writeTaskTranscript } from './transcriptWriter.js';
import * as taskGate from './taskGate.js';
import { setupCrossVendor, type CrossVendorContext } from './secondOpinion.js';
import { renderMemoryBlock } from './memory.js';
import {
  DESIGN_LENSES, DESIGN_VARIANTS, persistVariant, renderTasteMemory,
} from './designShotgun.js';
import { loadSkills, skillsForPhase, renderSkillsAsContext } from '@guideai/skills';
import { runPassK } from '@guideai/evals';
import type { AIChunk, Chunk, PhaseChunk, SystemChunk } from '@guideai/shared/chunks';
import type { RoutableAgent, RouteDecision } from './routing.js';

export const PHASE_ORDER: Phase[] = ['research', 'plan', 'implement', 'review', 'verify'];

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/** Phase-specific instructions. Each is intentionally short to keep token cost low. */
const PHASE_PROMPT: Record<Phase, string> = {
  research:
    'You are the RESEARCH phase. Read the brief, identify constraints, and produce a 4-bullet research note. Each bullet ≤ 20 words.',
  plan:
    'You are the PLAN phase. You are given the brief and research note. Produce a 3-step plan. Each step ≤ 25 words. Number them.',
  implement:
    'You are the IMPLEMENT phase. You are given the brief, research, and plan. Sketch the implementation as 3-5 bullets. Be concrete; reference files/functions where applicable.',
  review:
    'You are the REVIEW phase. Critically assess the implementation sketch. List ≤ 3 risks and ≤ 2 suggested mitigations.',
  verify:
    'You are the VERIFY phase. Output one paragraph (≤ 60 words) summarising whether the plan looks shippable, citing the review.',
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

  for (const phase of PHASE_ORDER) {
    const decision = route?.[phase];
    const worker: RoutableAgent = decision?.agent ?? defaultAgent;

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
      const evalCfgForGate = securityTagged && phase === 'review'
        ? CAPS.evals.security
        : CAPS.evals[phase as 'implement' | 'review'] ?? { k: 1, requireAgreement: 1 };
      let currentTier = modelToTier(routing.tier as Tier);
      let downgrades = 0;
      while (downgrades < 3) {
        const forecast = forecastPhaseCost({
          tier: currentTier,
          briefLength: brief.length,
          artifactsLength: Object.values(artifacts).reduce((s, t) => s + (t?.length ?? 0), 0),
          k: evalCfgForGate.k,
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

    const skillsContext = renderSkillsAsContext(skillsForPhase(skills, phase));
    // System prompt layering: specialist persona (if any) → phase task → skills.
    const personaBlock = worker.systemPrompt && worker.role !== 'chief-of-staff'
      ? `## Your role\n\nYou are **${worker.displayName}** (${worker.role}).\n\n${worker.systemPrompt.slice(0, 1500)}`
      : '';
    const memoryBlock = renderMemoryBlock({
      role: worker.role, currentWorkspaceId: workspaceId,
    });
    const systemPrompt = [personaBlock, memoryBlock, PHASE_PROMPT[phase], skillsContext].filter(Boolean).join('\n\n');
    const workerTools = worker.toolWhitelist && worker.toolWhitelist.length > 0
      ? worker.toolWhitelist
      : READ_ONLY_TOOLS;

    // pass@k for security-tagged review. Default elsewhere is k=1 which we
    // run as a single direct call (avoids spinning up the runner for nothing).
    // Design-tagged briefs also fan-out implement at k=DESIGN_VARIANTS — the
    // "design-shotgun" variant generation lane.
    const isDesignImplement = !!designTagged && phase === 'implement';
    const evalCfg = isDesignImplement
      ? { k: DESIGN_VARIANTS, requireAgreement: 1 }
      : (securityTagged && phase === 'review' ? CAPS.evals.security : CAPS.evals[phase as 'implement' | 'review'] ?? { k: 1, requireAgreement: 1 });
    const k = evalCfg.k;

    if (k > 1) {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: 'info',
        text: `phase ${phase} running pass@${k} (security-tagged)`,
      });
      // Cross-vendor mix: when enabled, swap one attempt for OpenAI.
      const crossVendor = setupCrossVendor({
        workspaceId, k,
        isSecurityReview: phase === 'review' && !!securityTagged,
      });
      if (crossVendor) {
        appendEvent(workspaceId, {
          id: randomUUID(), ts: Date.now(), workspaceId, agentId,
          kind: 'system', level: 'info',
          text: `second opinion: ${crossVendor.reason}${crossVendor.mock ? ' [mock]' : ''}`,
        });
      }
      const attemptProvider: ('claude' | 'openai')[] = [];
      // For design-shotgun: precompute the taste-memory block once so every
      // variant attempt gets the same context.
      const tasteBlock = isDesignImplement
        ? renderTasteMemory(workspaceId) : '';
      const passK = await runPassK<Chunk[]>({
        k, requireAgreement: evalCfg.requireAgreement,
        attempt: async (i: number) => {
          const useOpenAI = !!crossVendor?.crossVendorIdx.has(i);
          attemptProvider[i] = useOpenAI ? 'openai' : 'claude';
          const adapter = useOpenAI ? crossVendor!.adapter : resolveActiveAdapter();
          // Per-variant lens for design-shotgun. Each variant gets a distinct
          // design persona prepended to the system prompt + a taste-memory block.
          const lens = isDesignImplement
            ? DESIGN_LENSES[i % DESIGN_LENSES.length]!
            : null;
          const variantPrompt = lens
            ? [
                `## Design lens for this variant: **${lens.lens}**\n${lens.instructions}`,
                tasteBlock,
                systemPrompt,
                'Produce ONE coherent variant in your assigned lens. Be opinionated.',
              ].filter(Boolean).join('\n\n')
            : systemPrompt;
          const res = await adapter.runOnce({
            agentId: useOpenAI ? `${worker.id}-openai` : (lens ? `${worker.id}-${lens.lens}` : worker.id),
            workspaceId, cwd, systemPrompt: variantPrompt,
            allowedTools: workerTools, model: routing.tier,
          }, context);
          const text = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n');
          const tIn = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensIn ?? 0), 0);
          const tOut = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensOut ?? 0), 0);
          // Account the cross-vendor call separately so the ledger reflects it.
          if (useOpenAI) {
            recordUsage({
              workspaceId, agentId: `${worker.id}-openai`, briefId,
              phase: `${phase}:openai`,
              model: routing.tier, tokensIn: tIn, tokensOut: tOut,
            });
          }
          // Persist each design variant as its own deliverable so the UI can
          // show them as a gallery + the picker can record taste.
          if (lens && text.trim().length > 0) {
            try {
              persistVariant({
                workspaceId, briefId, lens: lens.lens, body: text, index: i,
              });
            } catch (err: any) {
              appendEvent(workspaceId, {
                id: randomUUID(), ts: Date.now(), workspaceId, agentId,
                kind: 'system', level: 'warn',
                text: `variant ${i + 1} persist skipped: ${err?.message ?? err}`,
              });
            }
          }
          return { text, tokensIn: tIn, tokensOut: tOut, durationMs: res.durationMs, passthrough: res.chunks };
        },
        parallel: true,
      });

      // Forward chunks from ALL attempts so the feed shows everything.
      for (const chunks of passK.passthroughs) for (const c of chunks) appendEvent(workspaceId, c);

      const tokensIn = passK.attempts.reduce((s, a) => s + a.tokensIn, 0);
      const tokensOut = passK.attempts.reduce((s, a) => s + a.tokensOut, 0);
      totalIn += tokensIn; totalOut += tokensOut;
      account(routing.tier, tokensIn, tokensOut, worker.id, phase);

      // Provider-aware verdict breakdown: who passed, who refused.
      const breakdownParts: string[] = [];
      if (crossVendor) {
        const byProv = (prov: 'claude' | 'openai') => {
          const idxs = passK.attempts.map((_, i) => i).filter((i) => attemptProvider[i] === prov);
          if (idxs.length === 0) return null;
          const pass = idxs.filter((i) => passK.attempts[i]?.passed).length;
          return `${prov}: ${pass}/${idxs.length}`;
        };
        const c = byProv('claude'); const o = byProv('openai');
        if (c) breakdownParts.push(c);
        if (o) breakdownParts.push(o);
      }
      const breakdown = breakdownParts.length ? ` · ${breakdownParts.join(' + ')}` : '';
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: passK.verdict === 'pass' ? 'info' : 'warn',
        text: `pass@${k} verdict: ${passK.verdict} · ${passK.passes}/${k} attempts passed (req ${evalCfg.requireAgreement})${breakdown}`,
      });

      const artifact = artifactPath(workspaceId, briefId, phase);
      const attemptsBlock = passK.attempts.map((a, i) => {
        const prov = attemptProvider[i] ?? 'claude';
        return `### attempt ${i + 1} (${a.passed ? 'pass' : 'fail'}) · provider: ${prov} · ${a.tokensIn}↓/${a.tokensOut}↑\n\n${a.text.trim() || '(empty)'}`;
      }).join('\n\n---\n\n');
      const crossVendorLine = crossVendor
        ? `_cross-vendor: ${breakdownParts.join(' + ')}${crossVendor.mock ? ' (mock)' : ''}_\n\n`
        : '';
      const md = `# ${phase} — brief ${briefId}\n\n` +
        `_worker: ${worker.displayName} (${worker.role}) · model: ${routing.tier} · pass@${k} · verdict: ${passK.verdict} (${passK.passes}/${k}) · tokens: ${tokensIn} in / ${tokensOut} out_\n\n` +
        crossVendorLine +
        `## canonical (longest passing)\n\n${passK.canonical.text.trim() || '(empty)'}\n\n---\n\n${attemptsBlock}\n`;
      fs.writeFileSync(artifact, md);

      artifacts[phase] = passK.canonical.text;
      const phaseEndedAt = Date.now();
      phaseResults.push({
        phase, tier: routing.tier, artifactPath: artifact,
        text: passK.canonical.text,
        startedAt: phaseStartedAt,
        endedAt: phaseEndedAt,
        durationMs: phaseEndedAt - phaseStartedAt,
        tokensIn, tokensOut,
        workerAgentId: worker.id, workerRole: worker.role, workerDisplayName: worker.displayName,
        k, passes: passK.passes, verdict: passK.verdict,
      });
      appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'completed', artifact));
      try { markPhaseComplete({ workspaceId, briefId, phase: phase as WorkPhase }); } catch {}
      continue;
    }

    // k=1: original single-call path.
    let result;
    try {
      result = await resolveActiveAdapter().runOnce(
        {
          agentId: worker.id,
          workspaceId,
          cwd,
          systemPrompt,
          allowedTools: workerTools,
          model: routing.tier,
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
      throw err;
    }

    // Forward all chunks the adapter emitted so the live feed shows them.
    for (const c of result.chunks) appendEvent(workspaceId, c);

    // Persist a per-task chat-history transcript so the Team sidebar can
    // surface it via markdown preview. Phase-scoped today (one file per
    // brief × phase × worker role).
    try {
      writeTaskTranscript({
        workspaceId, role: worker.role, taskId: `${briefId}-${phase}`,
        taskTitle: `${phase} — ${worker.displayName}`,
        briefId, systemPrompt,
      }, result.chunks);
    } catch {}

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
