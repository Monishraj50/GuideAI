import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { appendEvent } from '@guideai/messaging/events';
import { getDb, schema } from '@guideai/shared/db';
import type { ApprovalChunk, SystemChunk } from '@guideai/shared/chunks';

export interface PendingApproval {
  id: string;
  tool: string;
  argsJson: string;
  decision: string;
  decidedAt: number;
  /** briefId that generated this approval (stored via the approvals.taskId
   *  column). Populated for approvals created after the 15-min-wait patch so
   *  the sidebar can disambiguate concurrent sessions. Empty for older rows. */
  briefId?: string | null;
}

export function listPending(_workspaceId: string): PendingApproval[] {
  // For step 5 we keep all approvals in one global table; later we'll join via
  // tasks → briefs → workspace.
  const db = getDb();
  return db.select().from(schema.approvals).all()
    .filter((a) => a.decision === 'pending')
    .map((a) => ({
      id: a.id,
      tool: a.tool,
      argsJson: a.argsJson,
      decision: a.decision,
      decidedAt: a.decidedAt,
      // approvals.taskId was repurposed to hold briefId when the /evaluate
      // route persists the approval row. Old rows had `null` here.
      briefId: (a as any).taskId ?? null,
    }));
}

export interface DecideArgs {
  workspaceId: string;
  approvalId: string;
  decision: 'approved' | 'denied';
  decidedBy?: string;
}

export function decideApproval(args: DecideArgs) {
  const db = getDb();
  const rows = db.select().from(schema.approvals).where(eq(schema.approvals.id, args.approvalId)).all();
  const row = rows[0];
  if (!row) throw new Error(`approval ${args.approvalId} not found`);
  if (row.decision !== 'pending') {
    throw new Error(`approval ${args.approvalId} already ${row.decision}`);
  }

  db.update(schema.approvals)
    .set({
      decision: args.decision,
      decidedBy: args.decidedBy ?? 'user',
      decidedAt: Date.now(),
    })
    .where(eq(schema.approvals.id, args.approvalId))
    .run();

  const approvalChunk: ApprovalChunk = {
    id: randomUUID(),
    ts: Date.now(),
    workspaceId: args.workspaceId,
    kind: 'approval',
    toolChunkId: args.approvalId,
    decision: args.decision,
  };
  appendEvent(args.workspaceId, approvalChunk);

  const note: SystemChunk = {
    id: randomUUID(),
    ts: Date.now(),
    workspaceId: args.workspaceId,
    kind: 'system',
    level: args.decision === 'approved' ? 'info' : 'warn',
    text: args.decision === 'approved'
      ? `approved ${row.tool}(${row.argsJson}) — would execute (step 8 wires real execution)`
      : `denied ${row.tool}(${row.argsJson})`,
  };
  appendEvent(args.workspaceId, note);

  return { approvalId: args.approvalId, decision: args.decision };
}
