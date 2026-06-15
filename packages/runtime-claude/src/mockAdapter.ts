import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type {
  AgentHandle, RunOnceResult, RuntimeAdapter, SpawnOpts,
} from '@guideai/runtime-core';
import type { AIChunk, Chunk, SystemChunk } from '@guideai/shared/chunks';

const SAMPLE_RESPONSES: Record<string, string[]> = {
  research: [
    'Constraints: small team, limited budget, ship by end of week.\nKey risks: scope creep, third-party API rate limits.\nUnknowns: production traffic pattern, peak concurrency.\nLeverage: existing CLI tooling, prior team experience.',
  ],
  plan: [
    '1. Scope the smallest viable slice — single endpoint, single happy path.\n2. Mock the external dependency before integrating.\n3. Wire metrics and a feature flag before ship.',
  ],
  implement: [
    '- Add `/health` endpoint returning `{ok: true}` in <10ms.\n- Touch `src/server/index.ts` and `src/routes/health.ts`.\n- Cover with one integration test in `tests/health.test.ts`.\n- Behind feature flag `health_endpoint_v1`.\n- Wire to existing Prometheus exporter.',
  ],
  review: [
    'Risks: 1) endpoint exposes process uptime which can fingerprint deploys; 2) flag default is `true` — should default off until rollout; 3) no rate-limit on probe.\nMitigations: scrub uptime from response; flip default to false.',
  ],
  verify: [
    'Looks shippable for staging behind the flag. Default-off mitigation addresses the review risks. Prod rollout should start at 5% traffic and watch error rate for 24h.',
  ],
  default: [
    'Acknowledged. Producing a short, structured answer based on the brief.\nNext steps: 1) gather context, 2) propose a minimal plan, 3) confirm with you before any tool calls.',
  ],
};

const PANEL_RESPONSES: Record<string, string> = {
  'product-strategist':
    'VALUE: Helps users ship faster by automating the boring middle steps.\n' +
    'SCOPE: Single-tenant happy-path: one project, one brief, one shipped artifact.\n' +
    'WIN: First brief reaches "done" with zero manual edits.\n' +
    'BENEFITS: faster cycle time, less context-switching, lower coordination cost, transparent audit trail',
  'tech-lead':
    'STACK: TypeScript + Fastify backend + Next.js UI + SQLite for local state.\n' +
    'ROLES: backend-developer, frontend-developer, qa-engineer, devops-engineer\n' +
    'RISKS: cli-process supervision drift, token-cost overshoot on long briefs, sse back-pressure\n' +
    'EFFORT: ~6-8 dev-days for the MVP slice',
  'finance-analyst':
    'BALLPARK_USD: 18.50\n' +
    'TOKEN_HEAVY_PHASES: implement, review\n' +
    'CUTS: drop pass@k on review until a real incident justifies it\n' +
    'VERDICT: within-budget',
  'ux-researcher':
    'AUDIENCE: solo founders and small-team leads supervising AI workers.\n' +
    'JOURNEY: brief submission → live feed → first approval → first shipped artifact.\n' +
    'METRICS: time-to-first-output, approvals per brief, brief-to-ship completion rate\n' +
    'PITFALLS: opaque agent reasoning, unclear approval prompts, no resume after pause',
  'risk-officer':
    'TOP_RISK: silent budget overrun if rate-limit window is mis-estimated.\n' +
    'OTHER_RISKS: leaked api keys via env, untrusted tool calls bypass policy, partial pipeline crash\n' +
    'MITIGATIONS: hard-cap forecast, per-tool whitelist, append-only event log\n' +
    'SECURITY_TAG: recommended',
};

const EXPLAINER_FIXTURE = `## What we built
A workspace where you brief AI agents like teammates and they ship work end-to-end. Every step — research, plan, code, review, verify — is visible in a live feed with cost and token meters.

## How it works
- Briefs flow through five gated phases routed to the cheapest model that fits the task.
- A budget governor halts the run if rate-limit or dollar caps would be crossed.
- Work items track real progress per phase; the dashboard shows burndown live.
- A discovery round-table sizes the work before any code gets written.

## Why these choices
- Sequential phases beat parallel anarchy — every gate writes a structured artifact you can replay.
- Cheap models do scaffolding, expensive ones do review; saves >50% on token spend without losing quality.

## What's next
The pipeline runs to "verify" but doesn't push to GitHub or ship to a runtime yet. The next phase wires real-PR integration so the human boss reviews a diff, not just a markdown file.`;

const CRITIQUE_RESPONSES: Record<string, string> = {
  ceo:
    'VERDICT: needs-revision\n' +
    'CONCERNS: scope drift toward "everything-app", ROI on devops slice unclear at this stage, success-metrics phrased as features not outcomes\n' +
    'EDITS: successMetrics=rephrase as outcomes the user can name (e.g. "time-to-first-output < 5 min"), recommendedRoles=defer devops-engineer until v2\n' +
    'RATIONALE: shippable but the business case needs sharpening before we burn the budget.',
  eng:
    'VERDICT: pass\n' +
    'CONCERNS: token cost on long briefs may exceed forecast, retry semantics for failed phases unspecified\n' +
    'EDITS: riskFlags=add "no retry policy for transient phase failures"\n' +
    'RATIONALE: stack + roles are sensible; risks are surfaced but mitigations are light.',
};

function pickResponse(systemPrompt: string | undefined, prompt: string): string {
  const haystack = `${systemPrompt ?? ''}\n${prompt}`.toLowerCase();
  if (haystack.includes('[explainer]') || haystack.includes("guideai's explainer")) return EXPLAINER_FIXTURE;
  const critique = haystack.match(/\[critique:(ceo|eng)\]/);
  if (critique?.[1] && CRITIQUE_RESPONSES[critique[1]]) return CRITIQUE_RESPONSES[critique[1]]!;
  const panel = haystack.match(/\[panel:([a-z0-9-]+)\]/);
  if (panel?.[1] && PANEL_RESPONSES[panel[1]]) return PANEL_RESPONSES[panel[1]]!;
  if (haystack.includes('research phase'))  return SAMPLE_RESPONSES.research![0]!;
  if (haystack.includes('plan phase'))      return SAMPLE_RESPONSES.plan![0]!;
  if (haystack.includes('implement phase')) return SAMPLE_RESPONSES.implement![0]!;
  if (haystack.includes('review phase'))    return SAMPLE_RESPONSES.review![0]!;
  if (haystack.includes('verify phase'))    return SAMPLE_RESPONSES.verify![0]!;
  return SAMPLE_RESPONSES.default![0]!;
}

function now() { return Date.now(); }

function ensureCwd(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
}

function makeAIChunk(opts: SpawnOpts, text: string, model: string): AIChunk {
  return {
    id: randomUUID(), ts: now(), workspaceId: opts.workspaceId, agentId: opts.agentId,
    kind: 'ai', text,
    tokensIn: Math.max(8, Math.round(text.length / 6)),
    tokensOut: Math.max(2, Math.round(text.length / 4)),
    model,
  };
}

function makeSystem(opts: SpawnOpts, text: string, level: 'info' | 'warn' | 'error' = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: now(), workspaceId: opts.workspaceId, agentId: opts.agentId,
    kind: 'system', text, level,
  };
}

/**
 * Mock adapter for Guest mode. Generates deterministic, plausible-looking
 * chunks without calling Claude. Lets a user browse the UI, submit briefs,
 * see phase pipelines run, and explore replays — without an Anthropic account.
 */
export const MockAdapter: RuntimeAdapter = {
  id: 'claude',
  displayName: 'Guest (Mock)',
  availability: 'ready',
  description: 'Deterministic local mock — no Claude calls.',
  endpoint: 'mock://local',
  capabilities: {
    streaming: false, interactive: false,
    tools: ['Read', 'Glob', 'Grep'],
    models: ['mock-tiny'],
  },

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    ensureCwd(opts.cwd);
    const listeners = new Set<(c: Chunk) => void>();
    let killed = false;
    const exitPromise = new Promise<number>((resolve) => {
      const tick = () => { if (killed) resolve(0); else setTimeout(tick, 100); };
      tick();
    });
    return {
      id: opts.agentId,
      pid: -1,
      async send(text: string) {
        const c = makeAIChunk(opts, pickResponse(opts.systemPrompt, text), opts.model ? `mock-${opts.model}` : 'mock-tiny');
        for (const cb of listeners) cb(c);
      },
      onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      waitForExit() { return exitPromise; },
      async kill() { killed = true; },
    };
  },

  async runOnce(opts: SpawnOpts, prompt: string): Promise<RunOnceResult> {
    ensureCwd(opts.cwd);
    const start = now();
    const text = pickResponse(opts.systemPrompt, prompt);
    const model = opts.model ? `mock-${opts.model}` : 'mock-tiny';
    // Tiny artificial latency so flame graphs aren't all 0ms.
    await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
    const chunks: Chunk[] = [
      makeSystem(opts, '[mock] running in guest mode — no Claude calls'),
      makeAIChunk(opts, text, model),
    ];
    return { exitCode: 0, chunks, durationMs: Date.now() - start };
  },
};
