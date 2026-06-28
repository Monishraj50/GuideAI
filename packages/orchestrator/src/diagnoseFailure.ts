// When a phase fails, spawn a small diagnostic agent in the SAME Claude
// session as the brief. The diagnosis is rendered inline as the next
// assistant turn in the chat (so the user sees "why it failed + how to
// fix" without leaving the live tail), and is also persisted onto the
// work_item rows so the Kanban can surface a Retry button with a tooltip.
//
// Only diagnoses — does NOT automatically retry. Retry is user-triggered
// (per the chosen design) so the loop can't run away on unrecoverable
// failures.

import { eq } from 'drizzle-orm';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import { appendEvent } from '@guideai/messaging/events';
import { getDb, schema } from '@guideai/shared/db';
import type { AIChunk, SystemChunk } from '@guideai/shared/chunks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { paths } from '@guideai/shared/paths';
import type { WorkPhase } from './wbs.js';

export async function diagnoseFailure(args: {
  workspaceId: string;
  briefId: string;
  phase: WorkPhase;
  agentId: string;
  cwd: string;
  errorMessage: string;
  brief: string;
  claudeSessionId: string | null;
}): Promise<{ diagnosis: string }> {
  const { workspaceId, briefId, phase, agentId, cwd, errorMessage, brief, claudeSessionId } = args;

  // Pull recent context: the failed phase's artifact (if any) and the
  // tail of events for this brief.
  const artifact = path.join(paths.workspaceMdDir(workspaceId), 'briefs', briefId, `${phase}.md`);
  const artifactSnippet = fs.existsSync(artifact)
    ? truncate(fs.readFileSync(artifact, 'utf8'), 2000)
    : '(no artifact written before failure)';

  const systemPrompt = [
    'You are a debug-fixer agent. The brief\'s pipeline just failed during a phase.',
    'Your job: in 4-6 short lines, explain WHY the failure happened and WHAT to change to fix it.',
    'Be concrete (file paths, command names, missing env vars). Do NOT propose multi-step rewrites.',
    'Format: "Why: <root cause>" then "Fix: <one-line actionable change>".',
    'If you genuinely don\'t know, say so — better than guessing.',
  ].join('\n');

  const prompt = [
    `Failed phase: ${phase}`,
    `Error: ${errorMessage}`,
    '',
    'Brief:',
    truncate(brief, 800),
    '',
    'Last partial artifact for this phase:',
    artifactSnippet,
  ].join('\n');

  try {
    const adapter = resolveActiveAdapter();
    const res = await adapter.runOnce(
      {
        agentId: `${agentId}-fixer`,
        workspaceId,
        cwd,
        systemPrompt,
        // Same Claude session as the brief — so the diagnosis lands as the
        // next assistant turn in the live chat tail.
        ...(claudeSessionId ? { sessionId: claudeSessionId } : {}),
        model: 'sonnet',
        allowedTools: [],
      },
      prompt,
    );
    const diagnosis = res.chunks
      .filter((c): c is AIChunk => c.kind === 'ai')
      .map((c) => c.text)
      .join('\n')
      .trim();

    if (!diagnosis) {
      const fallback = `Why: agent returned no diagnosis text.\nFix: open the live chat and inspect the error manually.`;
      writeBack({ workspaceId, briefId, phase, diagnosis: fallback, agentId });
      return { diagnosis: fallback };
    }
    writeBack({ workspaceId, briefId, phase, diagnosis, agentId });
    return { diagnosis };
  } catch (err: any) {
    const note: SystemChunk = {
      id: randomUUID(), ts: Date.now(), workspaceId, agentId,
      kind: 'system', level: 'warn',
      text: `fixer agent failed to run: ${err?.message ?? err}`,
    };
    appendEvent(workspaceId, note);
    const fallback = `Why: fixer agent itself crashed (${err?.message ?? err}).\nFix: check the orchestrator logs and try resume.`;
    writeBack({ workspaceId, briefId, phase, diagnosis: fallback, agentId });
    return { diagnosis: fallback };
  }
}

function writeBack(args: {
  workspaceId: string;
  briefId: string;
  phase: WorkPhase;
  diagnosis: string;
  agentId: string;
}): void {
  const db = getDb();
  const rows = db.select().from(schema.workItems).all()
    .filter((r) => r.workspaceId === args.workspaceId
      && r.briefId === args.briefId
      && r.phase === args.phase
      && r.status === 'blocked');
  for (const r of rows) {
    db.update(schema.workItems).set({
      failureDiagnosis: args.diagnosis,
      updatedAt: Date.now(),
    } as any).where(eq(schema.workItems.id, r.id)).run();
  }
  appendEvent(args.workspaceId, {
    id: randomUUID(), ts: Date.now(),
    workspaceId: args.workspaceId, agentId: args.agentId,
    kind: 'system', level: 'info',
    text: `fixer diagnosis for ${args.phase}:\n${args.diagnosis}`,
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
