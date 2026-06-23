import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { paths } from '@guideai/shared/paths';
import { CAPS } from '@guideai/policies/caps';
import { initDbIfMissing } from '@guideai/shared/db';
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

// Self-heal: if the DB file doesn't exist (e.g. user wiped the repo or this
// is a fresh project workspace), run the schema migration before listening so
// the first request doesn't fail with "no such table".
try {
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  initDbIfMissing();
} catch (err) {
  app.log.error({ err }, 'DB init failed — server may return 500 on first query');
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`GuideAI server up on :${PORT} (state: ${paths.home} · db: ${paths.db})`))
  .catch((err) => { app.log.error(err); process.exit(1); });
