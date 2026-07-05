// S6 · Session tracking helpers.
//
// The `sessions` SQLite table mirrors what lives in FEATURE.md's Sessions
// section — one row per Claude session UUID — but structured, queryable, and
// aggregated across every phase that reuses the same session.
//
// Row lifecycle:
//   - INSERT on first phase that resolves a session id (via resolveTaskSession).
//   - UPDATE on every subsequent write: accumulate tokens/cost, refresh
//     endedAt, upsert outcome + jsonlPath.
//
// `outcomeFromReview` parses the review-phase artifact for shipping signal.
// The heuristic is intentionally lenient — if the reviewer says "blocker"
// or "reject" the outcome flips to partial; abandoned is reserved for
// explicit pipeline failure (thrown error).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import type { SessionOutcome } from './contextStore.js';

function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects',
    cwd.replace(/[/\\]/g, '-'), `${sessionId}.jsonl`);
}

export interface UpsertSessionArgs {
  sessionId: string;
  workspaceId: string;
  featureSlug: string | null;
  briefId: string;
  role: string | null;
  cwd: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  outcome?: SessionOutcome;
}

/** Insert (first phase) or accumulate (subsequent phases). Idempotent —
 *  called after every Claude adapter run. */
export function upsertSession(args: UpsertSessionArgs): void {
  const db = getDb();
  const jsonl = jsonlPathFor(args.cwd, args.sessionId);
  const now = Date.now();
  const existing = db.select().from(schema.sessions)
    .where(eq(schema.sessions.id, args.sessionId)).all()[0];
  if (!existing) {
    db.insert(schema.sessions).values({
      id: args.sessionId,
      workspaceId: args.workspaceId,
      featureSlug: args.featureSlug,
      briefId: args.briefId,
      role: args.role,
      startedAt: now,
      endedAt: now,
      tokensIn: args.tokensIn,
      tokensOut: args.tokensOut,
      costUsd: args.costUsd,
      jsonlPath: jsonl,
      outcome: args.outcome ?? 'partial',
    } as any).run();
    return;
  }
  db.update(schema.sessions).set({
    endedAt: now,
    tokensIn: existing.tokensIn + args.tokensIn,
    tokensOut: existing.tokensOut + args.tokensOut,
    costUsd: existing.costUsd + args.costUsd,
    jsonlPath: fs.existsSync(jsonl) ? jsonl : existing.jsonlPath,
    outcome: args.outcome ?? existing.outcome,
  } as any).where(eq(schema.sessions.id, args.sessionId)).run();
}

/** Tag prepended to the FIRST user prompt of a Claude session so the .jsonl
 *  is greppable and FEATURE.md rows point at something identifiable. */
export function firstUserChunkTag(args: {
  featureSlug: string | null; userLabel?: string;
}): string {
  const feature = args.featureSlug?.trim() || 'no-feature';
  const user = args.userLabel?.trim() || 'user';
  return `[${feature} · ${user}]`;
}

/** Whether the session has already opened (i.e. sessions row exists). Used to
 *  decide whether to add the first-user tag to a prompt. */
export function isFirstTurn(sessionId: string): boolean {
  const db = getDb();
  const row = db.select().from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId)).all()[0];
  return !row;
}

/** Derive an outcome from a review-phase artifact. Runs a shallow regex
 *  sweep — the reviewer's own words carry the verdict. */
export function outcomeFromReview(reviewText: string | null | undefined): SessionOutcome {
  if (!reviewText) return 'partial';
  const t = reviewText.toLowerCase();
  // Explicit abandonment signals.
  if (/\babandon(ed|ing)?\b|\bblocker(s)?\b|\breject(ed)?\b|\bcannot\s+ship\b|\bnot\s+shippable\b/.test(t)) {
    return 'partial';
  }
  // Positive signals.
  if (/\bshippable\b|\bapprov(ed|e)\b|\bready\s+to\s+(ship|merge|deploy)\b|\blooks\s+good\b|\blgtm\b/.test(t)) {
    return 'shipped';
  }
  return 'partial';
}
