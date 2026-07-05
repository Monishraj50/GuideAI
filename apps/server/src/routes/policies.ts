import type { FastifyInstance } from 'fastify';
import {
  loadPolicies, savePolicies, addRule, removeRule, synthesizeRuleFromDecision,
  setMode, listSessionAllow,
  type Rule, type Policies, type PermissionMode,
} from '@guideai/policies/engine';

export function registerPolicyRoutes(app: FastifyInstance) {
  app.get('/api/policies', async () => loadPolicies());

  app.put<{ Body: Policies }>('/api/policies', async (req) => {
    savePolicies(req.body);
    return { ok: true };
  });

  app.get('/api/policies/mode', async () => ({ mode: loadPolicies().mode }));

  app.put<{ Body: { mode: PermissionMode } }>('/api/policies/mode', async (req, reply) => {
    const mode = req.body?.mode;
    if (mode !== 'auto' && mode !== 'manual' && mode !== 'custom') {
      reply.code(400);
      return { error: 'mode must be one of: auto, manual, custom' };
    }
    setMode(mode);
    return { ok: true, mode };
  });

  app.get<{ Querystring: { workspaceId?: string } }>(
    '/api/policies/session-allow',
    async (req, reply) => {
      const ws = req.query?.workspaceId;
      if (!ws) { reply.code(400); return { error: 'workspaceId is required' }; }
      return { keys: listSessionAllow(ws) };
    },
  );

  app.post<{ Body: Omit<Rule, 'createdAt'> }>('/api/policies/rules', async (req) => {
    const saved = addRule(req.body);
    return { ok: true, rule: saved };
  });

  app.delete<{ Params: { id: string } }>('/api/policies/rules/:id', async (req, reply) => {
    const ok = removeRule(req.params.id);
    if (!ok) { reply.code(404); return { error: 'not found' }; }
    return { ok: true };
  });

  // Helper for the UI: propose a rule from a past decision without saving it.
  app.post<{ Body: { tool: string; args: unknown; decision: 'approved' | 'denied' } }>(
    '/api/policies/rules/synthesize',
    async (req) => synthesizeRuleFromDecision(req.body.tool, req.body.args, req.body.decision),
  );
}
