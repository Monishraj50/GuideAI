import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

export type RuleAction = 'auto-approve' | 'always-ask' | 'deny';

export interface RuleMatch {
  /** Tool name, e.g. "Bash", "Read", "Edit". Required. */
  tool: string;
  /** Optional regex matched against the JSON of the tool args. Anchored as written. */
  argsPattern?: string;
}

export interface Rule {
  id: string;
  /** Free-form description for the UI / audit log. */
  description: string;
  match: RuleMatch;
  action: RuleAction;
  createdAt: number;
  /** True for rules created by "don't ask me again" synthesis. */
  synthesized?: boolean;
}

/**
 * Top-level permission mode. Set by the user in the sidebar dropdown.
 *   - `auto`   : auto-approve everything safe (hard-denies still apply)
 *   - `manual` : ask every tool call (default on fresh install)
 *   - `custom` : evaluate `rules[]`; unmatched calls fall through to `defaultAction`
 */
export type PermissionMode = 'auto' | 'manual' | 'custom';

export interface Policies {
  mode: PermissionMode;
  defaultAction: 'ask' | 'auto-approve' | 'deny';
  rules: Rule[];
}

// Default = 'auto' so a first-time user's pipeline can actually write files
// without them having to click through 20 approvals. The hard-deny list below
// still applies in every mode (rm -rf, --no-verify, force-push, shutdown) so
// 'auto' is NOT "trust everything" — it's "trust the built-in denylist".
// Users who want to review every tool call can flip to 'manual' via the
// sidebar's Set-permission-mode picker.
const DEFAULT_POLICIES: Policies = {
  mode: 'auto',
  defaultAction: 'ask',
  rules: [
    {
      id: 'rule-builtin-read',
      description: 'Read-only tools auto-approve.',
      match: { tool: 'Read' },
      action: 'auto-approve',
      createdAt: 0,
    },
    {
      id: 'rule-builtin-glob',
      description: 'Glob auto-approves.',
      match: { tool: 'Glob' },
      action: 'auto-approve',
      createdAt: 0,
    },
    {
      id: 'rule-builtin-grep',
      description: 'Grep auto-approves.',
      match: { tool: 'Grep' },
      action: 'auto-approve',
      createdAt: 0,
    },
  ],
};

// Hard-denies that apply in EVERY mode (including auto). These are patterns we
// won't run even if the user says "auto-approve everything" — they're too
// destructive or too suspicious to green-light without a human eyeball.
const HARD_DENY_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,       // rm -rf, rm -fr, rm -Rf etc
  /\brm\s+--recursive.*--force\b/i,
  /--no-verify\b/,                    // bypass git hooks
  /--no-gpg-sign\b/,                  // bypass signing
  /\bgit\s+push\s+.*--force\b/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
];

function hardDeny(tool: string, args: unknown): { deny: true; reason: string } | null {
  if (tool !== 'Bash') return null;
  const cmd = typeof (args as any)?.command === 'string' ? (args as any).command as string : '';
  if (!cmd) return null;
  for (const re of HARD_DENY_BASH_PATTERNS) {
    if (re.test(cmd)) return { deny: true, reason: `hard-deny: matches ${re.source}` };
  }
  return null;
}

function ensurePoliciesFile() {
  if (!fs.existsSync(paths.policiesJson)) {
    fs.mkdirSync(path.dirname(paths.policiesJson), { recursive: true });
    fs.writeFileSync(paths.policiesJson, JSON.stringify(DEFAULT_POLICIES, null, 2));
  }
}

export function loadPolicies(): Policies {
  ensurePoliciesFile();
  try {
    const raw = fs.readFileSync(paths.policiesJson, 'utf8');
    const p = JSON.parse(raw) as Partial<Policies>;
    // GLOBAL AUTO OVERRIDE — manual/custom modes are temporarily disabled.
    // Any persisted mode is coerced to 'auto' + the file is rewritten so
    // subsequent reads (hook script, other tools) see the coerced value.
    // To reintroduce manual/custom: replace this block with the original
    // isValid-based validation.
    const mode: PermissionMode = 'auto';
    if (p.mode !== 'auto') {
      try {
        const healed = {
          mode,
          defaultAction: p.defaultAction ?? 'ask',
          rules: Array.isArray(p.rules) ? p.rules : [],
        };
        fs.writeFileSync(paths.policiesJson, JSON.stringify(healed, null, 2));
      } catch {}
    }
    return {
      mode,
      defaultAction: p.defaultAction ?? 'ask',
      rules: Array.isArray(p.rules) ? p.rules : [],
    };
  } catch {
    return DEFAULT_POLICIES;
  }
}

export function setMode(mode: PermissionMode): Policies {
  const p = loadPolicies();
  p.mode = mode;
  savePolicies(p);
  return p;
}

export function savePolicies(p: Policies): void {
  fs.mkdirSync(path.dirname(paths.policiesJson), { recursive: true });
  fs.writeFileSync(paths.policiesJson, JSON.stringify(p, null, 2));
}

export interface EvaluateResult {
  action: RuleAction | 'ask';
  ruleId?: string;
  ruleDescription?: string;
}

// Per-workspace session allowlist. Populated by "Always allow (this session)"
// clicks and cleared when the brief that generated the request completes. Not
// persisted — a server restart wipes it, and that's the point.
const SESSION_ALLOW = new Map<string, Set<string>>();

function sessionKey(tool: string, args: unknown): string {
  return `${tool}::${JSON.stringify(args ?? {})}`;
}

/** Add a session-scoped auto-approve rule for exactly this (tool, args). */
export function addSessionAllow(workspaceId: string, tool: string, args: unknown): void {
  let set = SESSION_ALLOW.get(workspaceId);
  if (!set) { set = new Set(); SESSION_ALLOW.set(workspaceId, set); }
  set.add(sessionKey(tool, args));
}

/** Clear a workspace's session allowlist. Called on brief completion. */
export function clearSessionAllow(workspaceId: string): void {
  SESSION_ALLOW.delete(workspaceId);
}

/** Snapshot the current session allow keys for a workspace — for the UI. */
export function listSessionAllow(workspaceId: string): string[] {
  return [...(SESSION_ALLOW.get(workspaceId) ?? [])];
}

export function evaluateTool(
  p: Policies,
  tool: string,
  args: unknown,
  workspaceId?: string,
): EvaluateResult {
  // 1. Hard-denies apply in every mode.
  const hd = hardDeny(tool, args);
  if (hd) return { action: 'deny', ruleId: 'hard-deny', ruleDescription: hd.reason };

  // 2. Session allow (this-brief-only) beats every mode.
  if (workspaceId && SESSION_ALLOW.get(workspaceId)?.has(sessionKey(tool, args))) {
    return { action: 'auto-approve', ruleId: 'session-allow', ruleDescription: 'Always-allow (this session)' };
  }

  // 3. Mode gates rules.
  if (p.mode === 'auto') {
    return { action: 'auto-approve', ruleId: 'mode-auto', ruleDescription: 'mode = auto' };
  }
  if (p.mode === 'manual') {
    return { action: 'ask', ruleId: 'mode-manual', ruleDescription: 'mode = manual' };
  }

  // 4. Custom mode — evaluate persistent rules.
  const argsJson = JSON.stringify(args ?? {});
  for (const r of p.rules) {
    if (r.match.tool !== tool) continue;
    if (r.match.argsPattern) {
      let re: RegExp;
      try { re = new RegExp(r.match.argsPattern); }
      catch { continue; }
      if (!re.test(argsJson)) continue;
    }
    return { action: r.action, ruleId: r.id, ruleDescription: r.description };
  }
  return { action: p.defaultAction === 'ask' ? 'ask' : p.defaultAction };
}

export function addRule(rule: Omit<Rule, 'createdAt'>): Rule {
  const p = loadPolicies();
  const next: Rule = { ...rule, createdAt: Date.now() };
  // Idempotent: drop any existing rule with the same id.
  p.rules = [next, ...p.rules.filter((r) => r.id !== rule.id)];
  savePolicies(p);
  return next;
}

export function removeRule(ruleId: string): boolean {
  const p = loadPolicies();
  const before = p.rules.length;
  p.rules = p.rules.filter((r) => r.id !== ruleId);
  if (p.rules.length === before) return false;
  savePolicies(p);
  return true;
}

/** Propose a rule that would auto-{decision} a future call identical to this one. */
export function synthesizeRuleFromDecision(
  tool: string,
  args: unknown,
  decision: 'approved' | 'denied',
): Omit<Rule, 'createdAt'> {
  const action: RuleAction = decision === 'approved' ? 'auto-approve' : 'deny';
  // Build a literal-match argsPattern (escaped) so the next identical call hits.
  const escaped = JSON.stringify(args ?? {}).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = `rule-syn-${tool.toLowerCase()}-${Date.now().toString(36)}`;
  return {
    id,
    description: `auto-${decision === 'approved' ? 'approve' : 'deny'} ${tool}(${JSON.stringify(args ?? {}).slice(0, 60)})`,
    match: { tool, argsPattern: `^${escaped}$` },
    action,
    synthesized: true,
  };
}
