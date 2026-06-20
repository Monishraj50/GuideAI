import type { FastifyInstance } from 'fastify';
import {
  readIntegration, writeIntegration, workspaceConsent, setWorkspaceConsent,
  type OpenAIWorkspaceConsent,
} from '@guideai/runtime-openai';

function publicState(workspaceId: string) {
  const w = workspaceConsent(readIntegration(), workspaceId);
  return {
    workspaceId,
    apiKeySet: !!w.apiKey,
    apiKeyHint: w.apiKey ? `…${w.apiKey.slice(-4)}` : undefined,
    apiKeySavedAt: w.apiKeySavedAt,
    modelOverrides: w.modelOverrides ?? {},
    ready: !!w.apiKey,
  };
}

export function registerOpenAIIntegrationRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/integrations/openai', async (req) => {
    return publicState(req.params.id);
  });

  app.put<{
    Params: { id: string };
    Body: { apiKey?: string; modelOverrides?: OpenAIWorkspaceConsent['modelOverrides'] };
  }>('/api/workspaces/:id/integrations/openai', async (req, reply) => {
    const integ = readIntegration();
    const cur = workspaceConsent(integ, req.params.id);
    const next: OpenAIWorkspaceConsent = { ...cur };
    if (req.body?.apiKey !== undefined) {
      const k = req.body.apiKey.toString().trim();
      if (!k) { reply.code(400); return { error: 'apiKey cannot be empty (use DELETE to clear)' }; }
      next.apiKey = k;
      next.apiKeySavedAt = Date.now();
    }
    if (req.body?.modelOverrides !== undefined) {
      const o = req.body.modelOverrides;
      next.modelOverrides = {
        haiku:  o?.haiku?.toString().trim() || undefined,
        sonnet: o?.sonnet?.toString().trim() || undefined,
        opus:   o?.opus?.toString().trim() || undefined,
      };
    }
    writeIntegration(setWorkspaceConsent(integ, req.params.id, next));
    return publicState(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/workspaces/:id/integrations/openai', async (req) => {
    const integ = readIntegration();
    const cur = workspaceConsent(integ, req.params.id);
    delete cur.apiKey;
    delete cur.apiKeySavedAt;
    writeIntegration(setWorkspaceConsent(integ, req.params.id, cur));
    return publicState(req.params.id);
  });
}
