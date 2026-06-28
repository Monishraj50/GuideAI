# GuideAI v2 — Final Plan

## Repo conventions (for AI sessions and contributors)

### Token & context discipline
- Pin context to the package you're editing. Don't re-read the whole monorepo each session.
- No verbose comments. One short `// why` line max when intent isn't obvious from names.
- Concise diffs. Don't reformat unrelated code.
- Lean on the hierarchical context store: `PROJECT.md` → `features/<slug>/FEATURE.md` → `sessions/`. Don't dump full session JSONL into context.

### Build cadence
- Build steps below (S1–S13) are gated. Don't start step N+1 until step N has a runnable demo + verified by the user.
- After each step, append a 5-line entry to `docs/build-log-v2.md`: what shipped, what's left, what surprised.

### Model routing
- Scaffolding / boilerplate / distillation → Haiku
- Mainline coding / plan / implement → Sonnet
- Architecture review, security work, complex refactors → Opus

### Tool budget
- `.mcp.json` capped at ≤10 MCPs. Adding one requires retiring one.

### Storage paths
- Global: `~/.guideai/` (settings, packs, seed skills, cross-repo memory)
- Per-repo: `<repo>/.guideai/` (workspace.db, PROJECT.md, features/, custom skills, hooks)
- Env: `$GUIDEAI_HOME` overrides global root

### License
- AGPL-3.0. Substantial runtime code is lifted from a third-party AGPL project.

---

## Context

GuideAI v1 grew to 11 phases, 11 packages, two UIs, and 17 SQLite tables. Most of that surface is unused for the actual job: **take a brief, decompose it, run a quality pipeline, hand the user a reviewed diff.**

v2 strips the unused surface, drops the web UI, and rebuilds the orchestrator around **skills as the primary executor**. The VSCode extension becomes the only UI. Sessions are tracked per feature so an agent can resume the right Claude CLI session natively instead of rebuilding context from scratch.

**Goal**: a VSCode extension where the user briefs a task (one-liner or full project), the orchestrator decomposes it, skills execute each task with the right agent, and the user reviews diffs in-line. Token + $ visible per agent. Memory persists across tasks. Logs land as `.md` files on disk. Cross-workspace knowledge transfers via opt-in shares.

---

## Scope

### Cut from v1
- Discovery round-table · Critic gate + pass@k · Hire orchestration · 154-agent marketplace · `/hire` page · `/logs` UI · `/board` cross-project Kanban · Design-shotgun · Cross-vendor second opinion · Slide deck + explainer · GitHub bootstrap · Browser validation (Playwright) · Daily standup digest · Approval/policy UI · `apps/web` Next.js · `packages/evals` · `packages/runtime-openai`

### Keep (and trim)
- `apps/server` (Fastify, ~6 routes) · `apps/vscode` (the only UI) · `packages/orchestrator` (stripped) · `packages/runtime-claude` · `packages/skills` (extended to executor) · `packages/messaging` · `packages/policies` · `packages/permission-hook` · `packages/agents-catalog` (trimmed to seed of ~8) · `packages/metrics` · `packages/shared` (DB tables trimmed) · `packages/runtime-core`

### New
- **Skill executor** — skill becomes the primary runbook; agent follows it
- **Hierarchical context store** — `PROJECT.md` → `features/<slug>/FEATURE.md` → `sessions/*.jsonl`
- **Session-aware resume** — Claude CLI's `--resume <id>` flow, picked from FEATURE.md session table
- **Quick-task lane** — auto-classify briefs; small fixes bypass decomposition
- **Goal decomposer** — light GOAP-style brief → task tree
- **Vessel/Talent split** — runtime sandbox × swappable persona/skills/memory
- **Hooks-as-policy** — 6 hooks (pre/post-phase, pre-diff, pre-commit, on-skill-pick, on-memory-write)
- **Tier-2 memory borrowings** — outcome tagging, PII scrub, `[[wikilinks]]`, diversity-rank
- **Pack system** — installable skill/agent bundles via git, declared via `pack.json`
- **Diff review webview** — hunk-by-hunk approve/reject
- **Per-repo + global storage** — context lives with the code, packs/memory live globally

---

## Storage layout

```
GLOBAL  (lives in $HOME)
~/.guideai/
  registry.db          ← workspace index, settings, pack manifest
  skills/_seed/        ← default ~10 skills (read-only)
  packs/<name>/        ← installed packs (read-only)
  agents-memory/       ← cross-workspace role memory (share ACL)
  settings.json
  integrations/        ← API keys, chmod 600

PER-REPO  (lives in each project)
<repo>/.guideai/
  workspace.db         ← briefs, tasks, sessions, chunks
  PROJECT.md           ← root TOC (auto-maintained)
  features/<slug>/
    FEATURE.md         ← per-feature state + session table
    sessions/<id>.jsonl ← source of truth (Claude CLI native)
    sessions/<id>.md   ← rendered view (debounced)
    diffs/             ← optional per-session diffs
  skills/_user/        ← promoted from this repo's traces
  skills/_custom/      ← hand-authored for this repo
  hooks.json           ← per-repo hook config
  meta.json            ← {workspaceId, displayName}
  .gitignore           ← excludes workspace.db, sessions/, diffs/
```

### Retrieval flow (cheap → expensive)

```
User: "fix email validation in login"
       ↓
1. Read PROJECT.md (~1k tokens) → file/keyword match → feature = login-ui
       ↓
2. Read features/login-ui/FEATURE.md (~2k tokens)
       ↓
3. pickSession() = BM25 × outcome-prefer-shipped × diversity-rank
       ↓
4. claude --resume <sessionId>     (0 tokens injected; Claude cache holds it)
       ↓
5. New turns append to same .jsonl
       ↓
6. post-phase hook: update FEATURE.md, refresh PROJECT.md
```

**Total typical context: 3–5k tokens.**

---

## Build order — one feature at a time

Each step ends with a runnable demo the user verifies before moving to the next.

### S1 · Strip (foundation)

**Demo:** extension activates, old features gone, old pipeline still runnable in degraded mode.

- Delete `apps/web/`, `packages/evals/`, `packages/runtime-openai/`
- Strip orchestrator modules: `discovery.ts`, `critique.ts`, `digest.ts`, `hiring.ts`, `validate.ts`, `github.ts`, `diagnoseFailure.ts`; trim `deliverables.ts`
- Drop server routes + DB tables for cut features (one-shot migration)
- Trim `agents-catalog` to 8 seed agents
- Verify: extension loads, `~/.guideai/` exists, server boots on :4000

### S2 · Hierarchical context store

**Demo:** brief runs → `PROJECT.md` shows feature; `FEATURE.md` shows decisions + session pointer. `cat` works without VSCode.

- New `packages/orchestrator/src/contextStore.ts`
  - `ensureProjectMd(workspaceId)`, `upsertFeature(slug, fields)`, `appendDecision(slug, text)`
  - `rebuildProjectTOC()` — auto-rewrites root with feature table + file-path index
- New per-repo init: first brief creates `<repo>/.guideai/` + `PROJECT.md`
- Hook into existing transcriptWriter so chunks also drive `FEATURE.md` updates (debounced)
- `.gitignore` auto-written
- Verify: trigger 2 briefs on different features → both visible in PROJECT.md with correct files

### S2.5 · Permission UI

**Demo:** every tool call in a manual-mode brief surfaces in the sidebar with diff preview; user clicks Allow/Deny and the pipeline continues.

Locked design decisions:
- **Default mode: Manual** — every tool call asks (safest onboarding).
- **"Always allow" scope: this session only** — rules cleared when the brief/pipeline completes.
- **Edit/Write previews: show before/after diff** inline in the prompt.

Modes:
- **Auto** — accept everything safe (hard-denies for `rm -rf`, `--no-verify`, paths outside the consented folder still apply).
- **Manual** — ask every tool call (default).
- **Custom** — rule-based: `Read/Glob/Grep` auto-allow, `Bash` asks, etc. Rules editable per-repo.

Components:
- New tree-view provider `apps/vscode/src/views/permissions.ts` — pinned to top of sidebar, always visible.
  - Header: `🛂 PERMISSIONS  Mode: [Custom ▾]`  + 🔴 killswitch button
  - Body: pending request (with diff for Edit/Write) + last 5 decisions
- Mode dropdown command `atrune.setPermissionMode` — writes to `<repo>/.atrune/policies/rules.json` and global `~/.atrune/policies.json`.
- New webview `apps/vscode/src/webviews/rulesEditor.ts` — table of patterns (allow/ask/deny), per-repo overrides, "Add rule from this request" affordance.
- Server-side session allowlist — in-memory `Map<workspaceId, Set<rulePattern>>` cleared on brief completion. Survives only for the current pipeline run.
- Existing `/api/permissions/evaluate` + `/api/permissions/:id/decision` endpoints already exist — wire UI to them.
- Existing toast prompt stays as fallback when the sidebar is collapsed; main interaction moves to the panel.
- Pending requests stream via SSE to the panel — no polling.

Auto-timeout: pending request auto-denies after 5 minutes (configurable).

Verify:
1. Fresh install → mode = Manual. Brief "rename foo to bar in utils.ts" → permission panel shows `Edit utils.ts` with before/after diff. Allow once → file written; Allow always → rule added for `Edit utils.ts` for this session; second Edit on same file auto-allows; brief finishes; rule cleared.
2. Mode toggled to Auto → same brief runs straight through, no prompts.
3. Mode = Custom + rule `Bash: git status — allow` → `git status` runs silently; `git push` still asks.
4. Killswitch click → all pending requests denied; running agent killed; status bar shows `Atrune · stopped`.

### S3 · Simplified 3-phase pipeline

**Demo:** end-to-end task in ~40% less wall time than v1's 5-phase run.

- Reduce `PHASE_ORDER` to `plan → implement → review`
- Fold research into plan-phase prompt
- Fold verify into review-phase prompt
- Update `taskGate.ts` for 3 phases
- Kanban columns: Backlog · Plan · Implement · Review · Done
- Verify: brief "add a hello-world endpoint" runs through 3 phases; transcripts in correct dirs

### S4 · Quick-task lane

**Demo:** "fix typo in README line 42" → diff appears in ~15s, no kanban entry created.

- New `classifyBrief(brief)` returns `'quick' | 'heavy'` (heuristic: ≤100 chars OR single file OR explicit `[quick]` tag)
- Quick path: skip decompose, single skill invocation, single chat panel, no kanban entry
- Heavy path: unchanged (decompose + kanban + pipeline)
- Verify: quick-tagged brief lands diff fast; heavy-tagged brief still creates tasks

### S5 · Default seed skills + skill-first executor

**Demo:** brief "add a test for `parseDate()`" → chat shows `Selected skill: add-test` → agent follows skill runbook → test file lands.

- Seed `~/.guideai/skills/_seed/` with 10 skills: `add-test · fix-bug · refactor-function · add-feature · write-docs · review-code · rename · extract-function · debug · format`
- Seed 8 agents in `agents-catalog`: `planner · coder · reviewer · tester · refactorer · debugger · doc-writer · researcher`
- New `packages/skills/src/pickSkill.ts` — match task → best skill (keyword + `appliesTo` + tag)
- New `packages/skills/src/invoke.ts` — skill body becomes runbook
- `cos.ts` calls `pickSkill` before falling back to phase prompts
- Pick priority: `_user` > `_custom` > `_seed`
- Verify: each seed skill invocable end-to-end; chat panel shows skill provenance

### S6 · Session IDs in FEATURE.md

**Demo:** complete 3 tasks on one feature → `cat FEATURE.md` shows session table with IDs, dates, outcomes.

- Every Claude CLI spawn captures session ID; first user chunk tagged `[<feature> · <user>] <brief>`
- post-phase hook appends row to FEATURE.md's `## Sessions` table with outcome (`✓ shipped` / `⚠ partial` / `✗ abandoned`)
- SQLite `sessions(id, featureSlug, briefId, startedAt, tokensIn, tokensOut, cost, jsonlPath, outcome)`
- Verify: 3 sessions land in 3 rows; outcomes set correctly based on review verdict

### S7 · Session-aware resume

**Demo:** brief "tweak the validation again" → agent picks the right session, runs `claude --resume <id>`, prompt cache warm, new turns append.

- New `packages/orchestrator/src/resume.ts` — `pickSession(feature, query)` = BM25 × outcome-prefer-shipped × diversity-rank
- `runtime-claude` already supports `--resume <id>`; wire it through
- New VSCode command `guideai.resumeSession` — quick pick grouped by feature
- Sidebar tree view: `Features → <slug> → <sessionId>` (click → reopen live chat with native context)
- Verify: keyword-matching brief picks correct session; cache reuse measurable in cost report

### S8 · Goal decomposer

**Demo:** brief "build a TODO CLI with add/list/done" → 6–8 tasks appear in Kanban Backlog, dependency-ordered.

- New `packages/orchestrator/src/decompose.ts` — input: brief + project context; output: task tree
- Light GOAP-style: each task declares `preconditions`, planner topologically orders
- Each task carries: role hint, skill hint, acceptance test stub
- Tasks land in Backlog, ready to drag
- Verify: multi-step project decomposes cleanly; dependencies prevent out-of-order drag

### S9 · Diff review webview

**Demo:** task completes → diff webview pops → accept 3 of 5 hunks → only those write to disk.

- New `apps/vscode/src/webviews/diffReview.ts` — hunk approve/reject per task
- Replaces current "open .md transcript" flow for completed tasks
- Approve all / reject all / per-hunk selection
- Per-hunk reject = orchestrator records as `⚠ partial`, can spawn follow-up task
- Verify: 5-hunk diff → user accepts 3 → file diff matches selection

### S10 · Vessel/Talent split (refactor, no user-visible change)

**Demo:** existing flows unchanged from user POV; internally goes through `vessel × talent`.

- Define `Vessel` (runtime sandbox: tools, retry, timeout, cwd) + `Talent` (persona, skills, memory slice) in `packages/shared/src/types.ts`
- Refactor `phases.ts` to take `(vessel, talent, task)`
- `pickTalent(role)` reads agent catalog + memory slice
- `makeVessel(workspaceId, role)` builds sandbox
- Verify: golden-path brief produces identical chat transcripts vs S9 (regression check)

### S11 · Hooks-as-policy + Tier-2 memory

**Demo:** secret-scan hook blocks a diff containing an API key; PII scrub redacts emails before memory write; outcome tag flips when review verdict changes.

- New `packages/policies/src/hooks.ts` — 6 hooks (pre-phase, post-phase, pre-diff, pre-commit, on-skill-pick, on-memory-write)
- Per-workspace `hooks.json` config
- Built-in hooks:
  - `pre-phase:budget-cap` — halt if budget exceeded
  - `pre-diff:secret-scan` — block on detected secrets
  - `on-memory-write:pii-scrub` — strip email/api-key/token/jwt/phone via 5 regexes
  - `post-phase:skill-promote` — capture trace → `_user` skill
  - `post-phase:outcome-tag` — set ✓/⚠/✗
- Diversity-rank helper added to retrieval (dedup by file overlap)
- `[[wikilink]]` parser for cross-feature traversal
- Verify: 4 sub-demos (secret block, PII redact, outcome tag, diversity-rank dedups same-file sessions)

### S12 · Pack system

**Demo:** `guideai pack install dev-skills-pro` clones, validates, installs → 271 new skills available; chat panel shows `← from pack: dev-skills-pro v1.0` when one fires.

- New `packages/orchestrator/src/packs.ts` — install/uninstall/list, validates `pack.json`
- Registry: static JSON in a public GitHub repo (`guideai/packs-registry`), generic pack names — no source repos shown to user
- `pack.json` schema: `{name, version, requires: {tools, files, runtime}, skills, agents, hooks, tags}`
- Install path: `git clone --depth 1` → `~/.guideai/packs/<name>/`
- VSCode commands: `guideai.browsePacks`, `guideai.installPack`, `guideai.uninstallPack`
- Pack browser webview (gallery view with install/missing-deps badges)
- Pick-time gate: skills from packs with missing `requires` filtered out silently; visible in browser with badge
- Pack provenance shown in live chat panel when skill fires
- Verify: install + uninstall a pack; a skill from the pack picks correctly; missing-deps pack shows badges

### S13 · Sidebar + polish

**Demo:** fresh install → first project → first task → first diff → first approval, no docs needed.

- Sidebar tree views (per the agreed sketch):
  - 🚀 Start (New brief, Quick task, Open Kanban)
  - 📂 Features (with status dots + session children)
  - ⚙ Active Work
  - 👥 Team
  - 🛠 Skills & Packs
  - 📊 Progress
- Status bar: `● GuideAI · ↓Nk ↑Nk · $X.XX · model`
- Live chat panel: collapsed "What this role knows" memory section
- Brief composer: 3 fields (goal, constraints, budget)
- Outcome badges on session items (✓ ⚠ ✗)
- README rewrite (v2 quick start)
- Verify: cold-install onboarding flow runs end-to-end without external docs

---

## Reusable functions to lean on (do NOT reimplement)

| Function | Location | Used by |
|---|---|---|
| `appendEvent`, SSE stream | `packages/messaging` | Live chat + kanban + diff review |
| `transcriptWriter.makeStreamingAppender` | `packages/orchestrator` | `.md` chat rendering |
| `routeRoster`, tier router | `packages/orchestrator/routing.ts` | Haiku/Sonnet/Opus routing |
| `taskGate.acquire/release` | `packages/orchestrator/taskGate.ts` | Phase gates |
| `loadSkills`, `skillsForPhase` | `packages/skills/index.ts` | Skill discovery |
| `promoteSkillFromTrace` | `packages/skills/promote.ts` | Stop-hook capture |
| `loadAgentMemoryForRole`, `renderMemoryBlock` | `packages/orchestrator/memory.ts` | Cross-task memory |
| `paths.skills`, `paths.workspaceDir` | `packages/shared/paths` | Filesystem layout |
| Kanban webview pattern | `apps/vscode/src/webviews/kanban.ts` | New diff-review webview |

---

## Final acceptance

After S13, all of these must hold:

1. Fresh install → `pnpm install && pnpm dev` → extension activates, server up, no errors.
2. Quick lane: 1-liner brief → diff webview in ≤ 15s, no kanban entry.
3. Heavy lane: multi-step brief → 5+ tasks in Backlog, dependency-ordered, all complete in ≤ 10 min on Sonnet.
4. Skill-driven: seed skill fires, chat shows provenance, file lands correctly.
5. Memory carries across workspaces (with read-only share).
6. Token + $ meter updates live in status bar.
7. PII scrub redacts secrets in memory writes.
8. Logs on disk under `<repo>/.guideai/features/<slug>/sessions/<id>.{jsonl,md}` — `cat`-able without VSCode.
9. No `apps/web` references in code (only git history).
10. Package count: 9 (down from 11).
11. `cat PROJECT.md` shows all features with file mappings + latest session IDs.
12. `claude --resume sess_xxx` from inside repo cwd reopens the right session with `[feature · user] brief` title.
13. Diversity rank: 5 sessions touching same file → retrieval returns 3 touching different files.
14. Pack install/uninstall works; skill from installed pack picks; missing-deps pack shows badges.
15. Multi-window: 2 VSCode windows on 2 different repos → no log bleed; server reused, not duplicated.

---

## Risks / open items

- **DB migration**: v1 → v2 schema drops several tables. One-shot script preserves workspaces/agents/briefs/chunks/tasks; tests on backup first.
- **Skill seed quality**: 10 hand-written skills must generalize; validate during S5 with 3 sample projects.
- **Quick-lane classifier**: heuristic will misclassify some briefs; manual override via `[quick]` / `[heavy]` tag.
- **Goal decomposer**: GOAP-light handles ≤ 10 tasks; recursive decomposition out of scope for v2.
- **Hook performance**: 6 hooks × 3 phases × N tasks adds latency; each hook capped at 50ms or marked async-only.
- **Pack provenance**: pack `source` URLs hidden from user; we can rotate forks without breaking installs.
- **Multi-window server**: single-port :4000 needs PID-file coordination; second window attaches as client.
- **Branding consistency**: existing code has mixed `Atrune*` / `guideai` references (e.g. `AtruneServer`, `atrune.openTaskTranscript`). Decide once and audit; v2 docs use `GuideAI` consistently.
