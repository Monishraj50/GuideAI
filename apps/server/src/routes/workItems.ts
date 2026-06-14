import type { FastifyInstance } from 'fastify';
import {
  listWorkItems, createWorkItem, updateWorkItem, deleteWorkItem, getWorkItem,
  type WorkStatus, type WorkPriority, type WorkPhase,
} from '@guideai/orchestrator/wbs';

const STATUSES: WorkStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
const PHASES: WorkPhase[] = ['research', 'plan', 'implement', 'review', 'verify', 'other'];
const PRIORITIES: WorkPriority[] = ['low', 'normal', 'high', 'critical'];

export function registerWorkItemRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { briefId?: string; status?: WorkStatus } }>(
    '/api/workspaces/:id/work-items', async (req) => {
      const items = listWorkItems(req.params.id, {
        briefId: req.query.briefId,
        status: STATUSES.includes(req.query.status as WorkStatus) ? req.query.status : undefined,
      });
      return { items };
    });

  app.post<{
    Params: { id: string };
    Body: {
      title: string; description?: string;
      briefId?: string | null; planId?: string | null; parentId?: string | null;
      assignedRole?: string | null; assignedAgentId?: string | null;
      phase?: WorkPhase; status?: WorkStatus; priority?: WorkPriority;
      estimateHours?: number | null;
    };
  }>('/api/workspaces/:id/work-items', async (req, reply) => {
    try {
      const body = req.body ?? ({} as any);
      const item = createWorkItem({
        workspaceId: req.params.id,
        title: body.title,
        description: body.description,
        briefId: body.briefId ?? null,
        planId: body.planId ?? null,
        parentId: body.parentId ?? null,
        assignedRole: body.assignedRole ?? null,
        assignedAgentId: body.assignedAgentId ?? null,
        phase: PHASES.includes(body.phase as WorkPhase) ? body.phase : undefined,
        status: STATUSES.includes(body.status as WorkStatus) ? body.status : undefined,
        priority: PRIORITIES.includes(body.priority as WorkPriority) ? body.priority : undefined,
        estimateHours: body.estimateHours ?? null,
        source: 'manual',
      });
      return { item };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      title: string; description: string | null;
      assignedRole: string | null; assignedAgentId: string | null;
      phase: WorkPhase | null; status: WorkStatus; priority: WorkPriority;
      estimateHours: number | null; position: number;
    }>;
  }>('/api/work-items/:id', async (req, reply) => {
    try {
      const current = getWorkItem(req.params.id);
      if (!current) { reply.code(404); return { error: 'not found' }; }
      const body = req.body ?? {};
      const patch: any = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.assignedRole !== undefined) patch.assignedRole = body.assignedRole;
      if (body.assignedAgentId !== undefined) patch.assignedAgentId = body.assignedAgentId;
      if (body.phase !== undefined && (body.phase === null || PHASES.includes(body.phase as WorkPhase))) patch.phase = body.phase;
      if (body.status !== undefined && STATUSES.includes(body.status as WorkStatus)) patch.status = body.status;
      if (body.priority !== undefined && PRIORITIES.includes(body.priority as WorkPriority)) patch.priority = body.priority;
      if (body.estimateHours !== undefined) patch.estimateHours = body.estimateHours;
      if (body.position !== undefined) patch.position = body.position;
      const item = updateWorkItem(req.params.id, patch);
      return { item };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/work-items/:id', async (req, reply) => {
    try {
      deleteWorkItem(req.params.id);
      return { ok: true };
    } catch (err: any) {
      reply.code(400); return { error: String(err?.message ?? err) };
    }
  });
}
