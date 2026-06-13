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

export interface Policies {
  defaultAction: 'ask' | 'auto-approve' | 'deny';
  rules: Rule[];
}

const DEFAULT_POLICIES: Policies = {
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
    return {
      defaultAction: p.defaultAction ?? 'ask',
      rules: Array.isArray(p.rules) ? p.rules : [],
    };
  } catch {
    return DEFAULT_POLICIES;
  }
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

export function evaluateTool(p: Policies, tool: string, args: unknown): EvaluateResult {
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
