// S4 · Quick-task classifier.
//
// Splits incoming briefs into two lanes:
//   - 'quick'  → single-shot: bypass the 3-phase pipeline, run one agent,
//                surface the diff / answer directly. No kanban entry.
//   - 'heavy'  → the standard S3 plan → implement → review pipeline.
//
// Heuristics (first-match wins):
//   1. Explicit [heavy] tag anywhere → 'heavy' (override).
//   2. Explicit [quick] tag anywhere → 'quick' (override).
//   3. Body length ≤ 100 chars → 'quick'.
//   4. Body mentions exactly one file path (README.md, src/foo.ts, path/x.py,
//      or `README line 42`) → 'quick'.
//   5. Default → 'heavy'.
//
// Both explicit tags are stripped from the returned `cleanBody` so agents
// don't see the routing sigil in their prompt.

export type BriefLane = 'quick' | 'heavy';

export interface ClassifyResult {
  lane: BriefLane;
  reason: string;
  cleanBody: string;
}

const TAG_RE = /\[(quick|heavy)\]/i;
// File-path heuristic: `foo.ts`, `path/to/foo.md`, `README line 42`, `apps/x.js`.
// Requires at least one `/` or a common file extension. Doesn't over-match on
// prose that happens to contain a dotted domain (e.g. "example.com" would
// match ext-only; we filter those below).
const FILE_HINT_RE =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?<![A-Za-z0-9])[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|md|json|yaml|yml|toml|sh|sql|css|scss|html|vue|svelte)\b/g;
const URL_LIKE = /^https?:\/\//i;

export function classifyBrief(body: string): ClassifyResult {
  const raw = (body ?? '').trim();

  // Rules 1 + 2 — explicit override tags. Match [heavy] before [quick] so an
  // authoring accident like "[quick] but [heavy] because…" resolves the way
  // the user wrote it last (heavy overrides).
  const heavyTag = /\[heavy\]/i.test(raw);
  const quickTag = /\[quick\]/i.test(raw);
  const cleanBody = raw.replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
  if (heavyTag) return { lane: 'heavy', reason: 'explicit [heavy] tag', cleanBody };
  if (quickTag) return { lane: 'quick', reason: 'explicit [quick] tag', cleanBody };

  // Rule 3 — short briefs are almost always one-shots.
  if (cleanBody.length <= 100) {
    return { lane: 'quick', reason: `short brief (${cleanBody.length} chars ≤ 100)`, cleanBody };
  }

  // Rule 4 — exactly one file reference. Multi-file work goes through the
  // pipeline so plan/review can coordinate the touch set.
  const fileHits = new Set<string>();
  for (const m of cleanBody.matchAll(FILE_HINT_RE)) {
    const hit = m[0];
    if (URL_LIKE.test(hit)) continue;              // strip URLs
    if (/^[A-Za-z0-9-]+\.(?:com|org|net|io|dev)$/i.test(hit)) continue; // strip TLDs
    fileHits.add(hit);
  }
  if (fileHits.size === 1) {
    return {
      lane: 'quick',
      reason: `single file reference (${[...fileHits][0]})`,
      cleanBody,
    };
  }

  return { lane: 'heavy', reason: 'default — multi-step brief', cleanBody };
}
