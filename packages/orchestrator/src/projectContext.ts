// Project-level context files: requirements.md, per-brief analyses, and a
// rolling per-agent summary. These are derived files (no LLM calls — just
// templating from existing intake, brief, and task records) that live on
// disk under the workspace folder and get injected into agent system
// prompts via `readProjectContext`.
//
// Layout under ~/.guideai/workspaces/<id>/:
//
//   requirements.md                     ← project-wide goal + criteria + budget + target folder
//   briefs/<briefId>/
//     analyses/<role>.md                ← what this role contributed to this brief
//   agents/<role>/
//     summary.md                        ← rolling log (every brief appends one line)
//
// Read precedence inside `readProjectContext`:
//   1. requirements.md (always)
//   2. agents/<role>/summary.md (last N lines)
//   3. briefs/*/analyses/<role>.md (newest M)
// Each piece is capped so total injected context stays bounded.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';
import { getDb, schema } from '@guideai/shared/db';
import { readEvents } from '@guideai/messaging/events';
import { loadIntake } from './discovery.js';

/** Workspace meta.json — duplicated locally to avoid an apps→packages dep. */
interface WorkspaceMeta {
  id?: string;
  kind?: 'project' | 'auto-task';
  originatingTask?: string | null;
  targetFolder?: string | null;
}

/** User-readable markdown root: <project>/atrune/ (visible) when a project
 *  folder is configured, sandbox path otherwise. All .md files written here. */
function wsRoot(workspaceId: string): string {
  return paths.workspaceMdDir(workspaceId);
}

function readMeta(workspaceId: string): WorkspaceMeta {
  try {
    const p = path.join(wsRoot(workspaceId), 'meta.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as WorkspaceMeta;
  } catch { return {}; }
}

// ─── requirements.md ─────────────────────────────────────────────────────

/**
 * Write/refresh the project-level requirements.md from intake + meta.
 * Called on: workspace create, workspace PATCH, intake PUT.
 */
export function writeRequirementsMd(workspaceId: string): void {
  const db = getDb();
  const ws = db.select().from(schema.workspaces).all().find((w) => w.id === workspaceId);
  if (!ws) return;

  const intake = loadIntake(workspaceId);
  const meta = readMeta(workspaceId);

  const lines: string[] = [];
  lines.push(`# Project Requirements`);
  lines.push('');
  lines.push(`**Project**: ${ws.name}`);
  lines.push(`**ID**: \`${ws.id}\``);
  if (meta.kind) lines.push(`**Kind**: ${meta.kind}`);
  if (meta.targetFolder) lines.push(`**Target folder**: \`${meta.targetFolder}\``);
  lines.push(`**Created**: ${new Date(ws.createdAt).toISOString()}`);
  lines.push('');

  if (intake) {
    lines.push(`## Goal`);
    lines.push('');
    lines.push(intake.goal.trim() || '_not set yet_');
    lines.push('');

    if (intake.successCriteria.length > 0) {
      lines.push(`## Success criteria`);
      lines.push('');
      for (const c of intake.successCriteria) lines.push(`- ${c}`);
      lines.push('');
    }

    if (intake.constraints.length > 0) {
      lines.push(`## Constraints`);
      lines.push('');
      for (const c of intake.constraints) lines.push(`- ${c}`);
      lines.push('');
    }

    if (intake.budgetHintUsd != null) {
      const unit = intake.budgetHintUnit || 'USD';
      const v = unit === 'tokens'
        ? `${Math.round(intake.budgetHintUsd).toLocaleString()} tokens (${(intake.budgetHintUsd / 1000).toFixed(0)}k)`
        : `${intake.budgetHintUsd} ${unit}`;
      lines.push(`## Budget`);
      lines.push('');
      lines.push(`Soft cap: ${v}`);
      lines.push('');
    }

    lines.push(`## Modes`);
    lines.push('');
    lines.push(`- Planning: \`${intake.planningMode}\``);
    lines.push(`- Hiring:   \`${intake.hireMode}\``);
    lines.push('');
  }

  if (meta.originatingTask) {
    lines.push(`## Originating task`);
    lines.push('');
    lines.push(meta.originatingTask);
    lines.push('');
  }

  const filePath = path.join(wsRoot(workspaceId), 'requirements.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ─── analyses/<role>.md per brief ────────────────────────────────────────

/**
 * Generate per-role analysis files for a completed brief, derived from the
 * `tasks` table + phase artifacts on disk. Template-only, no LLM call.
 */
export function writeBriefAnalyses(workspaceId: string, briefId: string): void {
  const db = getDb();
  const brief = db.select().from(schema.briefs).all().find((b) => b.id === briefId);
  if (!brief) return;

  const tasks = db.select().from(schema.tasks).all().filter((t) => t.briefId === briefId);
  if (tasks.length === 0) return;

  // Bucket tasks by agent.
  const agentsTable = db.select().from(schema.agents).all();
  const agentById = new Map(agentsTable.map((a) => [a.id, a]));
  const byRole = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (!t.agentId) continue;
    const ag = agentById.get(t.agentId);
    if (!ag) continue;
    if (!byRole.has(ag.role)) byRole.set(ag.role, []);
    byRole.get(ag.role)!.push(t);
  }

  const analysesDir = path.join(wsRoot(workspaceId), 'briefs', briefId, 'analyses');
  fs.mkdirSync(analysesDir, { recursive: true });

  for (const [role, roleTasks] of byRole) {
    const totalIn = roleTasks.reduce((s, t) => s + (t.tokensIn ?? 0), 0);
    const totalOut = roleTasks.reduce((s, t) => s + (t.tokensOut ?? 0), 0);
    const completed = roleTasks.filter((t) => t.status === 'done').length;
    const failed = roleTasks.filter((t) => t.status === 'failed').length;
    const phases = Array.from(new Set(roleTasks.map((t) => t.phase))).filter(Boolean);

    const lines: string[] = [];
    lines.push(`# Analysis · ${role}`);
    lines.push('');
    lines.push(`**Brief**: \`${briefId}\``);
    lines.push(`**Goal**: ${brief.body.split('\n')[0]?.slice(0, 120) ?? '(empty)'}`);
    lines.push(`**Completed**: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`## Contributions`);
    lines.push('');
    lines.push(`- Phases: ${phases.join(', ') || 'none'}`);
    lines.push(`- Tasks done: ${completed}${failed ? ` (failed: ${failed})` : ''}`);
    lines.push(`- Tokens: ${totalIn.toLocaleString()}↓ / ${totalOut.toLocaleString()}↑`);
    lines.push('');

    // Pull a one-line snippet from each phase artifact this role touched.
    lines.push(`## Phase notes`);
    lines.push('');
    for (const task of roleTasks) {
      const artifactPath = task.artifactPath;
      if (!artifactPath) continue;
      try {
        const snippet = fs.readFileSync(artifactPath, 'utf-8')
          .split('\n').slice(0, 3).join(' ').slice(0, 240);
        lines.push(`- **${task.phase}** — ${snippet}…`);
      } catch {}
    }
    lines.push('');

    const filePath = path.join(analysesDir, `${role}.md`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  }
}

// ─── briefs/<briefId>/chat.md (per-feature session transcript) ──────────

/**
 * Persist a clean chat-style transcript of a brief's session.
 *
 * Format: standard markdown. User prompts and agent responses become
 * `## You` / `## <agent>` sections; tool calls become inline `> ⚒ …` pills
 * placed between turns. Infrastructure noise (system/phase/approval chunks)
 * is omitted from the transcript — they're visible in the raw event stream
 * for anyone who wants them.
 *
 * Written at brief completion. Read by the VS Code extension when the user
 * clicks a task and wants to see the saved session.
 */
export async function writeBriefChat(workspaceId: string, briefId: string): Promise<void> {
  const db = getDb();
  const brief = db.select().from(schema.briefs).all().find((b) => b.id === briefId);
  if (!brief) return;

  const tasks = db.select().from(schema.tasks).all().filter((t) => t.briefId === briefId);
  const agentsTable = db.select().from(schema.agents).all();
  const agentById = new Map(agentsTable.map((a) => [a.id, a]));

  // Read all events in the brief's time window, then keep only user / ai
  // / tool chunks. System / phase / approval are infrastructure — saved
  // elsewhere via the raw events.jsonl, no need to duplicate.
  const startTs = brief.createdAt;
  const endTs = tasks.reduce((m, t) => Math.max(m, t.endedAt ?? t.startedAt ?? 0), startTs) || Date.now();
  const { chunks } = await readEvents(workspaceId, { sinceTs: Math.max(0, startTs - 1000) });
  const relevant = chunks.filter((c) =>
    c.ts <= endTs + 2000 && (c.kind === 'user' || c.kind === 'ai' || c.kind === 'tool'),
  );

  const lines: string[] = [];
  lines.push(`# ${brief.body.split('\n')[0]?.slice(0, 120) ?? briefId}`);
  lines.push('');
  lines.push(`**Brief**: \`${briefId}\``);
  lines.push(`**Started**: ${new Date(brief.createdAt).toISOString()}`);
  lines.push(`**Ended**: ${new Date(endTs).toISOString()}`);
  lines.push('');
  const phaseList = Array.from(new Set(tasks.map((t) => t.phase))).filter(Boolean).join(' · ');
  if (phaseList) {
    lines.push(`**Phases**: ${phaseList}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  let pendingTools: typeof relevant = [];

  function flushTools() {
    if (pendingTools.length === 0) return;
    for (const t of pendingTools) {
      const inp = (t as any).toolInput ?? {};
      const summary =
        (t as any).toolName === 'Bash'
          ? String(inp.command ?? inp.cmd ?? '').slice(0, 80)
          : String(inp.file_path ?? inp.path ?? inp.url ?? inp.pattern ?? '').slice(0, 80);
      lines.push(`> ⚒ **${(t as any).toolName ?? 'tool'}**${summary ? ` · \`${summary}\`` : ''}`);
    }
    lines.push('');
    pendingTools = [];
  }

  for (const c of relevant) {
    if (c.kind === 'tool') {
      pendingTools.push(c);
      continue;
    }
    flushTools();

    if (c.kind === 'user') {
      lines.push(`## You`);
      lines.push('');
      lines.push((c as any).text?.trim() || '(empty)');
      lines.push('');
      lines.push('---');
      lines.push('');
    } else if (c.kind === 'ai') {
      const agent = (c as any).agentId ? agentById.get((c as any).agentId) : null;
      const speaker = agent ? `${agent.displayName} · ${agent.role}` : ((c as any).agentId ?? 'agent');
      lines.push(`## ${speaker}`);
      lines.push('');
      lines.push((c as any).text?.trim() || '_(no response captured)_');
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }
  flushTools();

  // Trailing summary block.
  const totalIn = tasks.reduce((s, t) => s + (t.tokensIn ?? 0), 0);
  const totalOut = tasks.reduce((s, t) => s + (t.tokensOut ?? 0), 0);
  lines.push(`## Session summary`);
  lines.push('');
  lines.push(`- Tasks: ${tasks.length}`);
  lines.push(`- Tokens: ${totalIn.toLocaleString()}↓ / ${totalOut.toLocaleString()}↑`);
  lines.push('');

  const filePath = path.join(wsRoot(workspaceId), 'briefs', briefId, 'chat.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

/** Compute the on-disk path for a brief's chat.md — used by the VS Code
 *  extension when it wants to open the saved session. */
export function briefChatPath(workspaceId: string, briefId: string): string {
  return path.join(wsRoot(workspaceId), 'briefs', briefId, 'chat.md');
}

// ─── agents/<role>/summary.md (rolling) ───────────────────────────────────

/**
 * Append a one-line entry to a role's rolling summary log.
 * Called on brief completion (or task completion). Bounded to last 50 lines
 * on read; file itself can grow but readers cap.
 */
export function appendAgentSummary(args: {
  workspaceId: string;
  role: string;
  briefId: string;
  briefTitle: string;
  tokensIn: number;
  tokensOut: number;
  tasksDone: number;
  tasksFailed: number;
}): void {
  const summaryDir = path.join(wsRoot(args.workspaceId), 'agents', args.role);
  fs.mkdirSync(summaryDir, { recursive: true });
  const summaryPath = path.join(summaryDir, 'summary.md');

  if (!fs.existsSync(summaryPath)) {
    fs.writeFileSync(summaryPath, `# ${args.role} · activity log\n\nOne row per brief this role contributed to.\n\n`, 'utf-8');
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const title = args.briefTitle.replace(/\n/g, ' ').slice(0, 80);
  const failSuffix = args.tasksFailed > 0 ? ` (failed: ${args.tasksFailed})` : '';
  const line = `- **${stamp}** · \`${args.briefId.slice(-6)}\` · ${title} · ${args.tasksDone} task${args.tasksDone !== 1 ? 's' : ''}${failSuffix} · ${args.tokensIn}↓/${args.tokensOut}↑\n`;
  fs.appendFileSync(summaryPath, line, 'utf-8');
}

// ─── read bundle (injected into system prompt) ────────────────────────────

/**
 * Read the project-context bundle for a given role + workspace. Bounded so
 * the returned markdown stays under ~3KB even on big projects.
 *
 * Returns an empty string when the workspace has no requirements.md yet.
 */
export function readProjectContext(args: {
  workspaceId: string;
  role: string;
  maxChars?: number;
}): string {
  const maxChars = args.maxChars ?? 3000;
  const parts: string[] = [];

  // 1. requirements.md (always, full)
  try {
    const p = path.join(wsRoot(args.workspaceId), 'requirements.md');
    if (fs.existsSync(p)) {
      parts.push(fs.readFileSync(p, 'utf-8').trim());
    }
  } catch {}

  // 2. role-specific rolling summary (last 10 lines)
  try {
    const p = path.join(wsRoot(args.workspaceId), 'agents', args.role, 'summary.md');
    if (fs.existsSync(p)) {
      const all = fs.readFileSync(p, 'utf-8').split('\n');
      const tail = all.slice(-12).join('\n').trim();
      if (tail) {
        parts.push(`## Your recent work in this workspace\n\n${tail}`);
      }
    }
  } catch {}

  // 3. role's analyses from previous briefs (newest 2)
  try {
    const briefsDir = path.join(wsRoot(args.workspaceId), 'briefs');
    if (fs.existsSync(briefsDir)) {
      const briefIds = fs.readdirSync(briefsDir)
        .filter((d) => fs.statSync(path.join(briefsDir, d)).isDirectory())
        .sort((a, b) => fs.statSync(path.join(briefsDir, b)).mtimeMs - fs.statSync(path.join(briefsDir, a)).mtimeMs);
      let included = 0;
      for (const id of briefIds) {
        if (included >= 2) break;
        const ap = path.join(briefsDir, id, 'analyses', `${args.role}.md`);
        if (fs.existsSync(ap)) {
          const body = fs.readFileSync(ap, 'utf-8').trim();
          parts.push(`## Past analysis · brief \`${id.slice(-6)}\`\n\n${body}`);
          included++;
        }
      }
    }
  } catch {}

  if (parts.length === 0) return '';
  const joined = parts.join('\n\n---\n\n');
  return joined.length > maxChars ? joined.slice(0, maxChars - 3) + '…' : joined;
}

/**
 * Phase F — read the N most-recent per-task chat-history transcripts for a role
 * so the agent has prior conversation context on every new task. Files are
 * append-only Markdown written by `transcriptWriter.writeTaskTranscript` at
 * `<mdRoot>/agents/<role>/sessions/<taskId>.md`.
 *
 * Each transcript is truncated to its last `tailLines` lines (default 150) —
 * the head is the system prompt + first turn, which is rarely the most
 * useful context. The tail tends to have the resolution or the last
 * known-good state.
 *
 * Returns an empty string when there are no transcripts yet.
 */
export function readRecentSessions(args: {
  workspaceId: string;
  role: string;
  /** How many transcripts to include. Default 3. */
  limit?: number;
  /** Last N lines per transcript. Default 150. */
  tailLines?: number;
  /** Hard cap on the rendered block. Default 3000 chars. */
  maxChars?: number;
}): string {
  const limit = args.limit ?? 3;
  const tailLines = args.tailLines ?? 150;
  const maxChars = args.maxChars ?? 3000;
  const dir = path.join(wsRoot(args.workspaceId), 'agents', args.role, 'sessions');
  try {
    if (!fs.existsSync(dir)) return '';
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    if (files.length === 0) return '';

    const parts: string[] = ['## Recent task transcripts (' + args.role + ')'];
    for (const { f } of files) {
      const taskId = f.replace(/\.md$/, '');
      const all = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n');
      const tail = all.slice(-tailLines).join('\n').trim();
      if (!tail) continue;
      parts.push(`### Task \`${taskId}\`\n\n${tail}`);
    }
    const joined = parts.join('\n\n');
    return joined.length > maxChars ? joined.slice(0, maxChars - 3) + '…' : joined;
  } catch {
    return '';
  }
}
