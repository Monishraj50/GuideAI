import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  autonomyMode: text('autonomy_mode').notNull().default('approval-gated'),
  createdAt: integer('created_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  role: text('role').notNull(),           // e.g. backend-developer
  displayName: text('display_name').notNull(),
  runtime: text('runtime').notNull().default('claude'),
  model: text('model'),                   // null => router decides per phase
  systemPrompt: text('system_prompt').notNull(),
  toolWhitelist: text('tool_whitelist').notNull().default('[]'),  // JSON array
  status: text('status').notNull().default('idle'),  // idle|working|paused|retired
  createdAt: integer('created_at').notNull(),
});

export const briefs = sqliteTable('briefs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  body: text('body').notNull(),
  status: text('status').notNull().default('pending'),  // pending|active|done|cancelled
  createdAt: integer('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  briefId: text('brief_id').notNull().references(() => briefs.id),
  agentId: text('agent_id').references(() => agents.id),
  phase: text('phase').notNull(),         // research|plan|implement|review|verify
  status: text('status').notNull().default('pending'),
  artifactPath: text('artifact_path'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasks.id),
  tool: text('tool').notNull(),
  argsJson: text('args_json').notNull(),
  decision: text('decision').notNull(),   // approved|denied|auto-approved
  ruleId: text('rule_id'),
  decidedBy: text('decided_by').notNull(),  // 'user' | 'rule:<id>'
  decidedAt: integer('decided_at').notNull(),
});

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  body: text('body').notNull(),
  sourceTaskId: text('source_task_id'),
  uses: integer('uses').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const metricSnapshots = sqliteTable('metric_snapshots', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  windowStart: integer('window_start').notNull(),
  windowEnd: integer('window_end').notNull(),
  tasksCompleted: integer('tasks_completed').notNull().default(0),
  winRate: real('win_rate').notNull().default(0),
  avgTimeToMerge: real('avg_time_to_merge'),
  reworkCount: integer('rework_count').notNull().default(0),
  tokensSpent: integer('tokens_spent').notNull().default(0),
  usdSpent: real('usd_spent').notNull().default(0),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  salt: text('salt').notNull(),
  displayName: text('display_name'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const usageLog = sqliteTable('usage_log', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  agentId: text('agent_id'),
  briefId: text('brief_id'),
  phase: text('phase'),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  ts: integer('ts').notNull(),
});

export const workspaceBudgets = sqliteTable('workspace_budgets', {
  workspaceId: text('workspace_id').primaryKey(),
  dailyUsdCap: real('daily_usd_cap'),
  monthlyUsdCap: real('monthly_usd_cap'),
  tokensPer5hCap: integer('tokens_per_5h_cap'),
  behavior: text('behavior').notNull().default('downgrade'),
  updatedAt: integer('updated_at').notNull(),
});
