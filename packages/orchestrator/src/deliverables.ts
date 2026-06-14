// Phase 6 + 7 — Deliverables + learning/explainer space.
//
// One table, many kinds:
//   artifact    — verbatim copy of a phase markdown (so the user can browse
//                 outputs without walking the filesystem)
//   slide-deck  — deterministic markdown deck synthesized from synthesis + artifacts
//   explainer   — plain-English walkthrough of what was built (LLM-generated)
//   link        — manual reference (deployed URL, design doc, …)
//   file        — manual file attachment (path on disk)

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import type { AIChunk, SystemChunk } from '@guideai/shared/chunks';
import { tierCost, modelToTier, recordUsage } from '@guideai/policies/budgets';
import type { DiscoverySynthesis } from './discovery.js';

export type DeliverableKind = 'artifact' | 'slide-deck' | 'explainer' | 'link' | 'file';

export interface Deliverable {
  id: string;
  workspaceId: string;
  briefId: string | null;
  kind: DeliverableKind;
  title: string;
  body: string | null;
  uri: string | null;
  source: 'auto' | 'manual';
  phase: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  createdAt: number;
}

function rowToDeliverable(row: any): Deliverable {
  return {
    id: row.id, workspaceId: row.workspaceId,
    briefId: row.briefId, kind: row.kind as DeliverableKind,
    title: row.title, body: row.body, uri: row.uri,
    source: row.source as 'auto' | 'manual', phase: row.phase,
    tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd,
    createdAt: row.createdAt,
  };
}

export function listDeliverables(workspaceId: string, opts?: { briefId?: string; kind?: DeliverableKind }): Deliverable[] {
  const db = getDb();
  let rows = db.select().from(schema.deliverables).all()
    .filter((r) => r.workspaceId === workspaceId);
  if (opts?.briefId) rows = rows.filter((r) => r.briefId === opts.briefId);
  if (opts?.kind)    rows = rows.filter((r) => r.kind === opts.kind);
  return rows
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(rowToDeliverable);
}

export function getDeliverable(id: string): Deliverable | null {
  const db = getDb();
  const row = db.select().from(schema.deliverables).where(eq(schema.deliverables.id, id)).all()[0];
  return row ? rowToDeliverable(row) : null;
}

export interface CreateDeliverableInput {
  workspaceId: string;
  briefId?: string | null;
  kind: DeliverableKind;
  title: string;
  body?: string | null;
  uri?: string | null;
  source?: 'auto' | 'manual';
  phase?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export function createDeliverable(input: CreateDeliverableInput): Deliverable {
  if (!input.title.trim()) throw new Error('title is required');
  const db = getDb();
  const id = `del-${randomUUID().slice(0, 8)}`;
  db.insert(schema.deliverables).values({
    id,
    workspaceId: input.workspaceId,
    briefId: input.briefId ?? null,
    kind: input.kind,
    title: input.title.trim(),
    body: input.body ?? null,
    uri: input.uri ?? null,
    source: input.source ?? 'manual',
    phase: input.phase ?? null,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costUsd: input.costUsd ?? 0,
    createdAt: Date.now(),
  } as any).run();
  return getDeliverable(id)!;
}

export function deleteDeliverable(id: string): { ok: true } {
  const db = getDb();
  db.delete(schema.deliverables).where(eq(schema.deliverables.id, id)).run();
  return { ok: true };
}

// ---------- Harvesting (Phase 6) ----------

const PHASE_FILES: { phase: string; file: string }[] = [
  { phase: 'research',  file: 'research.md' },
  { phase: 'plan',      file: 'plan.md' },
  { phase: 'implement', file: 'implement.md' },
  { phase: 'review',    file: 'review.md' },
  { phase: 'verify',    file: 'verify.md' },
];

/**
 * Walk a brief's artifact directory and persist each phase markdown as a
 * deliverable. Idempotent per (briefId, phase) — re-running replaces.
 */
export function harvestArtifacts(args: { workspaceId: string; briefId: string }): Deliverable[] {
  const db = getDb();
  const dir = path.join(paths.workspaceDir(args.workspaceId), 'briefs', args.briefId);
  if (!fs.existsSync(dir)) return [];

  // Wipe any prior auto-harvested artifacts for this brief so we get a clean re-run.
  const old = db.select().from(schema.deliverables).all()
    .filter((r) => r.workspaceId === args.workspaceId && r.briefId === args.briefId
      && r.kind === 'artifact' && r.source === 'auto');
  for (const r of old) db.delete(schema.deliverables).where(eq(schema.deliverables.id, r.id)).run();

  const out: Deliverable[] = [];
  for (const { phase, file } of PHASE_FILES) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    out.push(createDeliverable({
      workspaceId: args.workspaceId,
      briefId: args.briefId,
      kind: 'artifact',
      title: `${phase} · ${args.briefId}`,
      body,
      uri: p,
      source: 'auto',
      phase,
    }));
  }
  return out;
}

// ---------- Slide deck (Phase 6) ----------

const MAX_BULLETS = 5;

/** Pull short bullets out of a phase artifact for the slide. */
function bulletsFromArtifact(body: string | null): string[] {
  if (!body) return [];
  // The pipeline writes a header block + the model's response. Drop the header.
  const sections = body.split(/\n\n+/);
  const meat = sections.slice(1).join('\n\n');
  const lines = meat.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer existing bullet lines.
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ''));
  if (bullets.length > 0) return bullets.slice(0, MAX_BULLETS);
  // Fall back to first few sentences.
  const sentences = meat.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return sentences.slice(0, MAX_BULLETS);
}

/**
 * Compose a markdown slide deck. Deterministic — no LLM call. Slides separated
 * by `---` so the viewer can split cleanly.
 */
export function generateSlideDeck(args: {
  workspaceId: string;
  briefId: string;
  synthesis?: DiscoverySynthesis | null;
  briefBody?: string;
}): Deliverable {
  const arts = listDeliverables(args.workspaceId, { briefId: args.briefId, kind: 'artifact' });
  const byPhase: Record<string, Deliverable | undefined> = {};
  for (const a of arts) if (a.phase) byPhase[a.phase] = a;

  const slides: string[] = [];

  // Slide 1: title
  const title = args.synthesis?.summary?.split('.')[0]?.slice(0, 80)
    ?? args.briefBody?.split('\n')[0]?.replace(/^#\s*/, '').slice(0, 80)
    ?? `Brief ${args.briefId}`;
  slides.push(
`# ${title}

_brief ${args.briefId} · generated ${new Date().toLocaleString()}_`,
  );

  // Slide 2: outcome — synthesis benefits + summary
  if (args.synthesis) {
    const s = args.synthesis;
    const lines = [
      '## The outcome',
      '',
      s.summary,
      '',
      s.costEstimateUsd != null ? `**Cost**: $${s.costEstimateUsd.toFixed(2)} · ${s.costVerdict}` : null,
      s.benefits.length ? '\n### Benefits' : null,
      ...s.benefits.slice(0, MAX_BULLETS).map((b) => `- ${b}`),
    ].filter(Boolean) as string[];
    slides.push(lines.join('\n'));
  }

  // Slides 3–7: one per phase
  for (const { phase } of PHASE_FILES) {
    const a = byPhase[phase];
    if (!a) continue;
    const bs = bulletsFromArtifact(a.body);
    if (bs.length === 0) continue;
    slides.push(
`## ${phase.charAt(0).toUpperCase() + phase.slice(1)}

${bs.map((b) => `- ${b}`).join('\n')}`,
    );
  }

  // Slide 8: success metrics
  if (args.synthesis?.successMetrics?.length) {
    slides.push(
`## How we'll know it shipped

${args.synthesis.successMetrics.slice(0, MAX_BULLETS).map((m) => `- ${m}`).join('\n')}`,
    );
  }

  // Slide 9: risks
  if (args.synthesis?.riskFlags?.length) {
    slides.push(
`## Risks to watch

${args.synthesis.riskFlags.slice(0, MAX_BULLETS).map((r) => `- ${r}`).join('\n')}`,
    );
  }

  // Last slide: roster
  if (args.synthesis?.recommendedRoles?.length) {
    slides.push(
`## Team

${args.synthesis.recommendedRoles.slice(0, 8).map((r) => `- ${r}`).join('\n')}`,
    );
  }

  const body = slides.join('\n\n---\n\n');

  // Idempotency: replace any prior auto deck for this brief.
  const db = getDb();
  const old = db.select().from(schema.deliverables).all()
    .filter((r) => r.workspaceId === args.workspaceId && r.briefId === args.briefId
      && r.kind === 'slide-deck' && r.source === 'auto');
  for (const r of old) db.delete(schema.deliverables).where(eq(schema.deliverables.id, r.id)).run();

  const d = createDeliverable({
    workspaceId: args.workspaceId,
    briefId: args.briefId,
    kind: 'slide-deck',
    title: `Deck · ${title}`,
    body,
    source: 'auto',
  });
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `slide deck generated · ${slides.length} slides · ${d.id}`));
  return d;
}

// ---------- Explainer (Phase 7) ----------

const EXPLAINER_SYSTEM_PROMPT = `You are GuideAI's Explainer agent. Read the brief and phase artifacts and write a plain-English walkthrough — the kind a teammate would write on a wiki page after shipping.

Format:
## What we built
<1 short paragraph, 2-3 sentences>

## How it works
<3-5 short bullets, each ≤ 25 words. Mention concrete components or files when present in the artifacts.>

## Why these choices
<2-3 bullets explaining tradeoffs from the review/verify phases>

## What's next
<1 paragraph, what shipping doesn't cover yet>

Keep it to under 250 words total. Don't invent details that aren't in the artifacts.`;

/**
 * Ask the active adapter for a plain-English explainer. Cheap haiku call;
 * mock adapter has a fixture so guest mode works too.
 */
export async function generateExplainer(args: {
  workspaceId: string;
  briefId: string;
  briefBody: string;
  synthesis?: DiscoverySynthesis | null;
}): Promise<Deliverable> {
  const arts = listDeliverables(args.workspaceId, { briefId: args.briefId, kind: 'artifact' });
  const adapter = resolveActiveAdapter();
  const cwd = paths.agentCwd(args.workspaceId, `explainer-${args.briefId}`);

  const context = [
    '## Brief',
    args.briefBody,
    '',
    args.synthesis ? `## Synthesis\n\n${args.synthesis.summary}` : '',
    ...arts.map((a) => `## ${a.phase ?? a.kind} artifact\n\n${a.body ?? ''}`),
    '[explainer]',
  ].filter(Boolean).join('\n\n');

  const start = Date.now();
  const res = await adapter.runOnce(
    {
      agentId: `explainer-${args.briefId.slice(-6)}`,
      workspaceId: args.workspaceId,
      cwd,
      systemPrompt: EXPLAINER_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: 'haiku',
    },
    context,
  );
  const text = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n').trim();
  const tIn = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensIn ?? 0), 0);
  const tOut = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensOut ?? 0), 0);
  const cost = tierCost(modelToTier('haiku'), tIn, tOut);

  recordUsage({
    workspaceId: args.workspaceId, agentId: `explainer-${args.briefId.slice(-6)}`,
    briefId: args.briefId, phase: 'explainer',
    model: 'haiku', tokensIn: tIn, tokensOut: tOut,
  });

  // Idempotency: replace prior auto explainer for this brief.
  const db = getDb();
  const old = db.select().from(schema.deliverables).all()
    .filter((r) => r.workspaceId === args.workspaceId && r.briefId === args.briefId
      && r.kind === 'explainer' && r.source === 'auto');
  for (const r of old) db.delete(schema.deliverables).where(eq(schema.deliverables.id, r.id)).run();

  const d = createDeliverable({
    workspaceId: args.workspaceId,
    briefId: args.briefId,
    kind: 'explainer',
    title: `How it works · ${args.briefId}`,
    body: text || '_(no explainer produced)_',
    source: 'auto',
    tokensIn: tIn, tokensOut: tOut, costUsd: cost,
  });
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `explainer generated · ${tIn}↓/${tOut}↑ tokens · $${cost.toFixed(4)} · ${(Date.now() - start)}ms`));
  return d;
}

/**
 * Full post-pipeline harvest: artifacts → deck → explainer. Wraps each step so
 * one failure doesn't cascade. Safe to call from the brief-completion hook in
 * cos.ts even when no plan/synthesis exists (e.g. manual-mode briefs).
 */
export async function harvestBriefDeliverables(args: {
  workspaceId: string;
  briefId: string;
  briefBody: string;
  synthesis?: DiscoverySynthesis | null;
}): Promise<{ artifacts: Deliverable[]; deck: Deliverable | null; explainer: Deliverable | null }> {
  let artifacts: Deliverable[] = [];
  let deck: Deliverable | null = null;
  let explainer: Deliverable | null = null;

  try { artifacts = harvestArtifacts({ workspaceId: args.workspaceId, briefId: args.briefId }); }
  catch (e: any) {
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `artifact harvest skipped: ${e?.message ?? e}`, 'warn'));
  }
  try {
    deck = generateSlideDeck({
      workspaceId: args.workspaceId, briefId: args.briefId,
      synthesis: args.synthesis ?? null, briefBody: args.briefBody,
    });
  } catch (e: any) {
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `slide deck skipped: ${e?.message ?? e}`, 'warn'));
  }
  try {
    explainer = await generateExplainer({
      workspaceId: args.workspaceId, briefId: args.briefId,
      briefBody: args.briefBody, synthesis: args.synthesis ?? null,
    });
  } catch (e: any) {
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `explainer skipped: ${e?.message ?? e}`, 'warn'));
  }

  return { artifacts, deck, explainer };
}

// ---------- helpers ----------

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId,
    kind: 'system', level, text,
  };
}
