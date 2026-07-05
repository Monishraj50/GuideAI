// ECC Principle 1, 2, 5: hard caps. Surface every limit in the UI when hit (Principle 10).

export const CAPS = {
  // Principle 2: ≤10 MCP servers active globally. Per-agent whitelists are stricter.
  mcp: {
    maxActiveServers: 10,
    maxToolsGlobal: 80,
    maxToolsPerAgent: 5,
  },

  // Principle 5: minimum viable concurrency. Default 3, never "unlimited".
  concurrency: {
    maxAgentsPerWorkspace: 3,
    maxParallelInPhase: 5,   // within a single phase only
  },

  // S3: 3-phase pipeline. Research is folded into plan; verify is folded into
  // review. Token ceilings absorb the old sibling phase's budget so we don't
  // starve the merged prompt.
  tokens: {
    plan:      { tokensIn: 130_000, tokensOut: 20_000 }, // was plan(80k/12k) + research(50k/8k)
    implement: { tokensIn: 150_000, tokensOut: 30_000 },
    review:    { tokensIn: 140_000, tokensOut: 18_000 }, // was review(100k/12k) + verify(40k/6k)
  },

  // Principle 9: pass@k defaults
  evals: {
    implement: { k: 1, requireAgreement: 1 },
    review:    { k: 1, requireAgreement: 1 },
    security:  { k: 3, requireAgreement: 3 },  // pass^3 for security-tagged
  },
} as const;

/** Phases the pipeline actually schedules. Narrow set; the DB may still hold
 *  legacy 'research' / 'verify' rows from pre-S3 briefs — those are handled by
 *  {@link LegacyPhase} below. */
export type Phase = keyof typeof CAPS.tokens;

/** Superset that includes historical values still present in DB rows written
 *  before S3. Use this in shapes that read from persistence; use {@link Phase}
 *  for anything the pipeline produces. */
export type LegacyPhase = Phase | 'research' | 'verify';

export function tokenCeilingFor(phase: Phase) {
  return CAPS.tokens[phase];
}
