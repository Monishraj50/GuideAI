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
  pendingApprovals: { id: string; tool: string; argsJson: string; decidedAt: number }[];
  briefs: {
    recent: { id: string; body: string; status: string; createdAt: number; tasks: number; tokens: number }[];
    total: number;
    active: number;
  };
  tokens: number;
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

  async decideApproval(approvalId: string, decision: 'approved' | 'denied', workspaceId: string): Promise<boolean> {
    const r = await fetch(`${base()}/api/approvals/${approvalId}?workspace=${workspaceId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    return r.ok;
  }

  async submitBrief(args: {
    workspaceId: string;
    body: string;
    securityTagged?: boolean;
    targetFolder?: string;
    taggedAgents?: string[];
    budget?: { mode: 'tokens' | 'currency'; amount: number };
    /** 'auto' (default) runs end-to-end. 'manual' awaits per-phase release. */
    mode?: 'auto' | 'manual';
  }): Promise<{ ok: boolean; briefId?: string; error?: string }> {
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
        }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, briefId: j.briefId };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Get top-N catalog agents that match a brief body. Used by the composer to
   *  auto-tag suggestions. Returns flag whether each is already hired in the
   *  given workspace (no marketplace hire needed on dispatch). */
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

  async createWorkspace(name: string, targetFolder?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, targetFolder }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, id: j.id };
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

  /** Global OpenAI integration — used by the Codex card on the connect screen. */
  async getGlobalOpenAI(): Promise<{ apiKeySet: boolean; ready: boolean } | null> {
    try {
      const r = await fetch(`${base()}/api/integrations/openai/global`);
      if (!r.ok) return null;
      return await r.json() as any;
    } catch { return null; }
  }

  async setGlobalOpenAIApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/integrations/openai/global`, {
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

  /** Disconnect the global OpenAI / Codex integration. */
  async disconnectGlobalOpenAI(): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/integrations/openai/global`, { method: 'DELETE' });
      if (!r.ok) return { ok: false, error: `http ${r.status}` };
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
  phase: 'research' | 'plan' | 'implement' | 'review' | 'verify' | 'other' | null;
  priority: 'low' | 'normal' | 'high' | 'critical';
  assignedRole: string | null;
  createdAt: number;
  updatedAt: number;
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
