// Thin fetch wrapper over the existing Atrune HTTP API. Reuses every route
// the web app already calls; the extension is just another client.

import * as vscode from 'vscode';

export interface WorkspaceSummary {
  id: string;
  name: string;
  autonomyMode: string;
  agents: number;
  pendingApprovals: number;
  activeBriefs: number;
  totalBriefs: number;
  lastBrief: { id: string; body: string; createdAt: number; status: string } | null;
  tokens: number;
  usd: number;
}

export interface PlanResp {
  workspace: { id: string; name: string; autonomyMode: string };
  agents: { active: number; total: number };
  pendingApprovals: { id: string; tool: string; argsJson: string; decidedAt: number; briefId?: string | null }[];
  briefs: {
    recent: {
      id: string; body: string; status: string; createdAt: number;
      tasks: number; tokens: number;
      claudeSessionId?: string | null;
    }[];
    total: number;
    active: number;
  };
  tokens: number;
  /** S13 · split totals for the status-bar formatter. */
  tokensIn?: number;
  tokensOut?: number;
  usd: number;
}

export interface Agent {
  id: string; role: string; displayName: string; status: string;
}

function base(): string {
  const port = vscode.workspace.getConfiguration('atrune').get<number>('serverPort', 4000);
  return `http://localhost:${port}`;
}

export class AtruneApi {
  /** Cheap readiness probe — fast timeout, swallows errors. */
  async isAlive(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 800);
      const r = await fetch(`${base()}/healthz`, { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch { return false; }
  }

  /** Probe the Next.js dev server. Any HTTP response counts as "alive enough"
   *  for the Mission Control iframe to load. */
  async isWebAlive(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const port = vscode.workspace.getConfiguration('atrune').get<number>('webPort', 3000);
      const r = await fetch(`http://localhost:${port}`, { signal: ctl.signal, redirect: 'manual' });
      clearTimeout(t);
      return r.status > 0;
    } catch { return false; }
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const r = await fetch(`${base()}/api/workspaces`);
    if (!r.ok) return [];
    const j = await r.json() as { workspaces: WorkspaceSummary[] };
    return j.workspaces ?? [];
  }

  async getPlan(workspaceId: string): Promise<PlanResp | null> {
    const r = await fetch(`${base()}/api/workspaces/${workspaceId}/plan`);
    if (!r.ok) return null;
    return r.json() as Promise<PlanResp>;
  }

  async listAgents(workspaceId: string): Promise<Agent[]> {
    // Roster lives at /api/workspaces/:id/agents via metrics route surface.
    const plan = await this.getPlan(workspaceId);
    if (!plan) return [];
    // Approximate — fetch full metrics surface for accurate roster.
    const r = await fetch(`${base()}/api/workspaces/${workspaceId}/metrics`);
    if (!r.ok) return [];
    const j = await r.json() as { agents: any[] };
    return (j.agents ?? []).map((a) => ({
      id: a.id, role: a.role ?? '?', displayName: a.displayName ?? a.id,
      status: a.status ?? 'idle',
    }));
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    workspaceId: string,
    opts?: { alwaysAllowSession?: boolean },
  ): Promise<boolean> {
    const r = await fetch(`${base()}/api/approvals/${approvalId}?workspace=${workspaceId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, alwaysAllowSession: opts?.alwaysAllowSession ?? false }),
    });
    return r.ok;
  }

  async getPermissionMode(): Promise<'auto' | 'manual' | 'custom'> {
    try {
      const r = await fetch(`${base()}/api/policies/mode`);
      if (!r.ok) return 'manual';
      const j = await r.json() as { mode: 'auto' | 'manual' | 'custom' };
      return j.mode ?? 'manual';
    } catch { return 'manual'; }
  }

  async setPermissionMode(mode: 'auto' | 'manual' | 'custom'): Promise<boolean> {
    try {
      const r = await fetch(`${base()}/api/policies/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      return r.ok;
    } catch { return false; }
  }

  async getApprovalPreview(approvalId: string): Promise<
    | { kind: 'write'; filePath: string; before: string; after: string }
    | { kind: 'edit'; filePath: string; before: string; after: string; oldString: string; newString: string; replaceAll: boolean }
    | { kind: 'none'; tool: string }
    | null
  > {
    try {
      const r = await fetch(`${base()}/api/approvals/${approvalId}/preview`);
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  async getPolicies(): Promise<PoliciesSnapshot | null> {
    try {
      const r = await fetch(`${base()}/api/policies`);
      if (!r.ok) return null;
      return await r.json() as PoliciesSnapshot;
    } catch { return null; }
  }

  async addPolicyRule(rule: {
    id: string; description: string; action: 'auto-approve' | 'always-ask' | 'deny';
    match: { tool: string; argsPattern?: string };
  }): Promise<boolean> {
    try {
      const r = await fetch(`${base()}/api/policies/rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rule),
      });
      return r.ok;
    } catch { return false; }
  }

  async deletePolicyRule(ruleId: string): Promise<boolean> {
    try {
      const r = await fetch(`${base()}/api/policies/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
      return r.ok;
    } catch { return false; }
  }

  async getSessionAllow(workspaceId: string): Promise<string[]> {
    try {
      const r = await fetch(`${base()}/api/policies/session-allow?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (!r.ok) return [];
      const j = await r.json() as { keys: string[] };
      return j.keys ?? [];
    } catch { return []; }
  }

  /** S13 · list every loaded skill (all sources). Used by the Skills & Packs sidebar. */
  async listSkills(): Promise<{
    count: number;
    skills: Array<{ name: string; description: string; appliesTo: string[]; keywords: string[]; source: string }>;
  }> {
    try {
      const r = await fetch(`${base()}/api/skills`);
      if (!r.ok) return { count: 0, skills: [] };
      return await r.json() as any;
    } catch { return { count: 0, skills: [] }; }
  }

  /** S12 · list installed skill/agent packs. */
  async listPacks(): Promise<{
    count: number;
    packs: Array<{
      name: string; version: string; description: string | null;
      tags: string[]; skillCount: number; installedAt: number;
      hasMissingReqs: boolean; missing: string[];
    }>;
  }> {
    try {
      const r = await fetch(`${base()}/api/packs`);
      if (!r.ok) return { count: 0, packs: [] };
      return await r.json() as any;
    } catch { return { count: 0, packs: [] }; }
  }

  async installPack(args: { fromPath?: string; fromGitUrl?: string; force?: boolean }): Promise<
    { ok: boolean; name?: string; version?: string; skillCount?: number; hasMissingReqs?: boolean; missing?: string[]; error?: string }
  > {
    try {
      const r = await fetch(`${base()}/api/packs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, ...j };
    } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
  }

  async uninstallPack(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/packs/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { ok: false, error: (j as any)?.error ?? `http ${r.status}` }; }
      return { ok: true };
    } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
  }

  /** Plan editor · list briefs currently paused at PLAN_APPROVED_GATE. */
  async listPendingPlanReviews(): Promise<Array<{
    id: string; workspaceId: string; body: string;
    status: string; planGateState: string; model: string;
  }>> {
    try {
      const r = await fetch(`${base()}/api/briefs/pending-plan-review`);
      if (!r.ok) return [];
      const j = await r.json() as any;
      return Array.isArray(j?.briefs) ? j.briefs : [];
    } catch { return []; }
  }

  /** Plan editor · fetch the plan.md body + brief context for the editor. */
  async getBriefPlan(briefId: string): Promise<{
    briefId: string; workspaceId: string; body: string;
    status: string; planGateState: string | null; model: string; planBody: string;
  } | null> {
    try {
      const r = await fetch(`${base()}/api/briefs/${briefId}/plan`);
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  /** S9 · fetch hunk-level diff for a completed work_item vs its baseGitRef. */
  async getWorkItemDiff(workItemId: string): Promise<{
    files: Array<{
      file: string; oldPath: string; newPath: string; binary: boolean;
      hunks: Array<{ id: string; file: string; header: string; body: string; binary: boolean; addedLines: number; removedLines: number }>;
    }>;
    hunkCount?: number;
    reason?: string;
  } | null> {
    try {
      const r = await fetch(`${base()}/api/work-items/${workItemId}/diff`);
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  async applyWorkItemDiff(args: {
    workItemId: string; acceptedHunkIds: string[]; note?: string;
  }): Promise<{
    ok: boolean;
    applied: string[]; reverted: string[]; failed: Array<{ hunkId: string; error: string }>;
    outcome: 'shipped' | 'partial' | 'abandoned';
    followupWorkItemId: string | null;
  } | null> {
    try {
      const r = await fetch(`${base()}/api/work-items/${args.workItemId}/diff/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acceptedHunkIds: args.acceptedHunkIds, note: args.note }),
      });
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  /** S7 · sessions grouped by feature slug for the tree view + resume Quick Pick. */
  async listSessionsByFeature(workspaceId: string): Promise<{
    count: number;
    features: Array<{ featureSlug: string; sessions: SessionRow[] }>;
  }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${workspaceId}/sessions/features`);
      if (!r.ok) return { count: 0, features: [] };
      return await r.json() as any;
    } catch { return { count: 0, features: [] }; }
  }

  async pickSessionForQuery(args: {
    workspaceId: string; featureSlug?: string | null; query: string;
  }): Promise<{ picked: SessionRow | null; score?: number; reason?: string } | null> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${args.workspaceId}/sessions/pick`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ featureSlug: args.featureSlug ?? null, query: args.query }),
      });
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  async killswitch(workspaceId?: string): Promise<{ killed: number; durationMs: number } | null> {
    try {
      const url = workspaceId
        ? `${base()}/api/killswitch?workspace=${encodeURIComponent(workspaceId)}`
        : `${base()}/api/killswitch`;
      const r = await fetch(url, { method: 'POST' });
      if (!r.ok) return null;
      return await r.json() as { killed: number; durationMs: number };
    } catch { return null; }
  }

  async submitBrief(args: {
    workspaceId: string;
    body: string;
    securityTagged?: boolean;
    targetFolder?: string;
    taggedAgents?: string[];
    budget?: { mode: 'tokens' | 'currency'; amount: number };
    /** 'auto' runs end-to-end. 'manual' awaits per-phase release.
     *  'assisted' pauses after Phase 1 (Plan) for user Approve/Regenerate/Reject. */
    mode?: 'auto' | 'manual' | 'assisted';
    /** Model tier for Phase 1 (Plan). Overrides router default. */
    preferredModel?: string;
  }): Promise<{
    ok: boolean; briefId?: string; error?: string;
    /** S4: server routed this brief through the quick-task lane instead of
     *  the 3-phase pipeline. The extension should skip Kanban and show the
     *  agent's answer directly. */
    quick?: boolean;
    quickReason?: string;
    run?: DirectTaskRun;
  }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${args.workspaceId}/briefs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: args.body,
          securityTagged: !!args.securityTagged,
          targetFolder: args.targetFolder,
          taggedAgents: args.taggedAgents,
          budget: args.budget,
          mode: args.mode,
          preferredModel: args.preferredModel,
        }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return {
        ok: true, briefId: j.briefId,
        quick: !!j.quick, quickReason: j.quickReason, run: j.run,
      };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Save (merge) intake fields for a workspace. Used by the Detailed brief
   *  flow to set the goal before dispatching the brief. */
  async saveIntake(workspaceId: string, intake: { goal?: string; criteria?: string[]; constraints?: string[] }): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${workspaceId}/intake`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(intake),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j?.error ?? `http ${r.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Get top-N catalog agents that match a brief body. Used by the composer to
   *  auto-tag suggestions. Returns flag whether each is already on the workspace
   *  roster (avoids creating duplicate agent records on dispatch). */
  async suggestAgents(args: {
    taskBody: string;
    workspaceId?: string;
    limit?: number;
  }): Promise<{ count: number; suggestions: AgentSuggestion[] }> {
    try {
      const r = await fetch(`${base()}/api/catalog/suggest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!r.ok) return { count: 0, suggestions: [] };
      return await r.json() as { count: number; suggestions: AgentSuggestion[] };
    } catch { return { count: 0, suggestions: [] }; }
  }

  /** Read workspace meta.json (targetFolder, kind, originatingTask). */
  async getWorkspaceMeta(workspaceId: string): Promise<{
    id: string;
    createdAt: number;
    kind: 'project' | 'auto-task';
    originatingTask: string | null;
    targetFolder: string | null;
  } | null> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${workspaceId}/meta`);
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  /** List work items for a workspace, optionally filtered by brief. */
  async listWorkItems(workspaceId: string, briefId?: string): Promise<WorkItem[]> {
    try {
      const url = briefId
        ? `${base()}/api/workspaces/${workspaceId}/work-items?briefId=${encodeURIComponent(briefId)}`
        : `${base()}/api/workspaces/${workspaceId}/work-items`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json() as { items: WorkItem[] };
      return j.items ?? [];
    } catch { return []; }
  }

  /** All sessions (tasks) in a workspace, agent-tagged. Used for the
   *  "Show all sessions" picker. */
  async listSessions(workspaceId: string): Promise<SessionEntry[]> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${workspaceId}/sessions`);
      if (!r.ok) return [];
      const j = await r.json() as { sessions: SessionEntry[] };
      return j.sessions ?? [];
    } catch { return []; }
  }

  /** Full chat history for a single task — the chunks emitted by the
   *  task's agent between startedAt and endedAt. */
  async getTaskSession(workspaceId: string, taskId: string): Promise<TaskSession | null> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${workspaceId}/tasks/${taskId}/session`);
      if (!r.ok) return null;
      return await r.json() as TaskSession;
    } catch { return null; }
  }

  /** Work items assigned to a specific agent role across all briefs in a workspace. */
  async listAgentWork(workspaceId: string, assignedRole: string): Promise<WorkItem[]> {
    try {
      const r = await fetch(`${base()}/api/work-items?workspaceId=${workspaceId}&assignedRole=${encodeURIComponent(assignedRole)}`);
      if (!r.ok) return [];
      const j = await r.json() as { items: WorkItem[] };
      return j.items ?? [];
    } catch { return []; }
  }

  /** Search the full catalog (for the manual-hire picker). */
  async searchCatalog(q: string): Promise<CatalogAgent[]> {
    try {
      const r = await fetch(`${base()}/api/catalog/agents?q=${encodeURIComponent(q)}`);
      if (!r.ok) return [];
      const j = await r.json() as { agents: CatalogAgent[] };
      return j.agents ?? [];
    } catch { return []; }
  }

  async createWorkspace(name: string, targetFolder?: string): Promise<{
    ok: boolean; id?: string; error?: string;
    /** Populated on 409 name-collision — the extension can offer "Open existing"
     *  instead of just rejecting. */
    existingId?: string; existingName?: string;
    conflict?: boolean;
  }> {
    try {
      const r = await fetch(`${base()}/api/workspaces`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, targetFolder }),
      });
      const j = await r.json() as any;
      if (!r.ok) {
        return {
          ok: false,
          error: j?.error ?? `http ${r.status}`,
          existingId: j?.existingId,
          existingName: j?.existingName,
          conflict: r.status === 409 && !!j?.existingId,
        };
      }
      return { ok: true, id: j.id };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Resume a brief whose pipeline died. The server re-runs runPipeline and
   *  skips any phase whose artifact .md is already on disk. */
  async resumeBrief(briefId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/briefs/${briefId}/resume`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string };
      if (!r.ok) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
      return { ok: !!j.ok, ...(j.reason ? { error: j.reason } : {}) };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Zero-config workspace creation from a task title. Server generates the
   *  slug + date suffix; client just supplies the human-readable task. The
   *  extension always passes targetFolder so agents write into the open repo
   *  root, never under .atrune. */
  async createAutoWorkspace(taskTitle: string, kind: 'auto-task' | 'project' = 'auto-task', targetFolder?: string)
  : Promise<{ ok: boolean; id?: string; name?: string; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/auto`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskTitle, kind, targetFolder }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, id: j.id, name: j.name };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Global Claude integration — for the first-launch zero-config flow. */
  async getGlobalClaude(): Promise<{ apiKeySet: boolean; cliConnected: boolean; ready: boolean } | null> {
    try {
      const r = await fetch(`${base()}/api/integrations/claude/global`);
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  async setGlobalClaudeApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/integrations/claude/global/apikey`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      if (!r.ok) {
        const j = await r.json() as any;
        return { ok: false, error: j?.error ?? `http ${r.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  async connectGlobalClaudeCli(): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/integrations/claude/global/cli/connect`, { method: 'POST' });
      if (!r.ok) {
        const j = await r.json() as any;
        return { ok: false, error: j?.error ?? `http ${r.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Disconnect the global Claude integration — clears both the API key
   *  and the CLI binding. Used by the "Disconnect" button. */
  async disconnectGlobalClaude(): Promise<{ ok: boolean; error?: string }> {
    try {
      await Promise.all([
        fetch(`${base()}/api/integrations/claude/global/apikey`, { method: 'DELETE' }),
        fetch(`${base()}/api/integrations/claude/global/cli/disconnect`, { method: 'POST' }),
      ]);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Public base URL the webview iframes should load (host's port). */
  webBase(): string {
    const port = vscode.workspace.getConfiguration('atrune').get<number>('webPort', 3000);
    return `http://localhost:${port}`;
  }
  serverBase(): string {
    return base();
  }

  // ---------- direct-task (Phase 3) ----------

  async directTask(args: {
    workspaceId: string; agentId: string; prompt: string; cwd?: string;
  }): Promise<{ ok: boolean; run?: DirectTaskRun; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${args.workspaceId}/direct-task`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: args.agentId, prompt: args.prompt, cwd: args.cwd }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, run: j.run as DirectTaskRun };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  async autoFix(args: {
    workspaceId: string; description: string; cwd?: string; hire?: boolean;
  }): Promise<{ ok: boolean; run?: DirectTaskRun & { pickedAgentRole?: string }; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${args.workspaceId}/auto-fix`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: args.description, cwd: args.cwd, hire: args.hire ?? true }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, run: j.run };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }
}

export interface SessionRow {
  id: string;
  workspaceId: string;
  featureSlug: string | null;
  briefId: string | null;
  role: string | null;
  startedAt: number;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  jsonlPath: string | null;
  outcome: string;
  briefSnippet?: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  match: { tool: string; argsPattern?: string };
  action: 'auto-approve' | 'always-ask' | 'deny';
  createdAt: number;
  synthesized?: boolean;
}

export interface PoliciesSnapshot {
  mode: 'auto' | 'manual' | 'custom';
  defaultAction: 'ask' | 'auto-approve' | 'deny';
  rules: PolicyRule[];
}

export interface SessionEntry {
  taskId: string;
  briefId: string;
  briefTitle: string;
  agentId: string | null;
  agentRole: string | null;
  agentDisplayName: string | null;
  phase: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
}

export interface SessionChunk {
  id: string;
  ts: number;
  workspaceId: string;
  agentId?: string;
  kind: 'user' | 'ai' | 'system' | 'tool' | 'phase' | 'approval';
  text?: string;
  level?: string;
  toolName?: string;
  toolInput?: any;
  toolOutput?: any;
  taskId?: string;
  phase?: string;
  status?: string;
  [k: string]: any;
}

export interface TaskSession {
  task: {
    id: string;
    briefId: string;
    agentId: string | null;
    phase: string;
    status: string;
    artifactPath: string | null;
    tokensIn: number;
    tokensOut: number;
    startedAt: number | null;
    endedAt: number | null;
  };
  brief: { id: string; body: string; status: string } | null;
  agent: { id: string; role: string; displayName: string; status: string } | null;
  chunks: SessionChunk[];
  artifact: { phase: string; path: string; body: string } | null;
  window: { startTs: number; endTs: number };
}

export interface WorkItem {
  id: string;
  workspaceId: string;
  briefId: string | null;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  // S3: pipeline emits plan/implement/review. Legacy values retained so DB
  // rows written pre-S3 still deserialize.
  phase: 'plan' | 'implement' | 'review' | 'other' | 'research' | 'verify' | null;
  priority: 'low' | 'normal' | 'high' | 'critical';
  assignedRole: string | null;
  createdAt: number;
  updatedAt: number;
  featureTag?: string | null;
  claudeSessionId?: string | null;
  // S8 · goal-decomposer output.
  dependencies?: string[];
  skillHint?: string | null;
  acceptance?: string | null;
}

export interface AgentSuggestion {
  role: string;
  displayName: string;
  department: string;
  description: string;
  model?: string;
  score: number;
  bestPhase: string;
  hiredAlready: boolean;
}

export interface CatalogAgent {
  role: string;
  displayName: string;
  department: string;
  description: string;
  model?: string;
  tools?: string[];
}

export interface DirectTaskRun {
  id: string;
  workspaceId: string;
  agentId: string;
  prompt: string;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  cwd: string;
  status: 'ok' | 'budget-blocked' | 'error';
  error?: string;
  pickedAgentRole?: string;
}
