import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  ClaudeAdapter,
  killAllClaudeAgents,
  listRunningClaudeAgents,
} from '@guideai/runtime-claude';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import type { SystemChunk } from '@guideai/shared/chunks';

export function registerKillswitchRoutes(app: FastifyInstance) {
  app.get('/api/killswitch/status', async () => ({
    running: listRunningClaudeAgents(),
  }));

  app.post<{ Querystring: { workspace?: string } }>(
    '/api/killswitch',
    async (req) => {
      const ws = req.query.workspace;
      const result = await killAllClaudeAgents();
      const note: SystemChunk = {
        id: randomUUID(), ts: Date.now(), workspaceId: ws ?? 'all',
        kind: 'system', level: 'warn',
        text: `KILLSWITCH: ${result.killed} agents killed in ${result.durationMs}ms`,
      };
      if (ws) appendEvent(ws, note);
      return result;
    },
  );

  // Dev-only: kick off N fire-and-forget `runOnce` calls with verbose prompts
  // so the killswitch can be demoed in <2s without waiting for a real pipeline.
  // Returns immediately; each underlying process is tracked and stays alive
  // ~5-15s until completion or killswitch.
  app.post<{ Querystring: { n?: string; workspace?: string } }>(
    '/api/dev/spawn-test-agents',
    async (req) => {
      const n = Math.min(10, Math.max(1, Number(req.query.n ?? 3)));
      const ws = req.query.workspace ?? 'demo';
      for (let i = 0; i < n; i++) {
        // Fire-and-forget; track() inside runOnce registers the proc.
        void ClaudeAdapter.runOnce(
          {
            workspaceId: ws,
            agentId: `kt-${i}-${randomUUID().slice(0, 4)}`,
            cwd: path.join(paths.home, 'cwd-killswitch-test'),
            systemPrompt: 'You are a verbose narrator. Take your time. Write slowly and fully.',
            model: 'sonnet',
          },
          `Write a ~300-word essay (round ${i + 1}) on the value of clean architectures in software.`,
        ).catch(() => {});
      }
      return { spawned: n };
    },
  );
}
