import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { paths, hasDbPath } from '@guideai/shared/paths';
import { CAPS } from '@guideai/policies/caps';
import { initDb, initDbAt, setWorkspaceContext } from '@guideai/shared/db';
import { sweepStuckTasks } from '@guideai/orchestrator/wbs';
import { resumeBrief } from '@guideai/orchestrator/cos';
import { getDb, schema as dbSchema } from '@guideai/shared/db';
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
// OpenAI + secondOpinion routes deleted in S0 (Claude-only).
import { registerMemoryRoutes } from './routes/memory.js';
import { registerDirectTaskRoutes } from './routes/directTask.js';

const PORT = Number(process.env.PORT ?? 4000);
const app = Fastify({ logger: true });

// Per-request workspace routing. Each request from a VS Code window
// carries `X-Atrune-Workspace: <folder-path>` so `getDb()` returns that
// folder's `<folder>/.atrune/db.sqlite` (per-window isolation without
// running a server per window). If the header is missing the request
// falls back to the env-default DB.
app.addHook('onRequest', async (req) => {
  const hdr = req.headers['x-atrune-workspace'];
  const folder = typeof hdr === 'string' ? hdr.trim() : '';
  if (!folder) return;
  try {
    const dbPath = path.join(folder, '.atrune', 'db.sqlite');
    if (!fs.existsSync(dbPath)) {
      // First touch for this folder — initialise schema. Cheap and idempotent.
      initDbAt(dbPath);
    }
    setWorkspaceContext(folder);
  } catch (err) {
    req.log.warn({ err, folder }, 'failed to attach workspace context');
  }
});

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
// OpenAI + secondOpinion: registrations removed in S0.
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
    // Catch tasks that were left in_progress when the orchestrator died —
    // revert them to 'todo' so the Kanban reflects reality (no agent is
    // actually working on them). Runs once at boot and then every 30s.
    try {
      const boot = sweepStuckTasks(60_000);
      if (boot.reverted.length > 0) {
        app.log.warn(`sweep on boot: reverted ${boot.reverted.length} stuck in_progress task(s) to 'todo'`);
      }
      setInterval(() => {
        try {
          const r = sweepStuckTasks(60_000);
          if (r.reverted.length > 0) {
            app.log.warn(`periodic sweep: reverted ${r.reverted.length} stuck task(s)`);
          }
        } catch (err) { app.log.error({ err }, 'periodic sweep failed'); }
      }, 30_000).unref();
      // Auto-resume any brief whose pipeline died with the orchestrator
      // (server restart, crash). Without this the brief is just frozen and
      // the user sees tasks slide back from in_progress → todo with no agent
      // picking them up. resumeBrief skips phases whose artifact is on
      // disk, so completed work isn't repeated.
      try {
        const db = getDb();
        const activeBriefs = db.select().from(dbSchema.briefs).all()
          .filter((b) => b.status === 'active');
        const allItems = db.select().from(dbSchema.workItems).all();
        for (const b of activeBriefs) {
          const items = allItems.filter((r) => r.briefId === b.id);
          const hasOpen = items.some((r) => r.status === 'todo' || r.status === 'in_progress' || r.status === 'blocked');
          if (!hasOpen) continue;
          // Fire-and-forget; runPipeline is itself fire-and-forget so this
          // returns quickly and lets the server finish booting.
          void resumeBrief(b.id).then((r) => {
            if (r.ok) app.log.info(`auto-resume on boot: ${b.id}`);
          }).catch((err) => app.log.warn({ err }, `auto-resume failed for ${b.id}`));
        }
      } catch (err) {
        app.log.warn({ err }, 'boot-time auto-resume scan failed');
      }
    } catch (err) {
      app.log.error({ err }, 'stuck-task sweep failed to start');
    }
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
