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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_briefs_workspace ON briefs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_brief ON tasks(brief_id);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_metrics_agent ON metric_snapshots(agent_id);
`;

function main() {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.workspaces, { recursive: true });
  fs.mkdirSync(paths.skills, { recursive: true });
  fs.mkdirSync(paths.agentsCustom, { recursive: true });

  const db = new Database(paths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  db.close();

  console.log(`[init-db] ready at ${paths.db}`);
}

main();
