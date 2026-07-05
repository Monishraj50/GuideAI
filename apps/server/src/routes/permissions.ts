import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { appendEvent } from '@guideai/messaging/events';
import { getDb, schema } from '@guideai/shared/db';
import { evaluateTool, loadPolicies } from '@guideai/policies/engine';
import type { ToolChunk, SystemChunk, ApprovalChunk } from '@guideai/shared/chunks';

interface PendingWaiter {
  approvalId: string;
  resolve: (decision: 'approved' | 'denied') => void;
  timer: NodeJS.Timeout;
}

// Hook calls wait here until either the user clicks approve/deny in the UI
// or the timeout elapses.
const WAITERS = new Map<string, PendingWaiter>();

export function notifyApprovalDecided(approvalId: string, decision: 'approved' | 'denied') {
  const w = WAITERS.get(approvalId);
  if (!w) return;
  clearTimeout(w.timer);
  WAITERS.delete(approvalId);
  w.resolve(decision);
}

export function registerPermissionRoutes(app: FastifyInstance) {
  // The hook calls this once per tool invocation. Returns immediately on
  // auto-decide, blocks (long-poll) until user decides for ask cases.
  app.post<{ Body: {
    workspaceId: string;
    agentId?: string;
    briefId?: string;
    tool: string;
    args: unknown;
    waitMs?: number;
  } }>(
    '/api/permissions/evaluate',
    async (req, reply) => {
      const { workspaceId, agentId, briefId, tool, args } = req.body ?? {} as any;
      if (!workspaceId || !tool) {
        reply.code(400);
        return { error: 'workspaceId and tool are required' };
      }
      const policies = loadPolicies();
      const verdict = evaluateTool(policies, tool, args, workspaceId);

      // Emit a ToolChunk into the feed so the UI shows what happened.
      const baseChunk: ToolChunk = {
        id: randomUUID(), ts: Date.now(), workspaceId,
        kind: 'tool', agentId: agentId ?? 'unknown',
        tool, args, status: 'pending',
      };

      // Auto-decide path: no waiting, no approval row.
      if (verdict.action === 'auto-approve' || verdict.action === 'deny') {
        const decision: 'approved' | 'denied' = verdict.action === 'auto-approve' ? 'approved' : 'denied';
        appendEvent(workspaceId, { ...baseChunk, status: decision === 'approved' ? 'auto-approved' : 'denied' });
        const apprId = `appr-${randomUUID().slice(0, 8)}`;
        const db = getDb();
        db.insert(schema.approvals).values({
          id: apprId, taskId: null as unknown as string,
          tool, argsJson: JSON.stringify(args ?? {}),
          decision, ruleId: verdict.ruleId ?? null,
          decidedBy: `rule:${verdict.ruleId}`,
          decidedAt: Date.now(),
        } as any).run();
        appendEvent(workspaceId, {
          id: randomUUID(), ts: Date.now(), workspaceId,
          agentId: agentId ?? 'unknown',
          kind: 'approval',
          toolChunkId: apprId,
          decision: decision === 'approved' ? 'auto-approved' : 'denied',
          ruleId: verdict.ruleId,
        } as ApprovalChunk);
        appendEvent(workspaceId, {
          id: randomUUID(), ts: Date.now(), workspaceId,
          agentId: agentId ?? 'unknown',
          kind: 'system', level: 'info',
          text: `auto-${decision} ${tool}(${JSON.stringify(args ?? {}).slice(0, 80)}) via ${verdict.ruleId} (${verdict.ruleDescription ?? ''})`,
        } as SystemChunk);
        return { decision, auto: true, ruleId: verdict.ruleId, reason: verdict.ruleDescription };
      }

      // ask path: create pending approval, surface to UI, wait for the user.
      const approvalId = `appr-${randomUUID().slice(0, 8)}`;
      const db = getDb();
      db.insert(schema.approvals).values({
        id: approvalId, taskId: briefId ?? (null as unknown as string),
        tool, argsJson: JSON.stringify(args ?? {}),
        decision: 'pending', ruleId: null,
        decidedBy: 'pending',
        decidedAt: Date.now(),
      } as any).run();

      appendEvent(workspaceId, baseChunk);
      appendEvent(workspaceId, {
        id: randomUUID(), ts: Date.now(), workspaceId,
        agentId: agentId ?? 'unknown',
        kind: 'system', level: 'warn',
        text: `pending approval ${approvalId}: ${tool}(${JSON.stringify(args ?? {}).slice(0, 80)})`,
      } as SystemChunk);

      const waitMs = Math.min(Math.max(1000, req.body?.waitMs ?? 60_000), 120_000);
      const decision: 'approved' | 'denied' = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          WAITERS.delete(approvalId);
          // Mark the row denied-by-timeout so PendingTray clears it.
          try {
            db.update(schema.approvals).set({
              decision: 'denied', decidedBy: 'timeout', decidedAt: Date.now(),
            } as any).where(/* dummy */ schema.approvals.id as any).run();
          } catch {}
          resolve('denied');
        }, waitMs);
        WAITERS.set(approvalId, { approvalId, resolve, timer });
      });

      return { decision, auto: false, approvalId, reason: 'user decision' };
    },
  );

  // GET helper so the hook (or anything else) can poll.
  app.get<{ Params: { id: string } }>(
    '/api/permissions/wait/:id',
    async (req, reply) => {
      const id = req.params.id;
      const db = getDb();
      const row = db.select().from(schema.approvals).all().find((a: any) => a.id === id);
      if (!row) { reply.code(404); return { error: 'not found' }; }
      if (row.decision === 'pending') return { decision: 'pending' };
      return { decision: row.decision };
    },
  );
}
