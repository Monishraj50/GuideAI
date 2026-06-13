// ECC Principle 4: model-tier routing. Override per-agent allowed but logged.

import type { Phase } from './caps.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

// CLI accepts short aliases (e.g. `claude --model sonnet`). Aliases are more
// portable than dated IDs across CLI versions and user subscriptions.
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku:  'haiku',
  sonnet: 'sonnet',
  opus:   'opus',
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
