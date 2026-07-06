// S8 · Goal decomposer.
//
// Turn a brief into a small task graph the Kanban can render as a Backlog.
// Heuristic-only — no LLM call — so it's deterministic + free.
//
// Signals it extracts from the brief:
//   1. Overall verb (build / add / fix / refactor / write / debug / …) → per-goal skill.
//   2. Sub-features listed after "with", "including", "for", or via bullets /
//      commas / `add/list/done`-style slashes → one implement task each.
//   3. Explicit file references → per-file implement task (deduped with sub-features).
//
// Emitted task shape (each becomes a work_items row via cos.ts):
//   { title, description, phase, assignedRole, skillHint, acceptance,
//     dependencies (list of upstream task keys), priority }
//
// Dependencies form a small GOAP-style graph:
//   Scope (plan) → each Implement → Tests (review) → Docs (review) → Verdict (review)
// The planner topo-sorts before hand-off so the Kanban shows Backlog in order.

import { STOPWORDS_LARGE } from './decomposeStopwords.js';

export type TaskPhase = 'plan' | 'implement' | 'review';

export interface DecomposedTask {
  /** Stable key used by other tasks to reference this one as a dep. Replaced
   *  by the real work_items id after insertion. */
  key: string;
  title: string;
  description: string;
  phase: TaskPhase;
  role: string;
  skillHint: string | null;
  acceptance: string;
  /** Keys (NOT ids) of tasks that must be done before this one starts. */
  dependencies: string[];
  priority: 'low' | 'normal' | 'high' | 'critical';
}

export interface DecomposeResult {
  tasks: DecomposedTask[];
  /** Verb the decomposer inferred (helps callers choose a lane / label). */
  overallVerb: string;
}

// ─── verb → default (role, skillHint) ─────────────────────────
// `canonical` is the verb NAME returned by inferVerb, regardless of which
// alias in `re` actually matched — so downstream code + tests can key off a
// single label per intent.
const VERB_MAP: Array<{ re: RegExp; canonical: string; role: string; skill: string }> = [
  { re: /^(build|create|make|add|implement)\b/i,   canonical: 'build',    role: 'coder',      skill: 'add-feature' },
  { re: /^(fix|repair|patch|resolve)\b/i,           canonical: 'fix',      role: 'debugger',   skill: 'fix-bug' },
  { re: /^(refactor|restructure|tidy|cleanup)\b/i,  canonical: 'refactor', role: 'refactorer', skill: 'refactor-function' },
  { re: /^(rename)\b/i,                             canonical: 'rename',   role: 'refactorer', skill: 'rename' },
  { re: /^(extract)\b/i,                            canonical: 'extract',  role: 'refactorer', skill: 'extract-function' },
  { re: /^(test|verify|cover)\b/i,                  canonical: 'test',     role: 'tester',     skill: 'add-test' },
  { re: /^(document|write\s+docs?|docs?)\b/i,       canonical: 'document', role: 'doc-writer', skill: 'write-docs' },
  { re: /^(debug|investigate|trace)\b/i,            canonical: 'debug',    role: 'debugger',   skill: 'debug' },
  { re: /^(review|audit|critique)\b/i,              canonical: 'review',   role: 'reviewer',   skill: 'review-code' },
];

function inferVerb(brief: string): { verb: string; role: string; skill: string } {
  const trimmed = brief.trim();
  for (const v of VERB_MAP) {
    if (v.re.test(trimmed)) return { verb: v.canonical, role: v.role, skill: v.skill };
  }
  return { verb: 'build', role: 'coder', skill: 'add-feature' };
}

// ─── sub-feature extraction ───────────────────────────────────
// Patterns we handle:
//   "build a TODO CLI with add/list/done"          → [add, list, done]
//   "add support for X, Y, and Z"                  → [X, Y, Z]
//   "fix bugs including auth, cache, and metrics"  → [auth, cache, metrics]
//   "build a page that shows A, B, C"              → [A, B, C]
//   "- foo\n- bar\n- baz"                          → [foo, bar, baz]

const SPLITTER_HEADS = /\b(?:with|including|containing|for|that\s+(?:has|shows|does|supports)|supports)\b/i;
const LIST_ITEMS = /(?:^|\n)\s*[-*•]\s+([^\n]+)/g;

function extractSubFeatures(brief: string): string[] {
  const items = new Set<string>();

  // 1. bullet lists first — cleanest signal.
  for (const m of brief.matchAll(LIST_ITEMS)) {
    const t = m[1]!.trim();
    if (t.length > 1 && t.length <= 80) items.add(t);
  }

  // 2. clause after "with"/"including"/etc → split by comma/slash/and.
  const tail = brief.split(SPLITTER_HEADS)[1] ?? '';
  if (tail) {
    // Grab the tail up to a sentence boundary.
    const clause = tail.split(/[.!?\n]/)[0]!.trim();
    const parts = clause.split(/\s*(?:,|\/|\band\b|\bor\b|;)\s*/i)
      .map((p) => p.replace(/^(a|an|the)\s+/i, '').trim())
      .filter((p) => p && p.length <= 40 && !SPLITTER_HEADS.test(p));
    for (const p of parts) items.add(p);
  }

  // 3. filter STOPWORD noise + de-dupe casefold.
  const clean = new Set<string>();
  for (const raw of items) {
    const t = raw.replace(/[()`"']/g, '').trim();
    if (!t) continue;
    if (STOPWORDS_LARGE.has(t.toLowerCase())) continue;
    if (/^\d+$/.test(t)) continue;
    clean.add(t);
  }
  return [...clean];
}

// ─── main ─────────────────────────────────────────────────────
export function decompose(brief: string): DecomposeResult {
  const body = brief.trim();
  const { verb, role, skill } = inferVerb(body);
  const subs = extractSubFeatures(body);
  const briefTitle = body.split(/[\n.!?]/)[0]!.trim().slice(0, 80) || 'the goal';

  const tasks: DecomposedTask[] = [];

  // scope — always the first task.
  tasks.push({
    key: 'scope',
    title: `Scope: ${briefTitle}`,
    description: `Read the brief + relevant existing code. Produce a numbered 3-step plan with acceptance checks per step.`,
    phase: 'plan', role: 'planner', skillHint: null,
    acceptance: 'A numbered plan exists with one acceptance check per step.',
    dependencies: [], priority: 'high',
  });

  if (subs.length === 0) {
    // Single-feature brief. One implement + one review.
    tasks.push({
      key: 'impl',
      title: `Implement: ${briefTitle}`,
      description: `Implement the ${verb} described in the brief per the scope's plan.`,
      phase: 'implement', role, skillHint: skill,
      acceptance: `The behaviour described in the brief works end-to-end.`,
      dependencies: ['scope'], priority: 'high',
    });
    tasks.push({
      key: 'review',
      title: `Review + verify: ${briefTitle}`,
      description: `Review the diff, run tests, confirm shippability.`,
      phase: 'review', role: 'reviewer', skillHint: 'review-code',
      acceptance: `Reviewer signs off (approve / request-changes with rationale).`,
      dependencies: ['impl'], priority: 'high',
    });
    return { tasks, overallVerb: verb };
  }

  // Multi-feature brief. One implement + one test per sub-feature; then a
  // cross-cutting doc + a final review that waits on everything.
  const implKeys: string[] = [];
  const testKeys: string[] = [];
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i]!;
    const implKey = `impl-${i}`;
    const testKey = `test-${i}`;
    tasks.push({
      key: implKey,
      title: `Implement ${sub}`,
      description: `Build the "${sub}" slice per the scope's plan.`,
      phase: 'implement', role, skillHint: skill,
      acceptance: `The "${sub}" flow works end-to-end and doesn't break siblings.`,
      dependencies: ['scope'], priority: 'high',
    });
    implKeys.push(implKey);
    tasks.push({
      key: testKey,
      title: `Test ${sub}`,
      description: `Cover the "${sub}" implementation with happy path + 1-2 edge cases.`,
      phase: 'review', role: 'tester', skillHint: 'add-test',
      acceptance: `New test(s) fail without the impl and pass with it.`,
      dependencies: [implKey], priority: 'normal',
    });
    testKeys.push(testKey);
  }

  tasks.push({
    key: 'docs',
    title: `Document usage`,
    description: `Update README / docstrings so the new behaviour is discoverable. Lead with an example.`,
    phase: 'review', role: 'doc-writer', skillHint: 'write-docs',
    acceptance: `A user reading the docs can invoke every new sub-feature without reading the code.`,
    dependencies: implKeys, priority: 'normal',
  });

  tasks.push({
    key: 'verdict',
    title: `Review + verdict`,
    description: `Cross-cutting review — correctness, security, clarity. Confirm shippability.`,
    phase: 'review', role: 'reviewer', skillHint: 'review-code',
    acceptance: `Reviewer signs off (approve / request-changes with rationale).`,
    dependencies: [...testKeys, 'docs'], priority: 'high',
  });

  return { tasks, overallVerb: verb };
}

// ─── topo sort ────────────────────────────────────────────────
/** Kahn's algorithm. Throws on cycles (decomposer should never produce them,
 *  but callers get a clear error if they hand-craft a bad graph). */
export function topoSort(tasks: DecomposedTask[]): DecomposedTask[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const inDeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    inDeg.set(t.key, t.dependencies.length);
    for (const dep of t.dependencies) {
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep))!.push(t.key);
    }
  }
  const queue: string[] = [];
  for (const [k, n] of inDeg) if (n === 0) queue.push(k);
  const out: DecomposedTask[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    out.push(byKey.get(k)!);
    for (const child of dependents.get(k) ?? []) {
      inDeg.set(child, inDeg.get(child)! - 1);
      if (inDeg.get(child) === 0) queue.push(child);
    }
  }
  if (out.length !== tasks.length) throw new Error('decompose: cycle detected in task graph');
  return out;
}
