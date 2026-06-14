// Per-phase specialist routing.
//
// Given the workspace roster + the brief body, pick the best-matching agent
// for each phase. Falls back to the Chief-of-Staff when no specialist scores.

import type { Phase } from '@guideai/policies/caps';

export interface RoutableAgent {
  id: string;
  role: string;
  displayName: string;
  systemPrompt?: string;
  toolWhitelist?: string[];
  model?: string | null;
}

export interface RouteDecision {
  phase: Phase;
  agent: RoutableAgent;
  score: number;
  /** True when the routed agent IS the CoS (fallback). */
  fallback: boolean;
  /** Short human-readable reason for the audit feed. */
  reason: string;
}

/** Phase → keywords that should appear in a good specialist's role/description. */
const PHASE_KEYWORDS: Record<Phase, string[]> = {
  research:  ['research', 'analyst', 'strategist', 'product', 'pm', 'discovery', 'context'],
  plan:      ['architect', 'designer', 'planner', 'lead', 'principal', 'system-design'],
  implement: ['developer', 'engineer', 'pro', 'expert', 'specialist', 'fullstack', 'backend', 'frontend'],
  review:    ['reviewer', 'review', 'security', 'auditor', 'critic', 'qa'],
  verify:    ['qa', 'tester', 'verify', 'sre', 'reliability'],
};

const STOPWORDS = new Set([
  'a','an','the','and','or','to','of','for','with','in','on','by','as','is','it','be','this','that',
  'we','our','your','their','from','add','make','build','plan','sketch','decide','keep','minimal',
  'should','would','could','want','need','let','any','some','all','one','two','three',
]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
}

function haystackFor(a: RoutableAgent): string {
  return `${a.role} ${a.displayName} ${(a.systemPrompt ?? '').slice(0, 800)}`.toLowerCase();
}

/** Score an agent for a phase. Higher = better match. 0 = no signal. */
export function scoreAgent(agent: RoutableAgent, phase: Phase, briefTokens: string[]): number {
  const hay = haystackFor(agent);
  let s = 0;
  // Phase-keyword hits in the agent's identity → strong signal.
  for (const kw of PHASE_KEYWORDS[phase]) if (hay.includes(kw)) s += 6;
  // Brief-token overlap with agent role/display/prompt → topical match.
  for (const tok of briefTokens) if (tok.length >= 4 && hay.includes(tok)) s += 2;
  // Slight bonus for custom agents — the user picked them for a reason.
  if (agent.role.startsWith('custom-')) s += 1;
  // Penalize CoS so a tie doesn't keep it.
  if (agent.role === 'chief-of-staff') s -= 1;
  return s;
}

export function routeRoster(args: {
  brief: string;
  roster: RoutableAgent[];
  cos: RoutableAgent;
  phases: readonly Phase[];
}): Record<Phase, RouteDecision> {
  const briefToks = tokens(args.brief).slice(0, 40);
  const candidates = args.roster.filter((a) => a.role !== 'chief-of-staff');

  const out: Record<string, RouteDecision> = {};
  for (const phase of args.phases) {
    if (candidates.length === 0) {
      out[phase] = { phase, agent: args.cos, score: 0, fallback: true, reason: 'no specialists hired' };
      continue;
    }
    let best: { agent: RoutableAgent; score: number } | null = null;
    for (const a of candidates) {
      const s = scoreAgent(a, phase, briefToks);
      if (!best || s > best.score) best = { agent: a, score: s };
    }
    if (!best || best.score <= 0) {
      out[phase] = { phase, agent: args.cos, score: 0, fallback: true, reason: 'no specialist scored' };
    } else {
      out[phase] = {
        phase, agent: best.agent, score: best.score, fallback: false,
        reason: `keyword match (${best.score})`,
      };
    }
  }
  return out as Record<Phase, RouteDecision>;
}
