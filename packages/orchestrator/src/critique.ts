// Phase 8A — Multi-perspective plan critique.
//
// Between plan-draft and dispatch, run two short critic passes — a CEO lens
// and an Eng lens — that look at the same synthesis but ask different questions.
// Each returns a structured verdict (`pass | needs-revision | reject`) plus
// concerns and suggested edits.
//
// Cheap haiku calls in parallel. Inspired by gstack's /plan-ceo-review +
// /plan-eng-review skills; adapted to live inline in the plan-review flow.

import { randomUUID } from 'node:crypto';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import { paths } from '@guideai/shared/paths';
import { appendEvent } from '@guideai/messaging/events';
import type { AIChunk, SystemChunk } from '@guideai/shared/chunks';
import { tierCost, modelToTier, recordUsage } from '@guideai/policies/budgets';
import type { DiscoverySynthesis, IntakeRecord } from './discovery.js';

export type CritiqueVerdict = 'pass' | 'needs-revision' | 'reject';

export interface SuggestedEdit {
  where: string;        // e.g. "successMetrics", "recommendedRoles", "summary"
  what: string;         // human-readable suggestion
}

export interface Critique {
  role: 'ceo' | 'eng';
  displayName: string;
  verdict: CritiqueVerdict;
  concerns: string[];
  suggestedEdits: SuggestedEdit[];
  rawText: string;       // for transparency
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  failed?: boolean;
  error?: string;
}

export interface CritiqueBundle {
  ceo: Critique;
  eng: Critique;
  ranAt: number;
  /** True when at least one critic returned `reject` or `needs-revision`. */
  blocked: boolean;
}

interface CriticDef {
  role: 'ceo' | 'eng';
  displayName: string;
  systemPrompt: string;
}

const CRITICS: CriticDef[] = [
  {
    role: 'ceo',
    displayName: 'CEO critic',
    systemPrompt:
      'You are a CEO reviewing this plan before greenlighting it. Be terse and direct — your job is to push back on weak scope, unclear value, and runaway cost.\n' +
      'Respond with EXACTLY four labelled lines and nothing else:\n' +
      'VERDICT: <one of: pass | needs-revision | reject>\n' +
      'CONCERNS: <comma-separated 2-4 short concerns; "none" if pass>\n' +
      'EDITS: <comma-separated 0-3 entries in the form FIELD=SUGGESTION; valid FIELDs: summary,recommendedRoles,successMetrics,riskFlags,benefits>\n' +
      'RATIONALE: <one line, why this verdict>',
  },
  {
    role: 'eng',
    displayName: 'Eng critic',
    systemPrompt:
      'You are a senior engineer reviewing this plan before it goes to implementation. Push back on under-staffing, hand-wavy effort estimates, and missing technical risks.\n' +
      'Respond with EXACTLY four labelled lines and nothing else:\n' +
      'VERDICT: <one of: pass | needs-revision | reject>\n' +
      'CONCERNS: <comma-separated 2-4 short concerns; "none" if pass>\n' +
      'EDITS: <comma-separated 0-3 entries in the form FIELD=SUGGESTION; valid FIELDs: summary,recommendedRoles,successMetrics,riskFlags,benefits>\n' +
      'RATIONALE: <one line, why this verdict>',
  },
];

const VALID_FIELDS = new Set(['summary', 'recommendedRoles', 'successMetrics', 'riskFlags', 'benefits']);

export async function runCritiques(args: {
  workspaceId: string;
  planId: string;
  synthesis: DiscoverySynthesis;
  intake?: IntakeRecord | null;
}): Promise<CritiqueBundle> {
  const adapter = resolveActiveAdapter();
  const cwd = paths.agentCwd(args.workspaceId, `critique-${args.planId}`);
  const context = renderContext(args.synthesis, args.intake);

  appendEvent(args.workspaceId, sys(args.workspaceId,
    `critique pass starting on plan ${args.planId} · CEO + Eng`));

  const results = await Promise.all(CRITICS.map(async (c): Promise<Critique> => {
    const start = Date.now();
    try {
      const res = await adapter.runOnce(
        {
          agentId: `critic-${c.role}-${args.planId.slice(-6)}`,
          workspaceId: args.workspaceId, cwd,
          systemPrompt: `${c.systemPrompt}\n\n[critique:${c.role}]`,
          allowedTools: ['Read', 'Glob', 'Grep'],
          model: 'haiku',
        },
        context,
      );
      const text = res.chunks
        .filter((x): x is AIChunk => x.kind === 'ai').map((x) => x.text).join('\n').trim();
      const tIn = res.chunks
        .filter((x): x is AIChunk => x.kind === 'ai').reduce((s, x) => s + (x.tokensIn ?? 0), 0);
      const tOut = res.chunks
        .filter((x): x is AIChunk => x.kind === 'ai').reduce((s, x) => s + (x.tokensOut ?? 0), 0);
      const cost = tierCost(modelToTier('haiku'), tIn, tOut);
      recordUsage({
        workspaceId: args.workspaceId,
        agentId: `critic-${c.role}-${args.planId.slice(-6)}`,
        phase: 'critique', model: 'haiku', tokensIn: tIn, tokensOut: tOut,
      });
      const parsed = parseCritique(text);
      appendEvent(args.workspaceId, sys(args.workspaceId,
        `${c.displayName}: ${parsed.verdict} · ${parsed.concerns.length} concerns · ${tIn}↓/${tOut}↑ tokens · $${cost.toFixed(4)}`));
      return {
        role: c.role, displayName: c.displayName,
        verdict: parsed.verdict,
        concerns: parsed.concerns,
        suggestedEdits: parsed.suggestedEdits,
        rawText: text,
        tokensIn: tIn, tokensOut: tOut, costUsd: cost,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      appendEvent(args.workspaceId, sys(args.workspaceId,
        `${c.displayName} failed: ${msg}`, 'warn'));
      return {
        role: c.role, displayName: c.displayName,
        verdict: 'pass',  // fail-open — a broken critic shouldn't block a brief
        concerns: [], suggestedEdits: [], rawText: '',
        tokensIn: 0, tokensOut: 0, costUsd: 0,
        durationMs: Date.now() - start,
        failed: true, error: msg,
      };
    }
  }));

  const [ceo, eng] = results as [Critique, Critique];
  const blocked = (ceo.verdict !== 'pass' && !ceo.failed)
               || (eng.verdict !== 'pass' && !eng.failed);
  return { ceo, eng, ranAt: Date.now(), blocked };
}

// ---------- helpers ----------

function renderContext(syn: DiscoverySynthesis, intake?: IntakeRecord | null): string {
  const lines: string[] = ['## Plan synthesis under review', ''];
  if (intake?.goal) lines.push(`Goal: ${intake.goal}`, '');
  lines.push(`Summary: ${syn.summary}`, '');
  if (syn.costEstimateUsd != null)
    lines.push(`Cost estimate: $${syn.costEstimateUsd.toFixed(2)} (${syn.costVerdict})`);
  if (intake?.budgetHintUsd != null) lines.push(`Budget hint: $${intake.budgetHintUsd.toFixed(2)}`);
  lines.push('');
  if (syn.recommendedRoles.length) {
    lines.push('Recommended roles:');
    for (const r of syn.recommendedRoles) lines.push(`- ${r}`);
    lines.push('');
  }
  if (syn.successMetrics.length) {
    lines.push('Success metrics:');
    for (const m of syn.successMetrics) lines.push(`- ${m}`);
    lines.push('');
  }
  if (syn.riskFlags.length) {
    lines.push('Risks flagged so far:');
    for (const r of syn.riskFlags) lines.push(`- ${r}`);
    lines.push('');
  }
  if (intake?.constraints?.length) {
    lines.push('Constraints:');
    for (const c of intake.constraints) lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

interface ParsedCritique {
  verdict: CritiqueVerdict;
  concerns: string[];
  suggestedEdits: SuggestedEdit[];
}
function parseCritique(text: string): ParsedCritique {
  const verdictRaw = field(text, 'VERDICT').toLowerCase();
  let verdict: CritiqueVerdict = 'pass';
  if (verdictRaw.includes('reject')) verdict = 'reject';
  else if (verdictRaw.includes('needs')) verdict = 'needs-revision';

  const concernsRaw = field(text, 'CONCERNS');
  const concerns = /^\s*none\s*$/i.test(concernsRaw)
    ? [] : splitList(concernsRaw);

  const editsRaw = field(text, 'EDITS');
  const suggestedEdits: SuggestedEdit[] = [];
  for (const tok of splitList(editsRaw)) {
    const m = tok.match(/^([a-zA-Z]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const where = m[1]!;
    const what = m[2]!.trim();
    if (!VALID_FIELDS.has(where) || !what) continue;
    suggestedEdits.push({ where, what });
  }
  return { verdict, concerns, suggestedEdits };
}
function field(text: string, label: string): string {
  const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
  return m?.[1]?.trim() ?? '';
}
function splitList(s: string): string[] {
  if (!s) return [];
  return s.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
}

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return { id: randomUUID(), ts: Date.now(), workspaceId, kind: 'system', level, text };
}

export { CRITICS };
