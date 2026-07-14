// S1 strip: discovery roundtable runner removed. Types + intake CRUD kept so
// consumers (cos.ts, projectContext.ts, wbs.ts, deliverables.ts) keep building.
// The runDiscovery runner and the 5-agent panel are gone.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';

export type PlanningMode = 'auto' | 'assisted' | 'manual';
export type HireMode = 'auto' | 'manual' | 'hybrid';
export type BudgetUnit = 'USD' | 'EUR' | 'GBP' | 'INR' | 'JPY' | 'tokens';

export interface IntakeRecord {
  workspaceId: string;
  goal: string;
  successCriteria: string[];
  constraints: string[];
  budgetHintUsd: number | null;
  budgetHintUnit: BudgetUnit;
  planningMode: PlanningMode;
  hireMode: HireMode;
  locked: boolean;
  lockedAt: number | null;
  discoveryContext: string;
  /** Plan-editor: model tier for Phase 1 (Plan). */
  preferredModel?: string;
}

export const BUDGET_BUFFER = 1.3;

const USD_PER_UNIT: Record<Exclude<BudgetUnit, 'tokens'>, number> = {
  USD: 1.0, EUR: 1.08, GBP: 1.27, INR: 0.012, JPY: 0.0067,
};

export function budgetHintToUsd(amount: number | null | undefined, unit: BudgetUnit): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (unit === 'tokens') return null;
  return amount * USD_PER_UNIT[unit];
}

export interface PanelEntry {
  role: string;
  displayName: string;
  lens: string;
  tier: 'haiku' | 'sonnet' | 'opus';
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
  revisionNote: string | null;
}

function safeArr(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

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
    preferredModel: (row as any).preferredModel ?? 'sonnet',
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
    preferredModel: intake.preferredModel ?? 'sonnet',
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

// Roundtable runner removed. If a caller still references runDiscovery, route
// it through this stub which logs and rejects — easier to spot than a 404.
export async function runDiscovery(_args: unknown): Promise<never> {
  throw new Error('runDiscovery removed in S1 (v2 has no discovery roundtable)');
}
