import type { FastifyInstance } from 'fastify';
import {
  loadPolicies, savePolicies, addRule, removeRule, synthesizeRuleFromDecision,
  type Rule, type Policies,
} from '@guideai/policies/engine';

export function registerPolicyRoutes(app: FastifyInstance) {
  app.get('/api/policies', async () => loadPolicies());

  app.put<{ Body: Policies }>('/api/policies', async (req) => {
    savePolicies(req.body);
    return { ok: true };
  });

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
