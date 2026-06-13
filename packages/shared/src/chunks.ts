// Discriminated unions for the event stream. Lifted in spirit from agent-teams-ai.
// Every event written to ~/.guideai/workspaces/{id}/events.jsonl is one of these.

export type ChunkKind = 'user' | 'ai' | 'system' | 'tool' | 'phase' | 'approval';

export interface BaseChunk {
  id: string;
  ts: number;
  workspaceId: string;
  agentId?: string;
}

export interface UserChunk extends BaseChunk {
  kind: 'user';
  text: string;
}

export interface AIChunk extends BaseChunk {
  kind: 'ai';
  agentId: string;
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

export interface SystemChunk extends BaseChunk {
  kind: 'system';
  text: string;
  level?: 'info' | 'warn' | 'error';
}

export interface ToolChunk extends BaseChunk {
  kind: 'tool';
  agentId: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: 'pending' | 'approved' | 'denied' | 'auto-approved' | 'completed';
}

export interface PhaseChunk extends BaseChunk {
  kind: 'phase';
  taskId: string;
  phase: 'research' | 'plan' | 'implement' | 'review' | 'verify';
  status: 'started' | 'completed' | 'paused' | 'failed';
  artifactPath?: string;
}

export interface ApprovalChunk extends BaseChunk {
  kind: 'approval';
  toolChunkId: string;
  decision: 'approved' | 'denied' | 'auto-approved';
  ruleId?: string;
}

export type Chunk = UserChunk | AIChunk | SystemChunk | ToolChunk | PhaseChunk | ApprovalChunk;
