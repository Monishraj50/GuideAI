import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readEvents, appendEvent } from '@guideai/messaging/events';
import { watchWorkspace } from '@guideai/messaging/watcher';
import type { Chunk } from '@guideai/shared/chunks';

export function registerEventRoutes(app: FastifyInstance) {
  // SSE stream for a workspace's events.jsonl.
  app.get('/api/workspaces/:id/events', async (req: FastifyRequest<{
    Params: { id: string };
    Querystring: { since?: string };
  }>, reply: FastifyReply) => {
    const { id } = req.params;
    const sinceTs = req.query.since ? Number(req.query.since) : undefined;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (chunk: Chunk) => {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    // Replay backlog first so a reconnecting client catches up.
    const backlog = await readEvents(id, { sinceTs });
    for (const c of backlog.chunks) send(c);
    reply.raw.write(`event: ready\ndata: {"replayed":${backlog.chunks.length}}\n\n`);

    // Then tail.
    const handle = watchWorkspace(id, send, { fromOffset: backlog.endOffset });

    // Heartbeat every 15s to keep proxies / browsers from timing out.
    const beat = setInterval(() => {
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);

    req.raw.on('close', async () => {
      clearInterval(beat);
      await handle.close();
    });

    // Hold the connection open. Fastify needs a non-resolving promise here.
    return new Promise<void>(() => {});
  });

  // Tiny helper for tests / dev: append an event by POST.
  app.post('/api/workspaces/:id/events', async (req: FastifyRequest<{
    Params: { id: string };
    Body: Chunk;
  }>) => {
    appendEvent(req.params.id, req.body);
    return { ok: true };
  });
}
