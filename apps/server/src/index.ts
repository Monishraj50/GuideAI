import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { paths, hasDbPath } from '@guideai/shared/paths';
import { CAPS } from '@guideai/policies/caps';
import { initDb } from '@guideai/shared/db';
import { registerEventRoutes } from './sse.js';
import { registerBriefRoutes } from './routes/briefs.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerMetricRoutes } from './routes/metrics.js';
import { registerDigestRoutes } from './routes/digest.js';
import { registerRuntimeRoutes } from './routes/runtimes.js';
import { registerReplayRoutes } from './routes/replay.js';
import { registerKillswitchRoutes } from './routes/killswitch.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerBudgetRoutes } from './routes/budget.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerPlanRoutes } from './routes/plans.js';
import { registerWorkItemRoutes } from './routes/workItems.js';
import { registerBurndownRoutes } from './routes/burndown.js';
import { registerDeliverableRoutes } from './routes/deliverables.js';
import { registerGithubIntegrationRoutes } from './routes/githubIntegration.js';
import { registerWorkspaceRepoRoutes } from './routes/workspaceRepo.js';
import { registerValidationRoutes } from './routes/validation.js';
import { registerOpenAIIntegrationRoutes } from './routes/openaiIntegration.js';
import { registerSecondOpinionRoutes } from './routes/secondOpinion.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerDirectTaskRoutes } from './routes/directTask.js';

const PORT = Number(process.env.PORT ?? 4000);
const app = Fastify({ logger: true });

app.get('/healthz', async () => ({
  ok: true,
  home: paths.home,
  caps: CAPS,
}));

app.get('/api/caps', async () => CAPS);

registerEventRoutes(app);
registerBriefRoutes(app);
registerApprovalRoutes(app);
registerPolicyRoutes(app);
registerCatalogRoutes(app);
registerMetricRoutes(app);
registerDigestRoutes(app);
registerRuntimeRoutes(app);
registerReplayRoutes(app);
registerKillswitchRoutes(app);
registerAuditRoutes(app);
registerWorkspaceRoutes(app);
registerIntegrationRoutes(app);
registerPermissionRoutes(app);
registerChannelRoutes(app);
registerBudgetRoutes(app);
registerIntakeRoutes(app);
registerPlanRoutes(app);
registerWorkItemRoutes(app);
registerBurndownRoutes(app);
registerDeliverableRoutes(app);
registerGithubIntegrationRoutes(app);
registerWorkspaceRepoRoutes(app);
registerValidationRoutes(app);
registerOpenAIIntegrationRoutes(app);
registerSecondOpinionRoutes(app);
registerMemoryRoutes(app);
registerDirectTaskRoutes(app);

// User-data discipline: this server only writes to ATRUNE_DB_PATH (set by the
// VS Code extension after folder consent). If no path is set, refuse to
// initialize a database — the API endpoints that need persistence will 503
// rather than silently writing to a global fallback location.
if (hasDbPath()) {
  try {
    fs.mkdirSync(path.dirname(paths.db), { recursive: true });
    initDb();
    app.log.info(`DB ready at ${paths.db}`);
  } catch (err) {
    app.log.error({ err }, 'DB init failed — server may return 500 on first query');
  }
} else {
  app.log.warn(
    'No ATRUNE_DB_PATH set. Server starting in NO-STORAGE mode — data routes will 503. ' +
    'Grant folder consent in the extension to enable storage.',
  );
  // Reject DB-dependent routes with a clear error early in the request lifecycle.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url ?? '';
    // Allow infrastructure + integration endpoints (no DB needed).
    const allowed = url.startsWith('/healthz')
      || url.startsWith('/api/caps')
      || url.startsWith('/api/integrations/')
      || url.startsWith('/api/runtimes')
      || url.startsWith('/api/catalog')
      || url.startsWith('/api/permissions');
    if (allowed) return;
    reply.code(503).send({
      error: 'no-storage',
      message: 'Atrune storage is not enabled for this folder. Click "Allow project storage" in the extension sidebar.',
    });
  });
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    const dbInfo = hasDbPath() ? paths.db : '(no storage — awaiting folder consent)';
    app.log.info(`GuideAI server up on :${PORT} (state: ${paths.home} · db: ${dbInfo})`);
  })
  .catch((err) => { app.log.error(err); process.exit(1); });
