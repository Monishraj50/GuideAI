import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type {
  AgentHandle, RunOnceResult, RuntimeAdapter, SpawnOpts,
} from '@guideai/runtime-core';
import type { Chunk, SystemChunk } from '@guideai/shared/chunks';

function ensureCwd(cwd: string) { fs.mkdirSync(cwd, { recursive: true }); }

const NOT_CONNECTED_MSG =
  'Claude integration is not connected. Go to Settings → Claude integration and click "Connect" on either the CLI session or save an API key. Briefs will run once an integration is connected.';

function notConnectedChunk(opts: SpawnOpts): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId: opts.workspaceId, agentId: opts.agentId,
    kind: 'system', level: 'error',
    text: NOT_CONNECTED_MSG,
  };
}

/**
 * Used when the user is signed in (not guest) but hasn't connected any Claude
 * integration yet. Returns a clear "not connected" chunk instead of silently
 * failing to spawn the CLI.
 */
export const DisconnectedAdapter: RuntimeAdapter = {
  id: 'claude',
  displayName: 'Not connected',
  availability: 'coming-soon',
  description: 'No Claude integration is connected.',
  capabilities: { streaming: false, interactive: false, tools: [], models: [] },

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    ensureCwd(opts.cwd);
    const listeners = new Set<(c: Chunk) => void>();
    const chunk = notConnectedChunk(opts);
    setTimeout(() => { for (const cb of listeners) cb(chunk); }, 0);
    return {
      id: opts.agentId, pid: -1,
      async send() {/* no-op */},
      onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      waitForExit() { return Promise.resolve(1); },
      async kill() {/* no-op */},
    };
  },

  async runOnce(opts: SpawnOpts): Promise<RunOnceResult> {
    ensureCwd(opts.cwd);
    return { exitCode: 1, chunks: [notConnectedChunk(opts)], durationMs: 0 };
  },
};
