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

  // Principle 1: token ceilings per phase. Exceeding pauses, doesn't continue silently.
  tokens: {
    research:  { tokensIn: 50_000, tokensOut: 8_000 },
    plan:      { tokensIn: 80_000, tokensOut: 12_000 },
    implement: { tokensIn: 150_000, tokensOut: 30_000 },
    review:    { tokensIn: 100_000, tokensOut: 12_000 },
    verify:    { tokensIn: 40_000, tokensOut: 6_000 },
  },

  // Principle 9: pass@k defaults
  evals: {
    implement: { k: 1, requireAgreement: 1 },
    review:    { k: 1, requireAgreement: 1 },
    security:  { k: 3, requireAgreement: 3 },  // pass^3 for security-tagged
  },
} as const;

export type Phase = keyof typeof CAPS.tokens;

export function tokenCeilingFor(phase: Phase) {
  return CAPS.tokens[phase];
}
