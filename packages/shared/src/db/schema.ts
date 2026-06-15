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

export const projectIntakes = sqliteTable('project_intakes', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id),
  goal: text('goal').notNull().default(''),
  successCriteria: text('success_criteria').notNull().default('[]'),
  constraints: text('constraints').notNull().default('[]'),
  budgetHintUsd: real('budget_hint_usd'),
  planningMode: text('planning_mode').notNull().default('assisted'),  // auto|assisted|manual
  hireMode: text('hire_mode').notNull().default('manual'),            // auto|manual|hybrid
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  discoveryId: text('discovery_id'),
  status: text('status').notNull().default('draft'),  // draft|approved|dispatched|rejected
  editedSynthesisJson: text('edited_synthesis_json').notNull(),
  notes: text('notes'),
  briefId: text('brief_id'),
  hireSummaryJson: text('hire_summary_json'),
  critiquesJson: text('critiques_json'),
  critiquesRunAt: integer('critiques_run_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  approvedAt: integer('approved_at'),
  dispatchedAt: integer('dispatched_at'),
});

export const deliverables = sqliteTable('deliverables', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  briefId: text('brief_id'),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  uri: text('uri'),
  source: text('source').notNull().default('auto'),
  phase: text('phase'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const workItems = sqliteTable('work_items', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  briefId: text('brief_id'),
  planId: text('plan_id'),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  description: text('description'),
  assignedRole: text('assigned_role'),
  assignedAgentId: text('assigned_agent_id'),
  phase: text('phase'),
  status: text('status').notNull().default('todo'),
  priority: text('priority').notNull().default('normal'),
  estimateHours: real('estimate_hours'),
  position: integer('position').notNull().default(0),
  source: text('source').notNull().default('auto'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  githubIssueNumber: integer('github_issue_number'),
  githubIssueUrl: text('github_issue_url'),
});

export const workspaceRepos = sqliteTable('workspace_repos', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  provider: text('provider').notNull().default('github'),
  visibility: text('visibility').notNull().default('private'),
  defaultBranch: text('default_branch').notNull().default('main'),
  htmlUrl: text('html_url'),
  linkedAt: integer('linked_at').notNull(),
  lastPushedAt: integer('last_pushed_at'),
  lastSyncAt: integer('last_sync_at'),
});

export const discoveries = sqliteTable('discoveries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  status: text('status').notNull().default('running'),
  panelJson: text('panel_json').notNull().default('[]'),
  synthesisJson: text('synthesis_json'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
});
