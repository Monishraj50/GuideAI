import type { FastifyInstance } from 'fastify';
import {
  detectGhCli, readIntegration, writeIntegration, workspaceConsent, setWorkspaceConsent,
  type GitHubWorkspaceConsent,
} from '@guideai/orchestrator/github';

function publicState(workspaceId: string) {
  const integ = readIntegration();
  const w = workspaceConsent(integ, workspaceId);
  const cli = detectGhCli();
  const ghConnected = !!w.ghCliConnectedAt && cli.detected && cli.authenticated;
  return {
    workspaceId,
    ghCliDetected: cli.detected,
    ghCliVersion: cli.version,
    ghCliBinaryPath: cli.binaryPath,
    ghCliAuthenticated: !!cli.authenticated,
    ghCliLoggedInUser: cli.loggedInUser,
    ghCliAuthError: cli.authError,
    ghConnected,
    ghConnectedAt: w.ghCliConnectedAt,
    patSet: !!w.pat,
    patHint: w.pat ? `…${w.pat.slice(-4)}` : undefined,
    patSavedAt: w.patSavedAt,
    defaultOwner: w.defaultOwner,
    ready: ghConnected || !!w.pat,
  };
}

export function registerGithubIntegrationRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/integrations/github', async (req) => {
    return publicState(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/integrations/github/cli/connect', async (req, reply) => {
    const cli = detectGhCli();
    if (!cli.detected) { reply.code(400); return { error: 'gh CLI not detected on this machine.' }; }
    if (!cli.authenticated) {
      reply.code(400);
      return { error: `gh CLI is installed but not logged in. Run \`gh auth login\` first.${cli.authError ? ' · ' + cli.authError : ''}` };
    }
    const integ = readIntegration();
    const cur = workspaceConsent(integ, req.params.id);
    writeIntegration(setWorkspaceConsent(integ, req.params.id, {
      ...cur,
      ghCliConnectedAt: cur.ghCliConnectedAt ?? Date.now(),
      ghCliVersion: cli.version,
    }));
    return publicState(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/integrations/github/cli/disconnect', async (req) => {
    const integ = readIntegration();
    const cur = workspaceConsent(integ, req.params.id);
    delete cur.ghCliConnectedAt;
    delete cur.ghCliVersion;
    writeIntegration(setWorkspaceConsent(integ, req.params.id, cur));
    return publicState(req.params.id);
  });

  app.put<{ Params: { id: string }; Body: { pat?: string; defaultOwner?: string } }>(
    '/api/workspaces/:id/integrations/github/pat',
    async (req, reply) => {
      const integ = readIntegration();
      const cur = workspaceConsent(integ, req.params.id);
      const next: GitHubWorkspaceConsent = { ...cur };
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
      writeIntegration(setWorkspaceConsent(integ, req.params.id, next));
      return publicState(req.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/workspaces/:id/integrations/github/pat', async (req) => {
    const integ = readIntegration();
    const cur = workspaceConsent(integ, req.params.id);
    delete cur.pat;
    delete cur.patSavedAt;
    writeIntegration(setWorkspaceConsent(integ, req.params.id, cur));
    return publicState(req.params.id);
  });
}
