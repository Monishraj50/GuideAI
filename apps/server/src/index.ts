import Fastify from 'fastify';
import { paths } from '@guideai/shared/paths';
import { CAPS } from '@guideai/policies/caps';
import { registerEventRoutes } from './sse.js';
import { registerBriefRoutes } from './routes/briefs.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerCatalogRoutes } from './routes/catalog.js';

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

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`GuideAI server up on :${PORT} (state: ${paths.home})`))
  .catch((err) => { app.log.error(err); process.exit(1); });
