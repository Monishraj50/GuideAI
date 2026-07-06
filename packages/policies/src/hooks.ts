// S11 · Hooks-as-policy — pluggable side-checks the orchestrator invokes at
// well-defined lifecycle points. Built-in hooks are always registered; users
// enable/disable/configure them via `<workspaceMd>/hooks.json`.
//
// Semantics:
//   - Every hook receives a typed context object.
//   - Returns { block?, blockReason?, patch?, systemMessage? }.
//     * block=true short-circuits the caller (used by pre-diff:secret-scan).
//     * patch (context-shape-specific) mutates the payload — e.g.
//       on-memory-write:pii-scrub returns { patch: { text: '[REDACTED]' } }.
//     * systemMessage surfaces in the event log for provenance.
//   - Multiple hooks per event run in registration order.
//
// Not to be confused with Claude Code hooks (settings.json). This is
// GuideAI's *orchestrator-internal* hook system.

import fs from 'node:fs';
import path from 'node:path';

export type HookEvent =
  | 'pre-phase'
  | 'post-phase'
  | 'pre-diff'
  | 'pre-commit'
  | 'on-skill-pick'
  | 'on-memory-write';

export interface HookResult<Patch = unknown> {
  block?: boolean;
  blockReason?: string;
  patch?: Patch;
  systemMessage?: string;
}

// ── Per-event context shapes ─────────────────────────────
export interface PrePhaseCtx  { workspaceId: string; briefId: string; phase: string; role: string | null; tokensSoFar: number }
export interface PostPhaseCtx { workspaceId: string; briefId: string; phase: string; artifact: string; role: string | null }
export interface PreDiffCtx   { workspaceId: string; workItemId: string; hunks: Array<{ file: string; body: string }> }
export interface PreCommitCtx { workspaceId: string; message: string; files: string[] }
export interface OnSkillPickCtx { workspaceId: string; taskText: string; pickedSkill: string; score: number }
export interface OnMemoryWriteCtx { workspaceId: string; role: string; text: string }

interface HookMap {
  'pre-phase':       (ctx: PrePhaseCtx)       => HookResult;
  'post-phase':      (ctx: PostPhaseCtx)      => HookResult<{ outcome?: 'shipped'|'partial'|'abandoned' }>;
  'pre-diff':        (ctx: PreDiffCtx)        => HookResult<{ blockedHunks?: string[] }>;
  'pre-commit':      (ctx: PreCommitCtx)      => HookResult<{ message?: string }>;
  'on-skill-pick':   (ctx: OnSkillPickCtx)    => HookResult;
  'on-memory-write': (ctx: OnMemoryWriteCtx)  => HookResult<{ text?: string }>;
}

export interface RegisteredHook<E extends HookEvent = HookEvent> {
  event: E;
  name: string;
  fn: HookMap[E];
  builtin: boolean;
}

const HOOKS: RegisteredHook[] = [];

/** Register a hook for a lifecycle event. Called at module-init for built-ins;
 *  users can also register from hooks.json (see loadHooksJson). */
export function registerHook<E extends HookEvent>(hook: RegisteredHook<E>): void {
  HOOKS.push(hook as RegisteredHook);
}

/** List all currently-registered hooks for an event (respecting any per-
 *  workspace enable/disable config the caller has already applied). */
export function listHooks(event: HookEvent): RegisteredHook[] {
  return HOOKS.filter((h) => h.event === event);
}

/** Invoke every hook registered for `event`. Stops on the first block=true.
 *  Returns a merged result — patches from earlier hooks compose (later ones
 *  see the patched context). */
export function runHook<E extends HookEvent>(
  event: E, ctx: Parameters<HookMap[E]>[0], opts?: { disabled?: string[] },
): ReturnType<HookMap[E]> {
  const disabled = new Set(opts?.disabled ?? []);
  // Start from a shallow copy so downstream hooks see prior patches without
  // us mutating the caller's ctx object.
  const patched: any = { ...ctx };
  // Track which keys were touched by a `patch` — these become the returned
  // delta (fields the caller must apply). Keys that were in ctx but never
  // patched are NOT returned (avoids the "redacted text was dropped because
  // its key existed in ctx" bug the first cut had).
  const touched = new Set<string>();
  const messages: string[] = [];
  for (const h of HOOKS.filter((h) => h.event === event)) {
    if (disabled.has(h.name)) continue;
    const r = (h.fn as any)(patched) as HookResult<any>;
    if (r?.systemMessage) messages.push(`[${h.name}] ${r.systemMessage}`);
    if (r?.patch && typeof r.patch === 'object') {
      for (const [k, v] of Object.entries(r.patch)) {
        patched[k] = v;
        touched.add(k);
      }
    }
    if (r?.block) {
      return { block: true, blockReason: r.blockReason, systemMessage: messages.join(' · ') } as any;
    }
  }
  if (touched.size === 0) {
    return { systemMessage: messages.join(' · ') || undefined } as any;
  }
  const outPatch: any = {};
  for (const k of touched) outPatch[k] = patched[k];
  return {
    patch: outPatch,
    systemMessage: messages.join(' · ') || undefined,
  } as any;
}

// ── Per-workspace hooks.json config ─────────────────────
export interface HooksConfig {
  disabled?: string[];
  options?: Record<string, unknown>;
}

/** Read `<mdRoot>/hooks.json` if present. Missing/malformed → empty config. */
export function loadHooksJson(mdRoot: string): HooksConfig {
  const p = path.join(mdRoot, 'hooks.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as HooksConfig; }
  catch { return {}; }
}

// ── Built-in secret-scan (pre-diff) ─────────────────────
// Kept intentionally conservative — the hits below are unambiguous credentials,
// not "anything that looks like a token". False positives here mean users
// can't ship legitimate diffs, so we lean toward true positives only.
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'aws-access-key',   re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'aws-secret-key',   re: /\baws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i },
  { label: 'github-token',     re: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: 'openai-key',       re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: 'anthropic-key',    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'private-key-pem',  re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: 'jwt-hs256-secret', re: /\beyJhbGciOiJIUzI1NiJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
];

registerHook<'pre-diff'>({
  event: 'pre-diff', name: 'secret-scan', builtin: true,
  fn: (ctx) => {
    const hits: Array<{ file: string; label: string }> = [];
    for (const hunk of ctx.hunks) {
      // Only scan `+` lines (added content) — deletions of previously-committed
      // secrets shouldn't re-block the fix.
      const added = hunk.body.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      const bodyToScan = added.join('\n');
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(bodyToScan)) hits.push({ file: hunk.file, label: p.label });
      }
    }
    if (hits.length === 0) return {};
    return {
      block: true,
      blockReason: `secret-scan blocked ${hits.length} hit(s): ${hits.map((h) => `${h.label}@${h.file}`).slice(0, 5).join(', ')}`,
      systemMessage: `blocked ${hits.length} secret(s)`,
    };
  },
});

// ── Built-in pii-scrub (on-memory-write) ────────────────
// Five regexes per the plan spec. Order matters: JWTs contain what looks like
// tokens, so scrub JWT first; email covers most name@host cases; phone is
// deliberately loose to catch international formats.
const PII_PATTERNS: Array<{ label: string; re: RegExp; replacement: string }> = [
  { label: 'jwt',    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,       replacement: '[REDACTED-JWT]' },
  { label: 'api-key', re: /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g,                                     replacement: '[REDACTED-API-KEY]' },
  { label: 'token',  re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat)_[A-Za-z0-9_-]{10,}\b/g,      replacement: '[REDACTED-TOKEN]' },
  { label: 'email',  re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,                   replacement: '[REDACTED-EMAIL]' },
  { label: 'phone',  re: /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}(?!\d)/g, replacement: '[REDACTED-PHONE]' },
];

registerHook<'on-memory-write'>({
  event: 'on-memory-write', name: 'pii-scrub', builtin: true,
  fn: (ctx) => {
    let redacted = ctx.text;
    const found: string[] = [];
    for (const p of PII_PATTERNS) {
      if (p.re.test(redacted)) {
        found.push(p.label);
        p.re.lastIndex = 0;   // g-flag safety
        redacted = redacted.replace(p.re, p.replacement);
      }
    }
    if (found.length === 0) return {};
    return {
      patch: { text: redacted } as any,
      systemMessage: `redacted: ${found.join(', ')}`,
    };
  },
});

// ── Built-in budget-cap (pre-phase) ─────────────────────
// Cheap advisory — the real budget gate still lives in phases.ts (it has
// access to the tier + forecast). This hook is a hook-shaped mirror so users
// can layer their own budget policies on top via hooks.json.
registerHook<'pre-phase'>({
  event: 'pre-phase', name: 'budget-cap', builtin: true,
  fn: (ctx) => {
    // Placeholder — the real check happens inline in phases.ts; the hook is
    // here so users get a policy hook they can attach to.
    if (ctx.tokensSoFar > 10_000_000) {
      return { block: true, blockReason: `budget-cap: ${ctx.tokensSoFar} tokens exceeds 10M ceiling` };
    }
    return {};
  },
});

// ── Built-in outcome-tag (post-phase) ───────────────────
// Re-uses the S6 heuristic. Kept here so users can layer stricter tagging
// on top (e.g. a corporate lint that flips to partial on TODO comments).
registerHook<'post-phase'>({
  event: 'post-phase', name: 'outcome-tag', builtin: true,
  fn: (ctx) => {
    if (ctx.phase !== 'review') return {};
    const t = (ctx.artifact ?? '').toLowerCase();
    if (/\babandon(ed|ing)?\b|\bblocker(s)?\b|\breject(ed)?\b|\bcannot\s+ship\b|\bnot\s+shippable\b/.test(t)) {
      return { patch: { outcome: 'partial' }, systemMessage: 'outcome=partial (negative signal)' };
    }
    if (/\bshippable\b|\bapprov(ed|e)\b|\bready\s+to\s+(ship|merge|deploy)\b|\blooks\s+good\b|\blgtm\b/.test(t)) {
      return { patch: { outcome: 'shipped' }, systemMessage: 'outcome=shipped (positive signal)' };
    }
    return { patch: { outcome: 'partial' }, systemMessage: 'outcome=partial (no clear signal)' };
  },
});
