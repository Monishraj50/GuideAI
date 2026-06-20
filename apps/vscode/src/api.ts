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

  async submitBrief(args: { workspaceId: string; body: string; securityTagged?: boolean }): Promise<{ ok: boolean; briefId?: string; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces/${args.workspaceId}/briefs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: args.body, securityTagged: !!args.securityTagged }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, briefId: j.briefId };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  async createWorkspace(name: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    try {
      const r = await fetch(`${base()}/api/workspaces`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await r.json() as any;
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true, id: j.id };
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
