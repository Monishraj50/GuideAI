import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paths } from '@guideai/shared/paths';
import {
  detectGhCli, readIntegration, writeIntegration, userConsent, setUserConsent,
  type GitHubUserConsent,
} from '@guideai/orchestrator/github';

const SESSION_FILE = path.join(paths.home, 'session.json');

function currentUsername(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return typeof j?.username === 'string' ? j.username : null;
  } catch { return null; }
}

function publicState(username: string | null) {
  const integ = readIntegration();
  const u = username ? userConsent(integ, username) : ({} as GitHubUserConsent);
  const cli = detectGhCli();
  const ghConnected = !!u.ghCliConnectedAt && cli.detected && cli.authenticated;
  return {
    username,
    ghCliDetected: cli.detected,
    ghCliVersion: cli.version,
    ghCliBinaryPath: cli.binaryPath,
    ghCliAuthenticated: !!cli.authenticated,
    ghCliLoggedInUser: cli.loggedInUser,
    ghCliAuthError: cli.authError,
    ghConnected,
    ghConnectedAt: u.ghCliConnectedAt,
    patSet: !!u.pat,
    patHint: u.pat ? `…${u.pat.slice(-4)}` : undefined,
    patSavedAt: u.patSavedAt,
    defaultOwner: u.defaultOwner,
    ready: ghConnected || !!u.pat,
  };
}

function requireUser(reply: any): string | null {
  const u = currentUsername();
  if (!u) { reply.code(401); return null; }
  return u;
}

export function registerGithubIntegrationRoutes(app: FastifyInstance) {
  app.get('/api/integrations/github', async (_req, reply) => {
    const u = currentUsername();
    if (!u) { reply.code(401); return { error: 'sign-in required' }; }
    return publicState(u);
  });

  app.post('/api/integrations/github/cli/connect', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const cli = detectGhCli();
    if (!cli.detected) { reply.code(400); return { error: 'gh CLI not detected on this machine.' }; }
    if (!cli.authenticated) {
      reply.code(400);
      return { error: `gh CLI is installed but not logged in. Run \`gh auth login\` first.${cli.authError ? ' · ' + cli.authError : ''}` };
    }
    const integ = readIntegration();
    const cur = userConsent(integ, username);
    writeIntegration(setUserConsent(integ, username, {
      ...cur,
      ghCliConnectedAt: cur.ghCliConnectedAt ?? Date.now(),
      ghCliVersion: cli.version,
    }));
    return publicState(username);
  });

  app.post('/api/integrations/github/cli/disconnect', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const integ = readIntegration();
    const cur = userConsent(integ, username);
    delete cur.ghCliConnectedAt;
    delete cur.ghCliVersion;
    writeIntegration(setUserConsent(integ, username, cur));
    return publicState(username);
  });

  app.put<{ Body: { pat?: string; defaultOwner?: string } }>(
    '/api/integrations/github/pat',
    async (req, reply) => {
      const username = requireUser(reply);
      if (!username) return { error: 'sign-in required' };
      const integ = readIntegration();
      const cur = userConsent(integ, username);
      const next: GitHubUserConsent = { ...cur };
      if (req.body?.pat !== undefined) {
        const pat = req.body.pat.toString().trim();
        if (!pat) { reply.code(400); return { error: 'pat cannot be empty (use DELETE to clear)' }; }
        next.pat = pat;
        next.patSavedAt = Date.now();
      }
      if (req.body?.defaultOwner !== undefined) {
        const o = req.body.defaultOwner.toString().trim();
        next.defaultOwner = o || undefined;
      }
      writeIntegration(setUserConsent(integ, username, next));
      return publicState(username);
    },
  );

  app.delete('/api/integrations/github/pat', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const integ = readIntegration();
    const cur = userConsent(integ, username);
    delete cur.pat;
    delete cur.patSavedAt;
    writeIntegration(setUserConsent(integ, username, cur));
    return publicState(username);
  });
}
