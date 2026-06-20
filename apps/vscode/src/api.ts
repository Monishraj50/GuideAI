// Thin fetch wrapper over the existing Atrium HTTP API. Reuses every route
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
  const port = vscode.workspace.getConfiguration('atrium').get<number>('serverPort', 4000);
  return `http://localhost:${port}`;
}

export class AtriumApi {
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
}
