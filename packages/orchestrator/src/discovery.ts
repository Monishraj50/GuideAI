// Phase 1 — Discovery round-table.
//
// Fixed 5-agent panel runs in parallel over the project intake. Each panelist
// offers their lens (insights, risks, ballpark cost). Results are synthesized
// into a structured recommendation that downstream phases can consume.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { paths } from '@guideai/shared/paths';
import { appendEvent } from '@guideai/messaging/events';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import type { AIChunk, SystemChunk } from '@guideai/shared/chunks';
import {
  loadBudget, summarizeUsage, forecastPhaseCost, checkBudget, recordUsage,
  tierCost, modelToTier, type Tier,
} from '@guideai/policies/budgets';

export type PlanningMode = 'auto' | 'assisted' | 'manual';
export type HireMode = 'auto' | 'manual' | 'hybrid';

export type BudgetUnit = 'USD' | 'EUR' | 'GBP' | 'INR' | 'JPY' | 'tokens';

export interface IntakeRecord {
  workspaceId: string;
  goal: string;
  successCriteria: string[];
  constraints: string[];
  /** Numeric budget hint; interpreted via budgetHintUnit. Legacy DB column name. */
  budgetHintUsd: number | null;
  budgetHintUnit: BudgetUnit;
  planningMode: PlanningMode;
  hireMode: HireMode;
  /** Phase A — once true, goal/successCriteria/constraints/targetFolder are
   *  read-only; the `discoveryContext` free-text section becomes editable. */
  locked: boolean;
  lockedAt: number | null;
  /** Free-text notes injected into the round-table panel prompts. Only
   *  editable while `locked === true`. */
  discoveryContext: string;
}

/** Plans should be conservative — leave headroom for retries, longer-than-expected
 *  briefs, and pass@k runs. Forecast × buffer is what we compare to the user's hint. */
export const BUDGET_BUFFER = 1.3;

/** Approximate FX rates to USD. Hardcoded — currency conversion is best-effort
 *  for sizing the budget, not for billing. Update if exchange rates drift wildly. */
const USD_PER_UNIT: Record<Exclude<BudgetUnit, 'tokens'>, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27,
  INR: 0.012,
  JPY: 0.0067,
};

/** Convert a (amount, unit) hint to an equivalent USD amount.
 *  Returns null for `tokens` (token budgets are checked separately, not in USD). */
export function budgetHintToUsd(amount: number | null | undefined, unit: BudgetUnit): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (unit === 'tokens') return null;
  return amount * USD_PER_UNIT[unit];
}

export interface Panelist {
  role: string;
  displayName: string;
  lens: string;          // brief sentence describing the lens
  systemPrompt: string;  // full persona
  tier: Tier;
}

const PANEL: Panelist[] = [
  {
    role: 'product-strategist',
    displayName: 'Product Strategist',
    lens: 'business value, scope, user benefit',
    tier: 'haiku',
    systemPrompt:
      'You are a Product Strategist. Read the intake and respond with exactly four labelled lines:\n' +
      'VALUE: <one line, the headline benefit to users in plain English>\n' +
      'SCOPE: <one line, the smallest viable slice worth shipping first>\n' +
      'WIN: <one line, a single measurable signal of success>\n' +
      'BENEFITS: <comma-separated 2-4 short benefits>',
  },
  {
    role: 'tech-lead',
    displayName: 'Tech Lead',
    lens: 'architecture, required roles, technical risk',
    tier: 'sonnet',
    systemPrompt:
      'You are a senior Tech Lead. Read the intake and respond with exactly four labelled lines:\n' +
      'STACK: <one line, recommended stack at a high level>\n' +
      'ROLES: <comma-separated role keywords needed, e.g. backend-developer, devops-engineer, qa-engineer>\n' +
      'RISKS: <comma-separated 2-3 short technical risks>\n' +
      'EFFORT: <one line, rough effort estimate in dev-days>',
  },
  {
    role: 'finance-analyst',
    displayName: 'Finance Analyst',
    lens: 'token + dollar cost, schedule fit',
    tier: 'haiku',
    systemPrompt:
      'You are a Finance Analyst for an AI-led team. The user has a budget hint and per-1M token pricing. Respond with exactly four labelled lines:\n' +
      'BALLPARK_USD: <single number — your best USD estimate for the whole build>\n' +
      'TOKEN_HEAVY_PHASES: <comma-separated phases likely to dominate cost>\n' +
      'CUTS: <one line, what to drop if budget is tight>\n' +
      'VERDICT: <one of: within-budget | tight | over-budget>',
  },
  {
    role: 'ux-researcher',
    displayName: 'UX Researcher',
    lens: 'user journey, success metrics',
    tier: 'haiku',
    systemPrompt:
      'You are a UX Researcher. Read the intake and respond with exactly four labelled lines:\n' +
      'AUDIENCE: <one line, primary user persona>\n' +
      'JOURNEY: <one line, the critical user moment to design for>\n' +
      'METRICS: <comma-separated 2-3 short success metrics>\n' +
      'PITFALLS: <comma-separated 2-3 UX pitfalls to avoid>',
  },
  {
    role: 'risk-officer',
    displayName: 'Risk Officer',
    lens: 'security, compliance, operational risk',
    tier: 'sonnet',
    systemPrompt:
      'You are a Risk Officer. Read the intake and respond with exactly four labelled lines:\n' +
      'TOP_RISK: <one line, the single biggest risk>\n' +
      'OTHER_RISKS: <comma-separated 2-4 short risks>\n' +
      'MITIGATIONS: <comma-separated 2-3 short mitigations>\n' +
      'SECURITY_TAG: <one of: required | recommended | not-needed>',
  },
];

export interface PanelEntry {
  role: string;
  displayName: string;
  lens: string;
  tier: Tier;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  failed?: boolean;
  error?: string;
}

export interface DiscoverySynthesis {
  recommendedRoles: string[];
  riskFlags: string[];
  successMetrics: string[];
  costEstimateUsd: number | null;
  costVerdict: 'within-budget' | 'tight' | 'over-budget' | 'unknown';
  securityTag: 'required' | 'recommended' | 'not-needed' | 'unknown';
  benefits: string[];
  summary: string;
}

export interface DiscoveryRecord {
  id: string;
  workspaceId: string;
  status: 'running' | 'done' | 'failed';
  panel: PanelEntry[];
  synthesis: DiscoverySynthesis | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
  /** Phase B — when this discovery was triggered by "Needs changes", the
   *  user's revision note is preserved for the history rail and prepended
   *  to each panelist's prompt as a `## Revision request` block. */
  revisionNote: string | null;
}

// ---------- intake CRUD ----------

export function loadIntake(workspaceId: string): IntakeRecord | null {
  const db = getDb();
  const row = db.select().from(schema.projectIntakes)
    .where(eq(schema.projectIntakes.workspaceId, workspaceId)).all()[0];
  if (!row) return null;
  return {
    workspaceId,
    goal: row.goal ?? '',
    successCriteria: safeArr(row.successCriteria),
    constraints: safeArr(row.constraints),
    budgetHintUsd: row.budgetHintUsd ?? null,
    budgetHintUnit: ((row as any).budgetHintUnit as BudgetUnit) ?? 'USD',
    planningMode: (row.planningMode as PlanningMode) ?? 'assisted',
    hireMode: (row.hireMode as HireMode) ?? 'manual',
    locked: !!((row as any).locked),
    lockedAt: (row as any).lockedAt ?? null,
    discoveryContext: (row as any).discoveryContext ?? '',
  };
}

export function saveIntake(intake: IntakeRecord): void {
  const db = getDb();
  const existing = db.select().from(schema.projectIntakes)
    .where(eq(schema.projectIntakes.workspaceId, intake.workspaceId)).all()[0];
  const now = Date.now();
  const values = {
    workspaceId: intake.workspaceId,
    goal: intake.goal,
    successCriteria: JSON.stringify(intake.successCriteria),
    constraints: JSON.stringify(intake.constraints),
    budgetHintUsd: intake.budgetHintUsd ?? null,
    budgetHintUnit: intake.budgetHintUnit ?? 'USD',
    planningMode: intake.planningMode,
    hireMode: intake.hireMode,
    locked: intake.locked ? 1 : 0,
    lockedAt: intake.lockedAt,
    discoveryContext: intake.discoveryContext ?? '',
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  };
  if (existing) {
    db.update(schema.projectIntakes).set(values as any)
      .where(eq(schema.projectIntakes.workspaceId, intake.workspaceId)).run();
  } else {
    db.insert(schema.projectIntakes).values(values as any).run();
  }
}

// ---------- discovery ----------

export function listDiscoveries(workspaceId: string): DiscoveryRecord[] {
  const db = getDb();
  return db.select().from(schema.discoveries).all()
    .filter((d) => d.workspaceId === workspaceId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(rowToRecord);
}

export function latestDiscovery(workspaceId: string): DiscoveryRecord | null {
  return listDiscoveries(workspaceId)[0] ?? null;
}

function rowToRecord(row: any): DiscoveryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    panel: safeJson<PanelEntry[]>(row.panelJson, []),
    synthesis: row.synthesisJson ? safeJson<DiscoverySynthesis | null>(row.synthesisJson, null) : null,
    tokensIn: row.tokensIn ?? 0,
    tokensOut: row.tokensOut ?? 0,
    costUsd: row.costUsd ?? 0,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    revisionNote: row.revisionNote ?? null,
  };
}

/**
 * Kick off the round-table. Returns the persisted record once all 5 panelists
 * have responded (or failed). Synthesizes a structured recommendation.
 *
 * Budget-aware: forecasts panel cost up front and pauses with an error if the
 * configured budget can't accommodate it.
 */
export async function runDiscovery(args: {
  workspaceId: string;
  intake?: IntakeRecord;        // override; otherwise loaded from disk
  /** Phase B — user-supplied note describing what to change relative to the
   *  previous round-table output. Prepended to each panelist's user prompt
   *  as a "Revision request" block and persisted with the discovery row. */
  revisionNote?: string;
}): Promise<DiscoveryRecord> {
  const { workspaceId } = args;
  const db = getDb();
  const intake = args.intake ?? loadIntake(workspaceId);
  if (!intake || !intake.goal.trim()) {
    throw new Error('intake is empty — set a goal before running discovery');
  }
  const revisionNote = args.revisionNote?.trim() || null;

  const id = `disc-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  db.insert(schema.discoveries).values({
    id, workspaceId, status: 'running', panelJson: '[]',
    tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt,
    revisionNote,
  } as any).run();

  appendEvent(workspaceId, sys(workspaceId,
    revisionNote
      ? `discovery ${id} → 5-agent round-table starting (revision: ${revisionNote.slice(0, 80)}…)`
      : `discovery ${id} → 5-agent round-table starting`,
  ));

  // Budget gate up front. Forecast the sum across all panelists at their tiers.
  {
    const cfg = loadBudget(workspaceId);
    const usage = summarizeUsage(workspaceId, cfg);
    const briefLen = intake.goal.length + JSON.stringify(intake.successCriteria).length + JSON.stringify(intake.constraints).length;
    let totalForecastUsd = 0;
    let totalForecastTokensIn = 0;
    let totalForecastTokensOut = 0;
    for (const p of PANEL) {
      const f = forecastPhaseCost({ tier: p.tier, briefLength: briefLen, artifactsLength: 0, k: 1 });
      totalForecastUsd += f.costUsd;
      totalForecastTokensIn += f.tokensIn;
      totalForecastTokensOut += f.tokensOut;
    }
    // Use the most expensive panelist tier for the cap check (worst-case).
    const worstTier: Tier = PANEL.reduce<Tier>((t, p) => p.tier === 'opus' ? 'opus' : p.tier === 'sonnet' && t !== 'opus' ? 'sonnet' : t, 'haiku');
    const outcome = checkBudget({
      cfg, usage, tier: worstTier,
      forecast: { tokensIn: totalForecastTokensIn, tokensOut: totalForecastTokensOut, costUsd: totalForecastUsd },
    });
    if (outcome.action === 'pause') {
      const msg = `discovery paused before start: ${outcome.reason}`;
      appendEvent(workspaceId, sys(workspaceId, msg, 'error'));
      db.update(schema.discoveries).set({ status: 'failed', endedAt: Date.now() })
        .where(eq(schema.discoveries.id, id)).run();
      throw new Error(msg);
    }
    if (outcome.action === 'warn') {
      appendEvent(workspaceId, sys(workspaceId, `discovery budget warn: ${outcome.reason}`, 'warn'));
    }
  }

  const adapter = resolveActiveAdapter();
  const cwd = paths.agentCwd(workspaceId, `discovery-${id}`);
  // Compose the panelist user prompt. Order matters: revision request first
  // (so the panelist knows this is a re-run with explicit feedback), then
  // the intake block, then any free-text discovery context the user added.
  const sections: string[] = [];
  if (revisionNote) {
    sections.push(
      '## Revision request',
      '',
      'The user reviewed the previous round-table output and asked for changes:',
      '',
      `> ${revisionNote.split('\n').join('\n> ')}`,
      '',
      'Reflect this revision in your analysis. Do not repeat prior framings the user has rejected.',
      '',
    );
  }
  sections.push(renderIntake(intake));
  if (intake.discoveryContext.trim()) {
    sections.push(
      '',
      '## Discovery context (user notes)',
      '',
      intake.discoveryContext.trim(),
    );
  }
  const intakeBlock = sections.join('\n');

  // Run all panelists in parallel — Principle 3B/5B: parallelism *within* a
  // gate is fine, just not across gates. 5 fits in the concurrency cap.
  const panelResults = await Promise.all(PANEL.map(async (p): Promise<PanelEntry> => {
    const start = Date.now();
    try {
      const res = await adapter.runOnce(
        {
          agentId: `panel-${p.role}-${id.slice(-6)}`,
          workspaceId, cwd,
          systemPrompt: `${p.systemPrompt}\n\n[panel:${p.role}]`,
          allowedTools: ['Read', 'Glob', 'Grep'],
          model: p.tier,
        },
        intakeBlock,
      );
      const text = res.chunks
        .filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n').trim();
      const tIn = res.chunks
        .filter((c): c is AIChunk => c.kind === 'ai')
        .reduce((s, c) => s + (c.tokensIn ?? 0), 0);
      const tOut = res.chunks
        .filter((c): c is AIChunk => c.kind === 'ai')
        .reduce((s, c) => s + (c.tokensOut ?? 0), 0);
      const cost = tierCost(modelToTier(p.tier), tIn, tOut);
      recordUsage({
        workspaceId, agentId: `panel-${p.role}-${id.slice(-6)}`,
        phase: 'discovery', model: p.tier, tokensIn: tIn, tokensOut: tOut,
      });
      appendEvent(workspaceId, sys(workspaceId,
        `${p.displayName} weighed in · ${p.lens} · ${tIn}↓/${tOut}↑ tokens · $${cost.toFixed(4)}`));
      return {
        role: p.role, displayName: p.displayName, lens: p.lens, tier: p.tier,
        text, tokensIn: tIn, tokensOut: tOut, costUsd: cost,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      appendEvent(workspaceId, sys(workspaceId, `${p.displayName} failed: ${msg}`, 'warn'));
      return {
        role: p.role, displayName: p.displayName, lens: p.lens, tier: p.tier,
        text: '', tokensIn: 0, tokensOut: 0, costUsd: 0,
        durationMs: Date.now() - start, failed: true, error: msg,
      };
    }
  }));

  const synthesis = synthesize(panelResults, intake);
  const totalIn = panelResults.reduce((s, p) => s + p.tokensIn, 0);
  const totalOut = panelResults.reduce((s, p) => s + p.tokensOut, 0);
  const totalCost = panelResults.reduce((s, p) => s + p.costUsd, 0);
  const endedAt = Date.now();

  db.update(schema.discoveries).set({
    status: 'done',
    panelJson: JSON.stringify(panelResults),
    synthesisJson: JSON.stringify(synthesis),
    tokensIn: totalIn, tokensOut: totalOut, costUsd: totalCost,
    endedAt,
  } as any).where(eq(schema.discoveries.id, id)).run();

  appendEvent(workspaceId, sys(workspaceId,
    `discovery ${id} synthesis: ${synthesis.recommendedRoles.length} roles · $${synthesis.costEstimateUsd?.toFixed(2) ?? '?'} ballpark · ${synthesis.costVerdict}`));

  return {
    id, workspaceId, status: 'done',
    panel: panelResults, synthesis,
    tokensIn: totalIn, tokensOut: totalOut, costUsd: totalCost,
    startedAt, endedAt,
    revisionNote,
  };
}

// ---------- helpers ----------

function renderIntake(i: IntakeRecord): string {
  const lines = [
    '## Project intake',
    '',
    `Goal: ${i.goal.trim()}`,
  ];
  if (i.successCriteria.length) {
    lines.push('', 'Success criteria:');
    for (const c of i.successCriteria) lines.push(`- ${c}`);
  }
  if (i.constraints.length) {
    lines.push('', 'Constraints:');
    for (const c of i.constraints) lines.push(`- ${c}`);
  }
  if (i.budgetHintUsd != null) {
    const unit = i.budgetHintUnit ?? 'USD';
    if (unit === 'tokens') {
      lines.push('', `Budget hint: ${i.budgetHintUsd.toLocaleString()} tokens total (input + output combined).`);
    } else {
      const usd = budgetHintToUsd(i.budgetHintUsd, unit);
      const usdNote = unit === 'USD' ? '' : ` (~$${usd?.toFixed(2)} USD at approximate FX)`;
      lines.push('', `Budget hint: ${i.budgetHintUsd.toLocaleString()} ${unit} total${usdNote}.`);
    }
    lines.push(
      `IMPORTANT: leave a ~${Math.round((BUDGET_BUFFER - 1) * 100)}% buffer for retries, pass@k attempts, and longer-than-expected briefs. ` +
      `If the realistic ballpark cost × buffer exceeds the user's hint, set VERDICT: over-budget and CUTS: explain what to drop.`,
    );
  }
  lines.push('', `Planning mode: ${i.planningMode}`, `Hiring mode: ${i.hireMode}`);
  return lines.join('\n');
}

function safeArr(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId,
    kind: 'system', level, text,
  };
}

// Pull a labelled field out of a panelist's response (case-insensitive).
function field(text: string, label: string): string {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im');
  const m = text.match(re);
  return m?.[1]?.trim() ?? '';
}
function splitList(s: string): string[] {
  return s.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
}

function synthesize(panel: PanelEntry[], intake: IntakeRecord): DiscoverySynthesis {
  const by = (role: string) => panel.find((p) => p.role === role)?.text ?? '';

  const techText    = by('tech-lead');
  const financeText = by('finance-analyst');
  const uxText      = by('ux-researcher');
  const riskText    = by('risk-officer');
  const prodText    = by('product-strategist');

  // Roles: union of tech-lead ROLES + heuristics if missing.
  const rolesRaw = splitList(field(techText, 'ROLES'));
  const fallbackRoles = ['backend-developer', 'frontend-developer', 'qa-engineer'];
  const recommendedRoles = uniq(rolesRaw.length ? rolesRaw : fallbackRoles)
    .map((r) => r.toLowerCase().replace(/\s+/g, '-'));

  // Cost: parse first number on the finance analyst BALLPARK line.
  const ballpark = field(financeText, 'BALLPARK_USD');
  const num = ballpark.match(/-?\d+(?:\.\d+)?/);
  const costEstimateUsd = num ? Number(num[0]) : null;

  // Verdict: prefer the finance analyst's call; fall back to budget hint check.
  // For non-USD currencies we convert via the FX table; for token budgets we
  // skip USD math and trust the finance analyst's verdict (since the analyst
  // sees the token-cost line in the prompt context).
  let costVerdict: DiscoverySynthesis['costVerdict'] = 'unknown';
  const verdict = field(financeText, 'VERDICT').toLowerCase();
  if (verdict.includes('within')) costVerdict = 'within-budget';
  else if (verdict.includes('tight')) costVerdict = 'tight';
  else if (verdict.includes('over')) costVerdict = 'over-budget';
  else if (intake.budgetHintUsd != null && costEstimateUsd != null) {
    const unit = intake.budgetHintUnit ?? 'USD';
    if (unit !== 'tokens') {
      const budgetUsd = budgetHintToUsd(intake.budgetHintUsd, unit) ?? 0;
      // Apply buffer: forecast × BUDGET_BUFFER is what we compare against the cap.
      const buffered = costEstimateUsd * BUDGET_BUFFER;
      if (buffered <= budgetUsd) costVerdict = 'within-budget';
      else if (costEstimateUsd <= budgetUsd) costVerdict = 'tight';
      else costVerdict = 'over-budget';
    }
  }

  // Security tag
  const sec = field(riskText, 'SECURITY_TAG').toLowerCase();
  let securityTag: DiscoverySynthesis['securityTag'] = 'unknown';
  if (sec.includes('required')) securityTag = 'required';
  else if (sec.includes('recommended')) securityTag = 'recommended';
  else if (sec.includes('not')) securityTag = 'not-needed';

  // Risks: top + others + tech risks.
  const top = field(riskText, 'TOP_RISK');
  const otherRisks = splitList(field(riskText, 'OTHER_RISKS'));
  const techRisks  = splitList(field(techText, 'RISKS'));
  const riskFlags = uniq([top, ...otherRisks, ...techRisks].filter(Boolean));

  // Success metrics: UX METRICS + product WIN line.
  const uxMetrics = splitList(field(uxText, 'METRICS'));
  const winLine = field(prodText, 'WIN');
  const successMetrics = uniq([...(winLine ? [winLine] : []), ...uxMetrics, ...intake.successCriteria]);

  // Benefits: product BENEFITS
  const benefits = splitList(field(prodText, 'BENEFITS'));

  const headline = field(prodText, 'VALUE') || intake.goal.slice(0, 120);
  const scope = field(prodText, 'SCOPE');
  const effort = field(techText, 'EFFORT');
  const summary = [
    headline,
    scope && `Scope: ${scope}.`,
    effort && `Effort: ${effort}.`,
    costEstimateUsd != null && `Cost: ~$${costEstimateUsd.toFixed(2)} (${costVerdict}).`,
    recommendedRoles.length && `Hire: ${recommendedRoles.slice(0, 5).join(', ')}.`,
  ].filter(Boolean).join(' ');

  return {
    recommendedRoles, riskFlags, successMetrics,
    costEstimateUsd, costVerdict, securityTag, benefits, summary,
  };
}

function uniq<T>(xs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const key = typeof x === 'string' ? x.trim().toLowerCase() : JSON.stringify(x);
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(x);
  }
  return out;
}

export { PANEL };
