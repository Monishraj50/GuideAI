import type { FastifyInstance } from 'fastify';
import { loadCatalog, departments } from '@guideai/agents-catalog';
import {
  hireAgent, retireAgent, listRoster,
  createCustomAgent, updateAgent, getAgent,
  type CustomAgentInput, type UpdateAgentInput,
} from '@guideai/orchestrator/hiring';

export function registerCatalogRoutes(app: FastifyInstance) {
  app.get('/api/catalog', async (_req, reply) => {
    const cat = loadCatalog();
    if (!cat) { reply.code(503); return { error: 'catalog not seeded' }; }
    return {
      fetchedAt: cat.fetchedAt,
      count: cat.count,
      departments: departments(cat),
    };
  });

  app.get<{ Querystring: { dept?: string; q?: string } }>(
    '/api/catalog/agents',
    async (req, reply) => {
      const cat = loadCatalog();
      if (!cat) { reply.code(503); return { error: 'catalog not seeded' }; }
      const q = (req.query.q ?? '').toLowerCase();
      const dept = req.query.dept;
      let agents = cat.agents;
      if (dept) agents = agents.filter((a) => a.department === dept);
      if (q) agents = agents.filter((a) =>
        a.role.toLowerCase().includes(q)
        || a.displayName.toLowerCase().includes(q)
        || a.description.toLowerCase().includes(q));
      // Don't ship the full body in the list — keep it light.
      return { count: agents.length, agents: agents.map(({ body, ...rest }) => rest) };
    },
  );

  app.get<{ Params: { role: string } }>(
    '/api/catalog/agents/:role',
    async (req, reply) => {
      const cat = loadCatalog();
      if (!cat) { reply.code(503); return { error: 'catalog not seeded' }; }
      const agent = cat.agents.find((a) => a.role === req.params.role);
      if (!agent) { reply.code(404); return { error: 'not found' }; }
      return agent;
    },
  );

  app.post<{ Params: { id: string }; Body: { role: string } }>(
    '/api/workspaces/:id/agents',
    async (req, reply) => {
      try { return hireAgent(req.params.id, req.body.role); }
      catch (e: any) { reply.code(400); return { error: String(e?.message ?? e) }; }
    },
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/workspaces/:id/agents/:agentId',
    async (req, reply) => {
      try { return retireAgent(req.params.id, req.params.agentId); }
      catch (e: any) { reply.code(404); return { error: String(e?.message ?? e) }; }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/agents',
    async (req) => ({ roster: listRoster(req.params.id) }),
  );

  app.post<{ Params: { id: string }; Body: CustomAgentInput }>(
    '/api/workspaces/:id/agents/custom',
    async (req, reply) => {
      try { return createCustomAgent(req.params.id, req.body); }
      catch (e: any) { reply.code(400); return { error: String(e?.message ?? e) }; }
    },
  );

  app.get<{ Params: { id: string; agentId: string } }>(
    '/api/workspaces/:id/agents/:agentId',
    async (req, reply) => {
      const a = getAgent(req.params.id, req.params.agentId);
      if (!a) { reply.code(404); return { error: 'not found' }; }
      return a;
    },
  );

  app.patch<{ Params: { id: string; agentId: string }; Body: UpdateAgentInput }>(
    '/api/workspaces/:id/agents/:agentId',
    async (req, reply) => {
      try { return updateAgent(req.params.id, req.params.agentId, req.body); }
      catch (e: any) { reply.code(400); return { error: String(e?.message ?? e) }; }
    },
  );
}
