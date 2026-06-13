import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '@guideai/runtime-claude';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { getDb, schema } from '@guideai/shared/db';
import type { Chunk, UserChunk, SystemChunk, ToolChunk, PhaseChunk, AIChunk } from '@guideai/shared/chunks';

// Default Chief-of-Staff. For step 5 we keep it minimal: one brief → one agent.
// Real decomposition (research → plan → implement → review → verify) lands in step 6.

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
    systemPrompt:
      'You are the Chief of Staff for a small autonomous team. ' +
      'Take a brief from the boss, restate the goal, then list 2-4 concrete next steps. ' +
      'Keep responses under 80 words.',
    toolWhitelist: JSON.stringify(READ_ONLY_TOOLS),
    status: 'idle',
    createdAt: now(),
  }).run();
  return id;
}

export interface SubmitBriefResult {
  briefId: string;
  agentId: string;
  chunkCount: number;
  approvalId: string;   // synthetic approval emitted at end for step 5 demo
}

/**
 * Submit a brief: create DB rows, spawn the CoS agent, stream chunks into the
 * workspace event log, then emit a synthetic Bash tool request that the policy
 * engine treats as "needs approval." This proves the brief → agent → events →
 * approval flow end-to-end before real MCP-based tool interception in step 8.
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
    id: briefId,
    workspaceId,
    body,
    status: 'active',
    createdAt: now(),
  }).run();

  // 1) Boss's brief shows up in the feed.
  const userChunk: UserChunk = { ...base(workspaceId), kind: 'user', text: body };
  appendEvent(workspaceId, userChunk);

  // 2) Phase start.
  const phaseStart: PhaseChunk = {
    ...base(workspaceId, agentId),
    kind: 'phase',
    taskId: briefId,
    phase: 'research',
    status: 'started',
  };
  appendEvent(workspaceId, phaseStart);

  // 3) Spawn the Claude CLI in a sandboxed cwd. Stream all chunks live.
  const cwd = paths.agentCwd(workspaceId, agentId);
  let chunkCount = 0;
  const result = await ClaudeAdapter.runOnce(
    {
      agentId,
      workspaceId,
      cwd,
      systemPrompt:
        'You are the Chief of Staff for a small autonomous team. ' +
        'Restate the boss\'s goal and list 2-4 concrete next steps. ' +
        'Keep your answer under 80 words.',
      allowedTools: READ_ONLY_TOOLS,
    },
    body,
  );

  for (const c of result.chunks) {
    appendEvent(workspaceId, c);
    chunkCount++;
  }

  // 4) Phase complete.
  const phaseDone: PhaseChunk = {
    ...base(workspaceId, agentId),
    kind: 'phase',
    taskId: briefId,
    phase: 'research',
    status: 'completed',
  };
  appendEvent(workspaceId, phaseDone);

  // 5) Synthetic tool request demonstrating the approval flow. In step 8 this
  //    will be replaced by a real MCP permission-prompt callback.
  const toolChunk: ToolChunk = {
    ...base(workspaceId, agentId),
    kind: 'tool',
    agentId,
    tool: 'Bash',
    args: { cmd: 'ls -la' },
    status: 'pending',
  };
  appendEvent(workspaceId, toolChunk);

  const approvalId = `appr-${randomUUID().slice(0, 8)}`;
  db.insert(schema.approvals).values({
    id: approvalId,
    taskId: null as unknown as string,  // null is acceptable; column nullable
    tool: 'Bash',
    argsJson: JSON.stringify({ cmd: 'ls -la' }),
    decision: 'pending',
    ruleId: null,
    decidedBy: 'pending',
    decidedAt: now(),
    // We stash the chunk id in args so the UI can correlate. Cheap for v1.
  } as any).run();

  // We surface the pending approval via a SystemChunk that carries enough info
  // for the UI to render an action button without a separate REST poll.
  const pendingNote: SystemChunk = {
    ...base(workspaceId, agentId),
    kind: 'system',
    level: 'warn',
    text: `pending approval ${approvalId}: Bash(ls -la) — open the brief pane to approve`,
  };
  appendEvent(workspaceId, pendingNote);

  return { briefId, agentId, chunkCount, approvalId };
}
