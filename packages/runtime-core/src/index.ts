import type { Chunk } from '@guideai/shared/chunks';

export type RuntimeId = 'claude' | 'codex' | 'copilot' | 'gemini';

export interface SpawnOpts {
  agentId: string;
  workspaceId: string;
  cwd: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  env?: Record<string, string>;
}

export interface RunOnceResult {
  exitCode: number;
  chunks: Chunk[];
  durationMs: number;
}

export interface AgentHandle {
  id: string;
  pid: number;
  send(text: string): Promise<void>;
  onEvent(cb: (chunk: Chunk) => void): () => void;
  waitForExit(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly capabilities: {
    streaming: boolean;
    interactive: boolean;
    tools: readonly string[];
    models: readonly string[];
  };

  /** Long-running interactive session (used by orchestrator from step 5+). */
  spawn(opts: SpawnOpts): Promise<AgentHandle>;

  /** One-shot: send a single prompt, return all chunks emitted until exit. */
  runOnce(opts: SpawnOpts, prompt: string): Promise<RunOnceResult>;
}
