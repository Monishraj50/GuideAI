import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '@guideai/shared/db';
import { readEvents } from '@guideai/messaging/events';

interface AuditEntry {
  ts: number;
  kind: 'approval' | 'hire' | 'retire' | 'skill' | 'killswitch' | 'digest';
  text: string;
  ruleId?: string;
  decidedBy?: string;
  workspaceId?: string;
}

const SYSTEM_PREFIX_KINDS: Array<{ prefix: string; kind: AuditEntry['kind'] }> = [
  { prefix: 'hired ',          kind: 'hire' },
  { prefix: 'retired ',        kind: 'retire' },
  { prefix: 'skill promoted:', kind: 'skill' },
  { prefix: 'KILLSWITCH:',     kind: 'killswitch' },
  { prefix: 'digest generated', kind: 'digest' },
  { prefix: 'auto-approved ',  kind: 'approval' },
  { prefix: 'auto-denied ',    kind: 'approval' },
  { prefix: 'approved ',       kind: 'approval' },
  { prefix: 'denied ',         kind: 'approval' },
];

export function registerAuditRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/workspaces/:id/audit',
    async (req) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

      // 1) every approval row from the DB (append-only, ground truth).
      const db = getDb();
      const approvals = db.select().from(schema.approvals).all().map((a): AuditEntry => ({
        ts: a.decidedAt,
        kind: 'approval',
        text: `${a.decision} ${a.tool}(${a.argsJson})`,
        ruleId: a.ruleId ?? undefined,
        decidedBy: a.decidedBy,
        workspaceId: req.params.id,
      }));

      // 2) audit-worthy system chunks from the events log (back 7 days).
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const { chunks } = await readEvents(req.params.id, { sinceTs: since });
      const sysEntries: AuditEntry[] = [];
      for (const c of chunks) {
        if (c.kind !== 'system' || !c.text) continue;
        const hit = SYSTEM_PREFIX_KINDS.find((s) => c.text!.startsWith(s.prefix));
        if (!hit) continue;
        sysEntries.push({
          ts: c.ts, kind: hit.kind, text: c.text,
          workspaceId: req.params.id,
        });
      }

      const merged = [...approvals, ...sysEntries]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
      return { count: merged.length, entries: merged };
    },
  );
}
