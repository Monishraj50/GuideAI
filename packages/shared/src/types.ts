// S10 · Vessel × Talent × Task — the new runtime primitives.
//
// Splits what used to be an ad-hoc "worker" bundle in phases.ts into two
// orthogonal concerns:
//
//   Vessel  — WHERE the work runs. The sandbox: cwd, tool whitelist, model
//             tier, timeout, retry policy, per-session UUID for --resume.
//             Cheap to swap (send the same talent to a different vessel to
//             try a different sandbox posture).
//
//   Talent  — WHO does the work. The persona: role slug, display name,
//             system prompt, applicable skills, memory-slice context. Cheap
//             to swap (send the same task to a different talent to compare
//             styles).
//
//   Task    — WHAT to do. The current turn's input: prompt, upstream
//             artifacts, phase tag (if any), optional first-user-chunk tag.
//
// Any future "run this on a stricter sandbox" or "switch persona mid-brief"
// gesture becomes a one-liner because the split is already here.

export interface Vessel {
  /** Workspace id — used for event stream + usage accounting. */
  workspaceId: string;
  /** Cwd the runtime adapter spawns the agent in. */
  cwd: string;
  /** Tool names the agent is allowed to call. Empty → read-only default. */
  allowedTools: string[];
  /** Model tier passed to the adapter (haiku / sonnet / opus / mock alias). */
  model: string;
  /** Adapter-facing session UUID (`claude --resume <id>` compatible). */
  sessionId?: string;
  /** Soft ceiling on wall-clock. Adapters may ignore. */
  timeoutMs?: number;
  /** Retry envelope on transient adapter errors. Adapters may ignore. */
  retry?: { max: number; backoffMs: number };
}

export interface TalentSkill {
  name: string;
  body: string;
  source?: string;
}

export interface Talent {
  /** Stable agent id in the workspace roster (agents.id). */
  agentId: string;
  /** Catalog role slug — 'coder', 'planner', 'reviewer', … */
  role: string;
  /** Human display name — "Coder", "Planner", … */
  displayName: string;
  /** Persona system prompt (agents.system_prompt). May be empty for CoS. */
  systemPrompt: string;
  /** Pre-rendered memory-slice block for this role in this workspace. */
  memoryBlock: string;
  /** Skill picked for this task (if any) OR the applicable menu. */
  skill: TalentSkill | null;
  /** Full menu of eligible skills — used only when `skill` is null. */
  skillsMenu: TalentSkill[];
}

export interface Task {
  /** Free-text instruction — the "user" turn of the conversation. */
  prompt: string;
  /** Phase name for context, if any (plan|implement|review). */
  phase?: string;
  /** Brief id for accounting + FEATURE.md linkage. */
  briefId?: string;
  /** Feature slug this task belongs to. Used for the first-user chunk tag. */
  featureSlug?: string | null;
  /** When true, prepend the S6 `[feature · user]` tag on the first turn. */
  tagFirstTurn?: boolean;
  /** Caller-owned system-prompt fragments — inserted between memory and the
   *  skill block. Used by phases.ts to pass the PHASE_PROMPT and by
   *  directTask.ts to pass the "## Direct task" preamble. */
  systemPromptExtras?: string[];
}
