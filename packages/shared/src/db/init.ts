import fs from 'node:fs';
import Database from 'better-sqlite3';
import { paths } from '../paths.js';

// One-shot DB initializer: creates ~/.guideai/, the sqlite file, and all tables.
// Idempotent — safe to re-run.

const DDL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  autonomy_mode TEXT NOT NULL DEFAULT 'approval-gated',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  system_prompt TEXT NOT NULL,
  tool_whitelist TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  agent_id TEXT REFERENCES agents(id),
  phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  artifact_path TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  rule_id TEXT,
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  source_task_id TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  win_rate REAL NOT NULL DEFAULT 0,
  avg_time_to_merge REAL,
  rework_count INTEGER NOT NULL DEFAULT 0,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  usd_spent REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  brief_id TEXT,
  phase TEXT,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ws_ts ON usage_log(workspace_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_brief ON usage_log(brief_id);

CREATE TABLE IF NOT EXISTS workspace_budgets (
  workspace_id TEXT PRIMARY KEY,
  daily_usd_cap REAL,
  monthly_usd_cap REAL,
  tokens_per_5h_cap INTEGER,
  behavior TEXT NOT NULL DEFAULT 'downgrade',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_intakes (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  goal TEXT NOT NULL DEFAULT '',
  success_criteria TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  constraints TEXT NOT NULL DEFAULT '[]',       -- JSON string[]
  budget_hint_usd REAL,
  planning_mode TEXT NOT NULL DEFAULT 'assisted',  -- auto|assisted|manual
  hire_mode TEXT NOT NULL DEFAULT 'manual',        -- auto|manual|hybrid
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discoveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL DEFAULT 'running',   -- running|done|failed
  panel_json TEXT NOT NULL DEFAULT '[]',    -- per-panelist [{role,displayName,text,tokensIn,tokensOut}]
  synthesis_json TEXT,                       -- {recommendedRoles[],riskFlags[],successMetrics[],costEstimateUsd,verdict}
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_discoveries_workspace ON discoveries(workspace_id);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  discovery_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|approved|dispatched|rejected
  edited_synthesis_json TEXT NOT NULL,
  notes TEXT,
  brief_id TEXT,
  hire_summary_json TEXT,                  -- {hired:[...], queued:[...], skipped:[...]}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  dispatched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_discovery ON plans(discovery_id);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  brief_id TEXT,
  plan_id TEXT,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  assigned_role TEXT,                          -- catalog role or alias
  assigned_agent_id TEXT,                      -- resolved agent if hired
  phase TEXT,                                  -- research|plan|implement|review|verify|other
  status TEXT NOT NULL DEFAULT 'todo',         -- todo|in_progress|blocked|done|cancelled
  priority TEXT NOT NULL DEFAULT 'normal',     -- low|normal|high|critical
  estimate_hours REAL,
  position INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',         -- auto|manual — where it came from
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_work_items_workspace ON work_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_work_items_brief ON work_items(brief_id);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  brief_id TEXT,
  kind TEXT NOT NULL,                   -- artifact|slide-deck|explainer|link|file
  title TEXT NOT NULL,
  body TEXT,                            -- markdown for artifact/deck/explainer; null for link/file
  uri TEXT,                             -- file path or URL
  source TEXT NOT NULL DEFAULT 'auto',  -- auto|manual
  phase TEXT,                           -- only set for kind=artifact
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliverables_workspace ON deliverables(workspace_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_brief ON deliverables(brief_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_kind ON deliverables(kind);

CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual|auto
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_role ON agent_memory(role);
CREATE INDEX IF NOT EXISTS idx_agent_memory_workspace ON agent_memory(source_workspace_id);

CREATE TABLE IF NOT EXISTS design_picks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  brief_id TEXT,
  picked_deliverable_id TEXT NOT NULL,
  rejected_deliverable_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_picks_workspace ON design_picks(workspace_id);

CREATE TABLE IF NOT EXISTS validation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  brief_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',     -- running|pass|fail|error|skipped
  target_url TEXT NOT NULL,
  script_json TEXT NOT NULL,                   -- the persisted Playwright-lite script
  report_json TEXT,                            -- {steps: [...], summary: {...}}
  screenshots_dir TEXT,
  source TEXT NOT NULL DEFAULT 'auto',         -- auto|manual|rerun
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_runs_workspace ON validation_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_validation_runs_brief ON validation_runs(brief_id);

CREATE TABLE IF NOT EXISTS workspace_repos (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',     -- github only for now; placeholder for gitlab/bitbucket
  visibility TEXT NOT NULL DEFAULT 'private',  -- private|public
  default_branch TEXT NOT NULL DEFAULT 'main',
  html_url TEXT,
  linked_at INTEGER NOT NULL,
  last_pushed_at INTEGER,
  last_sync_at INTEGER
);


CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_briefs_workspace ON briefs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_brief ON tasks(brief_id);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_metrics_agent ON metric_snapshots(agent_id);
`;

/** Idempotent: run the DDL + ALTER ADD COLUMN backfills against the
 *  currently-resolved DB path. Safe to call from the server on startup. */
export function initDb(): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.workspaces, { recursive: true });
  fs.mkdirSync(paths.skills, { recursive: true });
  fs.mkdirSync(paths.agentsCustom, { recursive: true });

  const db = new Database(paths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);

  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch (e: any) {
      if (!/duplicate column/i.test(String(e?.message ?? ''))) throw e;
    }
  }

  db.close();
}

/** Cheap startup check: only run the full DDL if the DB file is missing or
 *  empty. (initDb is idempotent but reads/writes; this short-circuits the
 *  common case.) */
export function initDbIfMissing(): void {
  let needsInit = false;
  try {
    const st = fs.statSync(paths.db);
    needsInit = st.size === 0;
  } catch {
    needsInit = true;
  }
  if (needsInit) initDb();
}

const MIGRATIONS = [
  "ALTER TABLE work_items ADD COLUMN github_issue_number INTEGER",
  "ALTER TABLE work_items ADD COLUMN github_issue_url TEXT",
  "ALTER TABLE plans ADD COLUMN critiques_json TEXT",
  "ALTER TABLE plans ADD COLUMN critiques_run_at INTEGER",
  "ALTER TABLE workspaces ADD COLUMN target_url TEXT",
  "ALTER TABLE workspaces ADD COLUMN target_url_allowlist TEXT",
  "ALTER TABLE workspaces ADD COLUMN second_opinion_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE workspaces ADD COLUMN memory_share TEXT NOT NULL DEFAULT 'read-only'",
  "ALTER TABLE project_intakes ADD COLUMN budget_hint_unit TEXT NOT NULL DEFAULT 'USD'",
  "ALTER TABLE project_intakes ADD COLUMN locked INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE project_intakes ADD COLUMN locked_at INTEGER",
  "ALTER TABLE project_intakes ADD COLUMN discovery_context TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE discoveries ADD COLUMN revision_note TEXT",
];

function main() {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.workspaces, { recursive: true });
  fs.mkdirSync(paths.skills, { recursive: true });
  fs.mkdirSync(paths.agentsCustom, { recursive: true });

  const db = new Database(paths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);

  // Idempotent column additions (SQLite ALTER ADD COLUMN errors if the column
  // already exists, so we wrap each one).
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch (e: any) {
      if (!/duplicate column/i.test(String(e?.message ?? ''))) throw e;
    }
  }

  db.close();

  console.log(`[init-db] ready at ${paths.db}`);
}

// Run the standalone migrator only when this file is the entry point
// (pnpm --filter @guideai/shared run init-db). When imported as a module
// (initDb / initDbIfMissing) we don't want to side-effect.
if (process.argv[1] && process.argv[1].endsWith('init.ts')) {
  main();
}
