import { randomUUID } from 'node:crypto';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { getDb, schema } from '@guideai/shared/db';
import type { UserChunk, ToolChunk, SystemChunk } from '@guideai/shared/chunks';
import { runPipeline, PHASE_ORDER } from './phases.js';
import { eq } from 'drizzle-orm';

const COS_AGENT_ROLE = 'chief-of-staff';
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

function now() { return Date.now(); }
function base(workspaceId: string, agentId?: string) {
  return { id: randomUUID(), ts: now(), workspaceId, ...(agentId ? { agentId } : {}) };
}

async function ensureWorkspace(workspaceId: string, name?: string) {
  const db = getDb();
  const existing = db.select().from(schema.workspaces).all().find((w) => w.id === workspaceId);
  if (!existing) {
    db.insert(schema.workspaces).values({
      id: workspaceId,
      name: name ?? workspaceId,
      autonomyMode: 'approval-gated',
      createdAt: now(),
    }).run();
  }
}

async function ensureCosAgent(workspaceId: string): Promise<string> {
  const db = getDb();
  const all = db.select().from(schema.agents).all().filter((a) => a.workspaceId === workspaceId && a.role === COS_AGENT_ROLE);
  if (all.length > 0) return all[0]!.id;
  const id = `cos-${randomUUID().slice(0, 8)}`;
  db.insert(schema.agents).values({
    id,
    workspaceId,
    role: COS_AGENT_ROLE,
    displayName: 'Chief of Staff',
    runtime: 'claude',
    model: null,
    systemPrompt: 'Chief of Staff for an autonomous team.',
    toolWhitelist: JSON.stringify(READ_ONLY_TOOLS),
    status: 'idle',
    createdAt: now(),
  }).run();
  return id;
}

export interface SubmitBriefResult {
  briefId: string;
  agentId: string;
  phases: string[];
  pipeline: 'started';
}

/**
 * Submit a brief, then kick off the full pipeline in the background. Returns
 * immediately so the UI can light up via SSE without holding an HTTP request
 * open for the duration. Phase events + the synthetic approval are appended to
 * the workspace event stream as the pipeline progresses.
 */
export async function submitBrief(args: {
  workspaceId: string;
  body: string;
}): Promise<SubmitBriefResult> {
  const { workspaceId, body } = args;
  await ensureWorkspace(workspaceId);
  const agentId = await ensureCosAgent(workspaceId);

  const db = getDb();
  const briefId = `brief-${randomUUID().slice(0, 8)}`;
  db.insert(schema.briefs).values({
    id: briefId, workspaceId, body, status: 'active', createdAt: now(),
  }).run();

  const userChunk: UserChunk = { ...base(workspaceId), kind: 'user', text: body };
  appendEvent(workspaceId, userChunk);

  const cwd = paths.agentCwd(workspaceId, agentId);

  // Fire-and-forget the pipeline. Any failure is surfaced in the event stream
  // via runPipeline()'s internal error chunk; we also log it here for the
  // server console.
  void (async () => {
    try {
      const pipelineResult = await runPipeline({
        workspaceId, agentId, briefId, brief: body, cwd,
      });

      for (const r of pipelineResult.phaseResults) {
        db.insert(schema.tasks).values({
          id: `${briefId}-${r.phase}`,
          briefId,
          agentId,
          phase: r.phase,
          status: 'completed',
          artifactPath: r.artifactPath,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          startedAt: now(),
          endedAt: now(),
        }).run();
      }

      db.update(schema.briefs).set({ status: 'done' })
        .where(eq(schema.briefs.id, briefId)).run();

      const toolChunk: ToolChunk = {
        ...base(workspaceId, agentId),
        kind: 'tool', agentId, tool: 'Bash', args: { cmd: 'ls -la' }, status: 'pending',
      };
      appendEvent(workspaceId, toolChunk);

      const approvalId = `appr-${randomUUID().slice(0, 8)}`;
      db.insert(schema.approvals).values({
        id: approvalId,
        taskId: null as unknown as string,
        tool: 'Bash',
        argsJson: JSON.stringify({ cmd: 'ls -la' }),
        decision: 'pending',
        ruleId: null,
        decidedBy: 'pending',
        decidedAt: now(),
      } as any).run();

      const pendingNote: SystemChunk = {
        ...base(workspaceId, agentId),
        kind: 'system', level: 'warn',
        text: `pending approval ${approvalId}: Bash(ls -la) — open the brief pane to approve`,
      };
      appendEvent(workspaceId, pendingNote);

      const doneNote: SystemChunk = {
        ...base(workspaceId, agentId),
        kind: 'system', level: 'info',
        text: `brief ${briefId} pipeline complete · ${pipelineResult.totalTokensIn}↓/${pipelineResult.totalTokensOut}↑ tokens · ${pipelineResult.totalDurationMs}ms`,
      };
      appendEvent(workspaceId, doneNote);
    } catch (err: any) {
      const fail: SystemChunk = {
        ...base(workspaceId, agentId),
        kind: 'system', level: 'error',
        text: `pipeline failed for ${briefId}: ${err?.message ?? err}`,
      };
      appendEvent(workspaceId, fail);
      db.update(schema.briefs).set({ status: 'failed' })
        .where(eq(schema.briefs.id, briefId)).run();
    }
  })();

  return {
    briefId,
    agentId,
    phases: PHASE_ORDER as unknown as string[],
    pipeline: 'started',
  };
}
