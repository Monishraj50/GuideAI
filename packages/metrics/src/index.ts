import { getDb, schema } from '@guideai/shared/db';

// Rough Anthropic price per 1M tokens (USD). Approximate, used for the demo
// only — real billing should pull live pricing.
const PRICE_PER_1M: Record<string, { in: number; out: number }> = {
  haiku:  { in: 1.00, out: 5.00 },
  sonnet: { in: 3.00, out: 15.00 },
  opus:   { in: 15.00, out: 75.00 },
};

export interface AgentStats {
  id: string;
  role: string;
  displayName: string;
  status: string;
  tasksCompleted: number;
  tasksFailed: number;
  winRate: number;           // 0..1
  avgPhaseMs: number;        // 0 if no completed tasks
  reworkCount: number;       // tasks with the same (briefId, phase) > 1
  tokensIn: number;
  tokensOut: number;
  usd: number;
  lastActivity: number | null;
}

interface TaskRow {
  id: string;
  briefId: string;
  agentId: string | null;
  phase: string;
  status: string;
  artifactPath: string | null;
  tokensIn: number;
  tokensOut: number;
  startedAt: number | null;
  endedAt: number | null;
}

function priceTier(model: string | null | undefined): 'haiku' | 'sonnet' | 'opus' {
  // Default to sonnet pricing if we can't tell.
  if (!model) return 'sonnet';
  if (/haiku/i.test(model)) return 'haiku';
  if (/opus/i.test(model)) return 'opus';
  return 'sonnet';
}

function dollars(tokensIn: number, tokensOut: number, model: string | null | undefined) {
  const p = PRICE_PER_1M[priceTier(model)]!;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function computeRosterStats(workspaceId: string): AgentStats[] {
  const db = getDb();
  const agents = db.select().from(schema.agents).all()
    .filter((a) => a.workspaceId === workspaceId);
  const tasks = db.select().from(schema.tasks).all() as TaskRow[];

  const byAgent: Record<string, TaskRow[]> = {};
  for (const t of tasks) {
    if (!t.agentId) continue;
    (byAgent[t.agentId] ??= []).push(t);
  }

  return agents.map((a) => {
    const rows = byAgent[a.id] ?? [];
    const completed = rows.filter((r) => r.status === 'completed');
    const failed = rows.filter((r) => r.status === 'failed');
    const tokensIn = rows.reduce((s, r) => s + (r.tokensIn ?? 0), 0);
    const tokensOut = rows.reduce((s, r) => s + (r.tokensOut ?? 0), 0);

    // Rework: (briefId, phase) appearing more than once for this agent.
    const seen = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.briefId}::${r.phase}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const reworkCount = Array.from(seen.values()).reduce((s, n) => s + Math.max(0, n - 1), 0);

    const durations = completed
      .filter((r) => r.startedAt != null && r.endedAt != null)
      .map((r) => r.endedAt! - r.startedAt!);
    const avgPhaseMs = durations.length === 0 ? 0 : Math.round(durations.reduce((s, x) => s + x, 0) / durations.length);

    const winRate = rows.length === 0 ? 0 : completed.length / rows.length;

    const lastActivity = rows.reduce<number | null>((last, r) => {
      const t = r.endedAt ?? r.startedAt ?? null;
      if (t === null) return last;
      return last === null ? t : Math.max(last, t);
    }, null);

    return {
      id: a.id,
      role: a.role,
      displayName: a.displayName,
      status: a.status,
      tasksCompleted: completed.length,
      tasksFailed: failed.length,
      winRate,
      avgPhaseMs,
      reworkCount,
      tokensIn,
      tokensOut,
      usd: dollars(tokensIn, tokensOut, a.model),
      lastActivity,
    };
  });
}
