import type { FastifyInstance } from 'fastify';
import { readEvents } from '@guideai/messaging/events';
import { getDb, schema } from '@guideai/shared/db';
import type { Chunk } from '@guideai/shared/chunks';

export type ChannelKind = 'general' | 'routing' | 'approvals' | 'briefs' | 'errors' | 'agent' | 'brief';

interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  description: string;
  lastTs?: number;
  count?: number;
}

const ROUTING_RE = /^(routing plan:|dispatch:|skills loaded:)/;
const HANDOFF_RE = /^handoff:/;

function matchesChannel(c: Chunk, ch: { id: string; kind: ChannelKind }): boolean {
  switch (ch.kind) {
    case 'general':
      return true;
    case 'routing':
      return (c.kind === 'system' && !!c.text && (ROUTING_RE.test(c.text) || HANDOFF_RE.test(c.text)))
          || c.kind === 'phase';
    case 'approvals':
      return c.kind === 'tool' || c.kind === 'approval'
          || (c.kind === 'system' && !!c.text && /(pending approval|auto-(approved|denied)|approved|denied)/i.test(c.text));
    case 'briefs':
      return c.kind === 'user' || c.kind === 'ai';
    case 'errors':
      return (c.kind === 'system' && c.level === 'error');
    case 'agent': {
      const agentId = ch.id.slice('a:'.length);
      return c.agentId === agentId;
    }
    case 'brief': {
      const briefId = ch.id.slice('b:'.length);
      // Phase chunks carry taskId === briefId; user briefs surface as system
      // notes mentioning the brief id; otherwise no good signal yet.
      const c2 = c as any;
      if (c.kind === 'phase' && c2.taskId === briefId) return true;
      if (c.kind === 'system' && c.text?.includes(briefId)) return true;
      return false;
    }
  }
}

const BUILT_IN: Channel[] = [
  { id: 'general',   name: '#general',   kind: 'general',   description: 'every event in this workspace' },
  { id: 'routing',   name: '#routing',   kind: 'routing',   description: 'who works on what · phase boundaries' },
  { id: 'approvals', name: '#approvals', kind: 'approvals', description: 'tool requests · auto and manual decisions' },
  { id: 'briefs',    name: '#briefs',    kind: 'briefs',    description: 'your briefs + agent responses' },
  { id: 'errors',    name: '#errors',    kind: 'errors',    description: 'system errors only' },
];

export function registerChannelRoutes(app: FastifyInstance) {
  // List of channels: built-ins + per-agent + per-brief (last N).
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/channels',
    async (req) => {
      const db = getDb();
      const agents = db.select().from(schema.agents).all()
        .filter((a) => a.workspaceId === req.params.id && a.status !== 'retired')
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      const briefs = db.select().from(schema.briefs).all()
        .filter((b) => b.workspaceId === req.params.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

      const channels: Channel[] = [
        ...BUILT_IN,
        ...agents.map((a): Channel => ({
          id: `a:${a.id}`,
          name: `@${a.displayName}`,
          kind: 'agent',
          description: a.role,
        })),
        ...briefs.map((b): Channel => ({
          id: `b:${b.id}`,
          name: `#${b.id}`,
          kind: 'brief',
          description: (b.body ?? '').slice(0, 60),
          lastTs: b.createdAt,
        })),
      ];

      return { channels };
    },
  );

  // Filtered events for a specific channel.
  app.get<{ Params: { id: string; channelId: string }; Querystring: { limit?: string; since?: string } }>(
    '/api/workspaces/:id/channels/:channelId/events',
    async (req, reply) => {
      const channelId = decodeURIComponent(req.params.channelId);
      const kind: ChannelKind | undefined =
        channelId.startsWith('a:') ? 'agent' :
        channelId.startsWith('b:') ? 'brief' :
        BUILT_IN.find((c) => c.id === channelId)?.kind;
      if (!kind) { reply.code(404); return { error: 'unknown channel' }; }

      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
      const sinceTs = req.query.since ? Number(req.query.since) : undefined;
      const { chunks } = await readEvents(req.params.id, { sinceTs });
      const filtered = chunks.filter((c) => matchesChannel(c, { id: channelId, kind }));
      return { count: filtered.length, events: filtered.slice(-limit) };
    },
  );
}
