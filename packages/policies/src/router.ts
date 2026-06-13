// ECC Principle 4: model-tier routing. Override per-agent allowed but logged.

import type { Phase } from './caps.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

// Maps Anthropic model IDs as of 2026-01.
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-8',
};

const DEFAULT_TIER: Record<Phase, ModelTier> = {
  research:  'haiku',
  plan:      'sonnet',
  implement: 'sonnet',
  review:    'opus',
  verify:    'haiku',
};

export interface RoutingDecision {
  tier: ModelTier;
  modelId: string;
  reason: string;
  overridden: boolean;
}

export function routeModel(opts: {
  phase: Phase;
  override?: ModelTier;
  securityTagged?: boolean;
}): RoutingDecision {
  if (opts.override) {
    return {
      tier: opts.override,
      modelId: MODEL_IDS[opts.override],
      reason: 'per-agent override',
      overridden: true,
    };
  }
  // Security work always goes to Opus regardless of phase.
  if (opts.securityTagged && opts.phase === 'review') {
    return { tier: 'opus', modelId: MODEL_IDS.opus, reason: 'security-tagged review', overridden: false };
  }
  const tier = DEFAULT_TIER[opts.phase];
  return { tier, modelId: MODEL_IDS[tier], reason: `default for ${opts.phase}`, overridden: false };
}
