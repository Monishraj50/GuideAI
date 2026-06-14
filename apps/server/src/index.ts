import Fastify from 'fastify';
import { paths } from '@guideai/shared/paths';
import { CAPS } from '@guideai/policies/caps';
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
import { registerAuthRoutes } from './routes/auth.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerBudgetRoutes } from './routes/budget.js';
import { registerIntakeRoutes } from './routes/intake.js';

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
registerAuthRoutes(app);
registerIntegrationRoutes(app);
registerPermissionRoutes(app);
registerChannelRoutes(app);
registerBudgetRoutes(app);
registerIntakeRoutes(app);

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`GuideAI server up on :${PORT} (state: ${paths.home})`))
  .catch((err) => { app.log.error(err); process.exit(1); });
