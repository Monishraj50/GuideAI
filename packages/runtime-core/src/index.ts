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
  /** Optional streaming callback. When set, the adapter calls this for every
   *  chunk as soon as it arrives, BEFORE batching them into RunOnceResult.
   *  Used by the orchestrator to live-write the per-task transcript file as
   *  the agent works (so VS Code's markdown preview shows real-time output). */
  onChunk?: (chunk: Chunk) => void;
  /** Optional persistent session id. When set, the Claude adapter passes
   *  --session-id <uuid> so the conversation is recoverable via
   *  `claude --resume <uuid>`. The orchestrator passes one uuid per brief so
   *  every phase shares the same session. */
  sessionId?: string;
  /** Optional display name passed via `-n/--name <name>`. Shown in the
   *  prompt box + the `--resume` picker so the user can tell sessions apart
   *  at a glance (otherwise it's just a UUID prefix). */
  sessionName?: string;
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

export type RuntimeAvailability = 'ready' | 'coming-soon';

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly displayName: string;
  readonly availability: RuntimeAvailability;
  /** Short tagline for the picker. */
  readonly description: string;
  /** Either the CLI binary name or a hosted endpoint URL — only set when ready. */
  readonly endpoint?: string;
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

/** A stub adapter that throws on use; lets the UI show non-ready runtimes
 *  in the picker without making them silently mis-route. */
export function makeStubAdapter(spec: {
  id: RuntimeId;
  displayName: string;
  description: string;
  capabilities?: Partial<RuntimeAdapter['capabilities']>;
}): RuntimeAdapter {
  const cannotUse = () => {
    throw new Error(
      `runtime '${spec.id}' is not yet implemented in this GuideAI build. ` +
      `Use 'claude' for now.`,
    );
  };
  return {
    id: spec.id,
    displayName: spec.displayName,
    availability: 'coming-soon',
    description: spec.description,
    capabilities: {
      streaming: spec.capabilities?.streaming ?? false,
      interactive: spec.capabilities?.interactive ?? false,
      tools: spec.capabilities?.tools ?? [],
      models: spec.capabilities?.models ?? [],
    },
    spawn: cannotUse,
    runOnce: cannotUse,
  };
}
