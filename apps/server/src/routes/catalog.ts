import type { FastifyInstance } from 'fastify';
import { loadCatalog, departments } from '@guideai/agents-catalog';
import {
  hireAgent, retireAgent, listRoster,
  createCustomAgent, updateAgent, getAgent,
  type CustomAgentInput, type UpdateAgentInput,
} from '@guideai/orchestrator/hiring';
import { scoreAgent } from '@guideai/orchestrator/routing';

// Phase tags + tokenizer (kept local to avoid coupling to routing.ts internals).
// S3: only 3 phases matter for suggestions now.
const SUGGEST_PHASES = ['plan', 'implement', 'review'] as const;
const STOPWORDS = new Set([
  'a','an','the','and','or','to','of','for','with','in','on','by','as','is','it','be','this','that',
  'we','our','your','their','from','add','make','build','plan','sketch','decide','keep','minimal',
  'should','would','could','want','need','let','any','some','all','one','two','three','use','using',
]);
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
}

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

  // Suggest agents from the marketplace that fit a brief body.
  //
  // POST /api/catalog/suggest  Body: { taskBody, limit?, workspaceId? }
  //   - Tokenizes the brief body
  //   - Scores every catalog agent across all 5 phases; picks each agent's BEST phase
  //   - Returns top N with their score, best-fit phase, and a hiredAlready flag
  //     when a workspaceId is provided (lets the UI mark agents that won't trigger
  //     a marketplace hire on dispatch)
  app.post<{ Body: { taskBody: string; limit?: number; workspaceId?: string } }>(
    '/api/catalog/suggest',
    async (req, reply) => {
      const taskBody = (req.body?.taskBody ?? '').toString().trim();
      if (!taskBody) { reply.code(400); return { error: 'taskBody is required' }; }
      const limit = Math.min(Math.max(req.body?.limit ?? 5, 1), 12);

      const cat = loadCatalog();
      if (!cat) { reply.code(503); return { error: 'catalog not seeded' }; }

      const briefToks = tokenize(taskBody).slice(0, 40);
      const hired = req.body?.workspaceId
        ? new Set(listRoster(req.body.workspaceId).filter((a) => a.status !== 'retired').map((a) => a.role))
        : new Set<string>();

      const scored = cat.agents.map((agent) => {
        const routable = {
          id: agent.role,
          role: agent.role,
          displayName: agent.displayName,
          systemPrompt: agent.body?.slice(0, 800),
        };
        let bestScore = 0;
        let bestPhase: string = 'implement';
        for (const phase of SUGGEST_PHASES) {
          const s = scoreAgent(routable, phase, briefToks);
          if (s > bestScore) { bestScore = s; bestPhase = phase; }
        }
        return {
          role: agent.role,
          displayName: agent.displayName,
          department: agent.department,
          description: agent.description,
          model: agent.model,
          score: bestScore,
          bestPhase,
          hiredAlready: hired.has(agent.role),
        };
      });

      const top = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return { count: top.length, suggestions: top };
    },
  );
}
