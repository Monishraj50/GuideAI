import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paths } from '@guideai/shared/paths';
import {
  readIntegration, writeIntegration, userConsent, setUserConsent,
  type OpenAIUserConsent,
} from '@guideai/runtime-openai';

const SESSION_FILE = path.join(paths.home, 'session.json');

function currentUsername(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return typeof j?.username === 'string' ? j.username : null;
  } catch { return null; }
}
function requireUser(reply: any): string | null {
  const u = currentUsername();
  if (!u) { reply.code(401); return null; }
  return u;
}

function publicState(username: string | null) {
  const u = username ? userConsent(readIntegration(), username) : ({} as OpenAIUserConsent);
  return {
    username,
    apiKeySet: !!u.apiKey,
    apiKeyHint: u.apiKey ? `…${u.apiKey.slice(-4)}` : undefined,
    apiKeySavedAt: u.apiKeySavedAt,
    modelOverrides: u.modelOverrides ?? {},
    ready: !!u.apiKey,
  };
}

export function registerOpenAIIntegrationRoutes(app: FastifyInstance) {
  app.get('/api/integrations/openai', async (_req, reply) => {
    const u = currentUsername();
    if (!u) { reply.code(401); return { error: 'sign-in required' }; }
    return publicState(u);
  });

  app.put<{ Body: { apiKey?: string; modelOverrides?: OpenAIUserConsent['modelOverrides'] } }>(
    '/api/integrations/openai',
    async (req, reply) => {
      const username = requireUser(reply);
      if (!username) return { error: 'sign-in required' };
      const integ = readIntegration();
      const cur = userConsent(integ, username);
      const next: OpenAIUserConsent = { ...cur };
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
      writeIntegration(setUserConsent(integ, username, next));
      return publicState(username);
    },
  );

  app.delete('/api/integrations/openai', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const integ = readIntegration();
    const cur = userConsent(integ, username);
    delete cur.apiKey;
    delete cur.apiKeySavedAt;
    writeIntegration(setUserConsent(integ, username, cur));
    return publicState(username);
  });
}
