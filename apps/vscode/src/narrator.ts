// Phase 4 — Plan state → plain-English narrator sentence.
//
// Powers the live narrator slot in the status bar. Maps the plan endpoint's
// shape into one short sentence that answers "what's happening right now?"
//
// Designed to be glanceable. Never longer than ~50 chars after the leading
// label. Verbs in the present continuous so the bar reads like a heartbeat.

import type { PlanResp } from './api';

export function narrate(plan: PlanResp | null): string {
  if (!plan) return 'connecting…';

  const { briefs, pendingApprovals, agents } = plan;

  if (pendingApprovals.length > 0) {
    return pendingApprovals.length === 1
      ? '1 approval needs you'
      : `${pendingApprovals.length} approvals need you`;
  }

  if (briefs.active > 0) {
    const recent = briefs.recent.find(
      (b) => b.status !== 'done' && b.status !== 'failed' && b.status !== 'archived',
    );
    if (recent) {
      const phase = phaseFromStatus(recent.status);
      return `${phase} · ${truncate(recent.body, 36)}`;
    }
    return `${briefs.active} brief${briefs.active > 1 ? 's' : ''} running`;
  }

  if (agents.active > 0) {
    return `idle · ${agents.active} agent${agents.active > 1 ? 's' : ''} ready`;
  }

  if (agents.total === 0) {
    return 'no team yet · start a brief';
  }

  return 'ready';
}

function phaseFromStatus(status: string): string {
  switch (status) {
    case 'planning':
    case 'plan':
    case 'discovery':
      return 'planning';
    case 'building':
    case 'implementing':
    case 'implement':
      return 'building';
    case 'reviewing':
    case 'review':
      return 'reviewing';
    case 'verifying':
    case 'verify':
      return 'verifying';
    case 'in_progress':
    case 'running':
      return 'working';
    default:
      return status;
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
