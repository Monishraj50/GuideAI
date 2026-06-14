// Budget + rate-limit governor.
//
// Phase 0 of the project-lifecycle roadmap. Every brief, every phase, every
// adapter call goes through here so we never silently overspend.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';

export type Tier = 'haiku' | 'sonnet' | 'opus';
export type Behavior = 'warn' | 'downgrade' | 'pause';

// Per-1M token prices (USD). Approximate; user-tunable later.
const PRICE: Record<Tier, { in: number; out: number }> = {
  haiku:  { in: 1.00, out: 5.00 },
  sonnet: { in: 3.00, out: 15.00 },
  opus:   { in: 15.00, out: 75.00 },
};

const DOWNGRADE: Record<Tier, Tier | null> = {
  opus:   'sonnet',
  sonnet: 'haiku',
  haiku:  null,
};

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_DAY_MS    = 24 * 60 * 60 * 1000;
const THIRTY_D_MS   = 30 * ONE_DAY_MS;

const DEFAULTS = {
  dailyUsdCap:     undefined as number | undefined,   // unset = unlimited
  monthlyUsdCap:   undefined as number | undefined,
  tokensPer5hCap:  140_000,                            // Claude Pro typical
  behavior:        'downgrade' as Behavior,
};

export interface BudgetConfig {
  workspaceId: string;
  dailyUsdCap?: number;
  monthlyUsdCap?: number;
  tokensPer5hCap?: number;
  behavior: Behavior;
}

export function modelToTier(model: string | null | undefined): Tier {
  if (!model) return 'sonnet';
  if (/haiku/i.test(model))  return 'haiku';
  if (/opus/i.test(model))   return 'opus';
  return 'sonnet';
}

export function tierCost(tier: Tier, tokensIn: number, tokensOut: number): number {
  const p = PRICE[tier];
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function loadBudget(workspaceId: string): BudgetConfig {
  const db = getDb();
  const row = db.select().from(schema.workspaceBudgets)
    .where(eq(schema.workspaceBudgets.workspaceId, workspaceId)).all()[0];
  if (!row) {
    return { workspaceId, ...DEFAULTS };
  }
  return {
    workspaceId,
    dailyUsdCap:    row.dailyUsdCap   ?? undefined,
    monthlyUsdCap:  row.monthlyUsdCap ?? undefined,
    tokensPer5hCap: row.tokensPer5hCap ?? DEFAULTS.tokensPer5hCap,
    behavior:       (row.behavior as Behavior) ?? DEFAULTS.behavior,
  };
}

export function saveBudget(cfg: BudgetConfig): void {
  const db = getDb();
  const existing = db.select().from(schema.workspaceBudgets)
    .where(eq(schema.workspaceBudgets.workspaceId, cfg.workspaceId)).all()[0];
  const values = {
    workspaceId: cfg.workspaceId,
    dailyUsdCap:    cfg.dailyUsdCap   ?? null,
    monthlyUsdCap:  cfg.monthlyUsdCap ?? null,
    tokensPer5hCap: cfg.tokensPer5hCap ?? null,
    behavior:       cfg.behavior,
    updatedAt:      Date.now(),
  };
  if (existing) {
    db.update(schema.workspaceBudgets).set(values as any)
      .where(eq(schema.workspaceBudgets.workspaceId, cfg.workspaceId)).run();
  } else {
    db.insert(schema.workspaceBudgets).values(values as any).run();
  }
}

export interface UsageEvent {
  workspaceId: string;
  agentId?: string;
  briefId?: string;
  phase?: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** Append a usage row. Computes USD cost from the model tier. */
export function recordUsage(e: UsageEvent): { costUsd: number } {
  const tier = modelToTier(e.model);
  const costUsd = tierCost(tier, e.tokensIn, e.tokensOut);
  const db = getDb();
  db.insert(schema.usageLog).values({
    id: `usage-${randomUUID().slice(0, 8)}`,
    workspaceId: e.workspaceId,
    agentId: e.agentId ?? null,
    briefId: e.briefId ?? null,
    phase: e.phase ?? null,
    model: e.model,
    tokensIn: e.tokensIn,
    tokensOut: e.tokensOut,
    costUsd,
    ts: Date.now(),
  } as any).run();
  return { costUsd };
}

export interface UsageSummary {
  todayUsd: number;
  monthUsd: number;
  tokens5h: number;
  lastTs: number | null;
  /** When the 5h window will next have room (Date.now() if not throttled). */
  windowResetTs: number;
}

export function summarizeUsage(workspaceId: string, cfg?: BudgetConfig): UsageSummary {
  const db = getDb();
  const rows = db.select().from(schema.usageLog).all()
    .filter((r) => r.workspaceId === workspaceId) as Array<{ ts: number; costUsd: number; tokensIn: number; tokensOut: number }>;
  const now = Date.now();
  const dayCut = now - ONE_DAY_MS;
  const monthCut = now - THIRTY_D_MS;
  const winCut = now - FIVE_HOURS_MS;
  let todayUsd = 0, monthUsd = 0, tokens5h = 0;
  let lastTs: number | null = null;
  let oldestInWindow: number | null = null;
  for (const r of rows) {
    if (r.ts >= dayCut)   todayUsd += r.costUsd;
    if (r.ts >= monthCut) monthUsd += r.costUsd;
    if (r.ts >= winCut) {
      tokens5h += (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
      if (oldestInWindow === null || r.ts < oldestInWindow) oldestInWindow = r.ts;
    }
    if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
  }
  const c = cfg ?? loadBudget(workspaceId);
  const windowResetTs = c.tokensPer5hCap && tokens5h >= c.tokensPer5hCap && oldestInWindow !== null
    ? oldestInWindow + FIVE_HOURS_MS
    : now;
  return { todayUsd, monthUsd, tokens5h, lastTs, windowResetTs };
}

/** Heuristic forecast for a single phase's spend. Cheap (no LLM). */
export function forecastPhaseCost(args: {
  tier: Tier;
  briefLength: number;          // chars in the brief body
  artifactsLength?: number;     // chars of prior phase artifacts
  k?: number;                   // pass@k multiplier
}): { tokensIn: number; tokensOut: number; costUsd: number } {
  // ~4 chars per token rule of thumb; phase prompts add a constant overhead.
  const PROMPT_OVERHEAD = 1500;
  const RESPONSE_GUESS = 800;
  const tokensIn  = Math.ceil((args.briefLength + (args.artifactsLength ?? 0)) / 4) + PROMPT_OVERHEAD;
  const tokensOut = RESPONSE_GUESS;
  const k = Math.max(1, args.k ?? 1);
  const costUsd = tierCost(args.tier, tokensIn * k, tokensOut * k);
  return { tokensIn: tokensIn * k, tokensOut: tokensOut * k, costUsd };
}

export type CheckOutcome =
  | { action: 'ok' }
  | { action: 'warn'; reason: string }
  | { action: 'downgrade'; from: Tier; to: Tier; reason: string }
  | { action: 'pause'; resumeAt: number; reason: string };

/** Decide what to do before spending. Pure function over (config, usage, cost forecast). */
export function checkBudget(args: {
  cfg: BudgetConfig;
  usage: UsageSummary;
  forecast: { tokensIn: number; tokensOut: number; costUsd: number };
  tier: Tier;
}): CheckOutcome {
  const { cfg, usage, forecast, tier } = args;

  // Rate-limit window: tokens already used + tokens we'd add must fit.
  // Note: downgrading model tier does NOT reduce token usage (a phase consumes
  // about the same tokens regardless of haiku/sonnet/opus). So for token-cap
  // hits we skip the downgrade ladder entirely — warn or pause only.
  if (cfg.tokensPer5hCap) {
    const projected5h = usage.tokens5h + forecast.tokensIn + forecast.tokensOut;
    if (projected5h > cfg.tokensPer5hCap) {
      const reason = `5h token cap would be exceeded (${projected5h}/${cfg.tokensPer5hCap})`;
      if (cfg.behavior === 'warn') return { action: 'warn', reason };
      return { action: 'pause', resumeAt: usage.windowResetTs, reason };
    }
  }

  // Daily / monthly $ caps.
  if (cfg.dailyUsdCap && (usage.todayUsd + forecast.costUsd) > cfg.dailyUsdCap) {
    const reason = `daily cap would be exceeded ($${(usage.todayUsd + forecast.costUsd).toFixed(2)}/$${cfg.dailyUsdCap.toFixed(2)})`;
    if (cfg.behavior === 'warn')      return { action: 'warn', reason };
    if (cfg.behavior === 'downgrade') {
      const lower = DOWNGRADE[tier];
      if (lower) return { action: 'downgrade', from: tier, to: lower, reason };
    }
    return { action: 'pause', resumeAt: Date.now() + ONE_DAY_MS, reason };
  }
  if (cfg.monthlyUsdCap && (usage.monthUsd + forecast.costUsd) > cfg.monthlyUsdCap) {
    const reason = `monthly cap would be exceeded ($${(usage.monthUsd + forecast.costUsd).toFixed(2)}/$${cfg.monthlyUsdCap.toFixed(2)})`;
    if (cfg.behavior === 'warn')      return { action: 'warn', reason };
    if (cfg.behavior === 'downgrade') {
      const lower = DOWNGRADE[tier];
      if (lower) return { action: 'downgrade', from: tier, to: lower, reason };
    }
    return { action: 'pause', resumeAt: Date.now() + THIRTY_D_MS, reason };
  }

  return { action: 'ok' };
}
