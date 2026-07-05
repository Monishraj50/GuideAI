// S7 · Session-aware resume.
//
// Given a new brief + its feature slug, pick the best existing session to
// resume (via `claude --resume <id>`) instead of opening a fresh one. The
// warm prompt cache saves tokens; the reused conversation gives the agent
// prior context without stuffing it into a system prompt.
//
// Scoring signals (weighted, then summed):
//   - keyword overlap between query and the session's source brief body : +3 per unique word
//   - name-fragment match on the feature slug                            : +2 per fragment token
//   - outcome bonus: shipped +5 · partial +2 · abandoned 0
//   - recency: +3 if endedAt within 24h · +1 within 7d
//
// A tie breaks toward the more-recent session. Below MIN_SCORE we return
// null so the caller opens a fresh session instead of resuming a stale one.

import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';

const MIN_SCORE = 4;
const STOPWORDS = new Set([
  'a','an','the','and','or','to','of','for','with','in','on','by','as','is','it','be','this','that',
  'we','our','your','their','from','again','also','more','then','than','when','so','but','if',
  'do','does','done','have','has','had','not','make','build','add','fix','some','all','one','two',
]);

function tokenize(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface Session {
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
}

export interface SessionCandidate {
  session: Session;
  score: number;
  reason: string;
}

export interface PickArgs {
  workspaceId: string;
  featureSlug: string | null;
  query: string;
  /** Optional cap on age; sessions older than this are discarded. Default 30d. */
  maxAgeMs?: number;
}

/** Return the top-scoring session for a (feature, query). Null when no
 *  candidate clears MIN_SCORE. */
export function pickSession(args: PickArgs): SessionCandidate | null {
  const db = getDb();
  const now = Date.now();
  const maxAge = args.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;

  let rows = db.select().from(schema.sessions)
    .where(eq(schema.sessions.workspaceId, args.workspaceId)).all() as Session[];
  rows = rows.filter((r) => (r.endedAt ?? r.startedAt) > (now - maxAge));
  if (args.featureSlug) {
    // Prefer feature match but fall back to cross-feature if nothing fits —
    // the caller usually wants same-feature but a strong keyword hit on a
    // sibling feature is still useful.
    const same = rows.filter((r) => r.featureSlug === args.featureSlug);
    if (same.length > 0) rows = same;
  }
  if (rows.length === 0) return null;

  const queryTokens = new Set(tokenize(args.query));
  const featureTokens = new Set(tokenize(args.featureSlug?.replace(/-/g, ' ')));

  // Look up each session's source brief body once; scoring joins in-memory.
  const briefIds = new Set(rows.map((r) => r.briefId).filter(Boolean) as string[]);
  const briefsById = new Map<string, string>();
  if (briefIds.size > 0) {
    for (const b of db.select().from(schema.briefs).all()) {
      if (briefIds.has(b.id)) briefsById.set(b.id, b.body ?? '');
    }
  }

  let best: SessionCandidate | null = null;
  for (const r of rows) {
    const body = r.briefId ? briefsById.get(r.briefId) ?? '' : '';
    const bodyTokens = new Set(tokenize(body));
    const matched: string[] = [];
    let score = 0;
    for (const t of queryTokens) {
      if (bodyTokens.has(t)) { score += 3; matched.push(t); }
      else if (featureTokens.has(t)) { score += 2; matched.push(`feat:${t}`); }
    }
    // Guardrail — a resume must be justified by SOME textual overlap with the
    // prior brief. Otherwise the outcome + recency bonuses alone would auto-
    // pick "the most recently shipped session" for any new brief, even a
    // completely unrelated one.
    if (matched.length === 0) continue;

    if (r.outcome === 'shipped')  score += 5;
    else if (r.outcome === 'partial') score += 2;
    const age = now - (r.endedAt ?? r.startedAt);
    if (age < 24 * 60 * 60 * 1000) score += 3;
    else if (age < 7 * 24 * 60 * 60 * 1000) score += 1;

    if (score < MIN_SCORE) continue;
    if (!best || score > best.score
        || (score === best.score && (r.endedAt ?? 0) > (best.session.endedAt ?? 0))) {
      best = {
        session: r,
        score,
        reason: `outcome=${r.outcome} · matched=${matched.join(',') || '—'} · age=${Math.round(age / 3600_000)}h`,
      };
    }
  }
  return best;
}

/** List sessions grouped by feature slug. Used by the tree view + Quick Pick. */
export function listSessionsGroupedByFeature(workspaceId: string): Array<{
  featureSlug: string;
  sessions: Session[];
}> {
  const db = getDb();
  const rows = db.select().from(schema.sessions)
    .where(eq(schema.sessions.workspaceId, workspaceId)).all() as Session[];
  const bySlug = new Map<string, Session[]>();
  for (const r of rows) {
    const slug = r.featureSlug ?? '(no feature)';
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug))!.push(r);
  }
  return [...bySlug.entries()]
    .map(([featureSlug, sessions]) => ({
      featureSlug,
      sessions: sessions.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    }))
    .sort((a, b) => {
      const at = Math.max(0, ...a.sessions.map((s) => s.endedAt ?? 0));
      const bt = Math.max(0, ...b.sessions.map((s) => s.endedAt ?? 0));
      return bt - at;
    });
}
