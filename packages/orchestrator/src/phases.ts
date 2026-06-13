import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '@guideai/runtime-claude';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { routeModel } from '@guideai/policies/router';
import { CAPS, type Phase } from '@guideai/policies/caps';
import { loadSkills, skillsForPhase, renderSkillsAsContext } from '@guideai/skills';
import { runPassK } from '@guideai/evals';
import type { AIChunk, Chunk, PhaseChunk, SystemChunk } from '@guideai/shared/chunks';

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
  return path.join(paths.workspaceDir(workspaceId), 'briefs', briefId);
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
  agentId: string;
  briefId: string;
  brief: string;
  cwd: string;
  /** When true, security-tagged phases (review) run pass@3. */
  securityTagged?: boolean;
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
  const { workspaceId, agentId, briefId, brief, cwd, securityTagged } = args;
  ensureBriefDir(workspaceId, briefId);

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

  for (const phase of PHASE_ORDER) {
    const routing = routeModel({ phase });
    const phaseStartedAt = Date.now();
    appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'started'));

    const context = [
      '## Brief',
      brief,
      ...Object.entries(artifacts).map(([p, body]) => `## ${p.toUpperCase()} artifact\n${body}`),
    ].join('\n\n');

    const skillsContext = renderSkillsAsContext(skillsForPhase(skills, phase));
    const systemPrompt = [PHASE_PROMPT[phase], skillsContext].filter(Boolean).join('\n\n');

    // pass@k for security-tagged review. Default elsewhere is k=1 which we
    // run as a single direct call (avoids spinning up the runner for nothing).
    const evalCfg = securityTagged && phase === 'review' ? CAPS.evals.security : CAPS.evals[phase as 'implement' | 'review'] ?? { k: 1, requireAgreement: 1 };
    const k = evalCfg.k;

    if (k > 1) {
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: 'info',
        text: `phase ${phase} running pass@${k} (security-tagged)`,
      });
      const passK = await runPassK<Chunk[]>({
        k, requireAgreement: evalCfg.requireAgreement,
        attempt: async () => {
          const res = await ClaudeAdapter.runOnce({
            agentId, workspaceId, cwd, systemPrompt,
            allowedTools: READ_ONLY_TOOLS, model: routing.tier,
          }, context);
          const text = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n');
          const tIn = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensIn ?? 0), 0);
          const tOut = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensOut ?? 0), 0);
          return { text, tokensIn: tIn, tokensOut: tOut, durationMs: res.durationMs, passthrough: res.chunks };
        },
        parallel: true,
      });

      // Forward chunks from ALL attempts so the feed shows everything.
      for (const chunks of passK.passthroughs) for (const c of chunks) appendEvent(workspaceId, c);

      const tokensIn = passK.attempts.reduce((s, a) => s + a.tokensIn, 0);
      const tokensOut = passK.attempts.reduce((s, a) => s + a.tokensOut, 0);
      totalIn += tokensIn; totalOut += tokensOut;

      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId, agentId,
        kind: 'system', level: passK.verdict === 'pass' ? 'info' : 'warn',
        text: `pass@${k} verdict: ${passK.verdict} · ${passK.passes}/${k} attempts passed (req ${evalCfg.requireAgreement})`,
      });

      const artifact = artifactPath(workspaceId, briefId, phase);
      const attemptsBlock = passK.attempts.map((a, i) =>
        `### attempt ${i + 1} (${a.passed ? 'pass' : 'fail'}) · ${a.tokensIn}↓/${a.tokensOut}↑\n\n${a.text.trim() || '(empty)'}`).join('\n\n---\n\n');
      const md = `# ${phase} — brief ${briefId}\n\n` +
        `_model: ${routing.tier} · pass@${k} · verdict: ${passK.verdict} (${passK.passes}/${k}) · tokens: ${tokensIn} in / ${tokensOut} out_\n\n` +
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
        k, passes: passK.passes, verdict: passK.verdict,
      });
      appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'completed', artifact));
      continue;
    }

    // k=1: original single-call path.
    let result;
    try {
      result = await ClaudeAdapter.runOnce(
        {
          agentId,
          workspaceId,
          cwd,
          systemPrompt,
          allowedTools: READ_ONLY_TOOLS,
          model: routing.tier,
        },
        context,
      );
    } catch (err: any) {
      const note: SystemChunk = {
        id: randomUUID(),
        ts: Date.now(),
        workspaceId,
        agentId,
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

    const aiText = result.chunks
      .filter((c): c is AIChunk => c.kind === 'ai')
      .map((c) => c.text)
      .join('\n');
    const tokensIn = result.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((a, c) => a + (c.tokensIn ?? 0), 0);
    const tokensOut = result.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((a, c) => a + (c.tokensOut ?? 0), 0);
    totalIn += tokensIn; totalOut += tokensOut;

    const artifact = artifactPath(workspaceId, briefId, phase);
    const md = `# ${phase} — brief ${briefId}\n\n` +
      `_model: ${routing.tier} · tokens: ${tokensIn} in / ${tokensOut} out_\n\n` +
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
    });

    appendEvent(workspaceId, makePhaseChunk(workspaceId, agentId, briefId, phase, 'completed', artifact));
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
