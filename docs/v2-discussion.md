# GuideAI v2 — Discussion Log

This document captures the design discussion that produced [v2-plan.md](v2-plan.md). Read this for the **why**; read the plan for the **what**.

---

## Goals (from user)

1. Achieve any project/task in an optimized way
2. End-user gets quality work
3. Break bigger projects into small tasks
4. Optimized orchestration, tokens, memory
5. Use SKILLS to execute tasks
6. Simple, easy, useful for the user
7. User gets all logs (.md) and sessions (chat)
8. User can understand the project end-to-end (so they can explain it)
9. Trackable
10. Useful for everything from small fixes to bigger problems — fully optimized

## Reference repos studied

| Repo | Killer idea ported |
|---|---|
| Reference A (TDD/phase-discipline framework) | 3-phase pipeline spine + skills-as-canonical-surface |
| Reference B (multi-runtime kanban UX) | Kanban + live chat + per-session token/$ accounting + hunk-level diff review |
| Reference C (hierarchical "AI company") | **Vessel/Talent split**, iterative V1→V2→V3 with approval gates, repeated-task auto-distillation |
| Reference D (meta-harness with swarm/RAG/hooks) | **Hooks-as-policy** (6 of their 27 hooks), GOAP-light goal decomposition, optional vector recall (deferred) |

Internal-only mapping; user-facing strings stay generic (`dev-skills-pro`, `agent-pack-core`, etc.).

---

## Q&A — design decisions

### Q1 — What's the flow if a user comes with goal + budget?

```
1. Brief Composer → goal + budget
2. classifyBrief() → 'quick' or 'heavy'
3a. QUICK: pickSkill → single agent → diff webview → approve → done
3b. HEAVY: decompose → task tree in Kanban Backlog
   For each task (drag Backlog → Plan):
     plan → implement → review  (3-phase, gates between)
     pickSkill at start of each task
     live chat streams turns
     diff webview at end
4. Budget meter ticks live (status bar)
   pre-phase:budget-cap hook halts if cap hit
5. post-phase hook writes memory note + outcome
6. Logs on disk: <repo>/.guideai/features/<slug>/sessions/<id>.{jsonl,md}
```

### Q2 — How are sessions and context saved? What level? How does a new agent get context efficiently?

**Three tiers on disk:**

```
<repo>/.guideai/
  PROJECT.md                    ← root TOC, auto-maintained
  features/<slug>/
    FEATURE.md                  ← per-feature state + decisions + session table
    sessions/<id>.jsonl         ← source of truth (Claude CLI native)
    sessions/<id>.md            ← rendered view (debounced from jsonl)
```

**Three context levels at retrieval (cheap → expensive):**

| Level | Size | When |
|---|---|---|
| L1 — Memory slice | ~1.2k tokens | Always |
| L2 — Task summaries | ~5k tokens | When task is similar (skill/file match) |
| L3 — Full chat replay | ~50–200k tokens | Only when user explicitly tags `[continue:<id>]` |

**New agent's lookup:**
1. L1 memory loaded automatically
2. L2 picks top 3 task summaries by file overlap + skill match + BM25 on titles
3. L3 skipped unless explicit
4. Distillation runs once at task end (cheap Haiku call)

### Q3 — Root .md → feature .md → sessions. Suggest more optimized approach.

**Optimized version uses 4 wins:**

1. **Frontmatter on every file** — agent filters by `status`/`role`/`files` without reading bodies
2. **File-path index in `PROJECT.md`** — one grep → know which feature owns a file, no semantic reasoning needed
3. **Decisions section in `FEATURE.md`** — agent reads 10 lines of decisions, skips re-reading the session that made them; sessions become archive
4. **Auto-rewrite `PROJECT.md` after each session** — root stays current without manual maintenance

```
features/<slug>/
  FEATURE.md      ← frontmatter + Goal + Decisions + Open + Sessions table + session pointers
  HISTORY.md      ← (optional 4th tier if FEATURE.md > 5k tokens)
  sessions/...
```

Typical fix context: **3–5k tokens.**

### Q4 — How are chat sessions stored?

**JSONL (machine-readable) + MD (human-readable rendered view).**

```
features/<slug>/sessions/
  <iso-ts>__<brief-slug>.jsonl   ← source of truth, one chunk per line
  <iso-ts>__<brief-slug>.md      ← regenerated from jsonl, debounced ~1s
```

JSONL chunk format:
```json
{"ts":1719572602,"role":"user","text":"add a login form"}
{"ts":1719572605,"role":"assistant","model":"sonnet","text":"I'll scaffold..."}
{"ts":1719572610,"role":"tool","tool":"Read","args":{...},"result":"..."}
{"ts":1719572650,"role":"phase","phase":"review","status":"completed","tokensIn":4231,"tokensOut":890,"cost":0.012}
```

**Pipeline:** Claude CLI stream-json stdout → adapter → `appendEvent` writes jsonl line → SSE pushes to live-chat webview → `transcriptWriter` re-renders MD.

**On session end:** Haiku distillation (1 call) → 5-line "decisions + outcome" → appended to `FEATURE.md`. SQLite row added to `sessions` index.

**Reads:** default = 5-line distilled summary from `FEATURE.md`. JSONL never loaded unless explicitly needed.

### Q5 — Make `claude --resume` show feature and user-level history.

**Two-layer:** native CLI picker + GuideAI-native picker.

1. **Tag first user chunk** of every session: `[<feature> · <user>] <brief>` — Claude's native `--resume` picker shows readable titles.
2. **Sessions land in Claude CLI's project dir** — `runtime-claude` already spawns the CLI, so `.jsonl` files already land in `~/.claude/projects/<encoded-cwd>/`. We just control naming.
3. **VSCode command `guideai.resumeSession`** — grouped tree picker:
   ```
   ├─ 📁 login-ui (3 sessions)
   │   ├─ 2026-06-28  add a login form
   │   ├─ 2026-06-29  fix validation
   │   └─ 2026-06-30  add magic-link
   ```
   Click → `claude --resume <id>` in correct cwd → live chat reopens.

### Q6 — Store session IDs in .md so an agent can resume the right one.

**FEATURE.md gets a Sessions table:**
```md
## Sessions
| Session ID | Date | Did | Outcome |
|---|---|---|---|
| `sess_a1b2c3` | 2026-06-29 | wired API | ✓ shipped |
| `sess_9f8e7d` | 2026-06-28 | scaffolded | ✓ merged |
| `sess_4c3b2a` | 2026-06-27 | spike | ✗ abandoned |
```

**Fix-flow:**
```
User: "fix the email validation bug"
  → PROJECT.md → file match → feature = login-ui
  → FEATURE.md → BM25 match "validation" → sess_9f8e7d
  → claude --resume sess_9f8e7d   (0 token cost; Claude cache holds it)
  → new turns append to same .jsonl
  → post-session: FEATURE.md row updated
```

**Why this beats rebuilding:** resume reuses Claude's prompt cache → cheaper + faster + zero tokens injected.

### Q7 — Can we use Memory from Reference D?

Yes — borrow the ideas, skip the heavy infra. **Three tiers:**

1. **What we already have** (covers ~85% of needs): flat-file + frontmatter filtering + BM25 on session summaries
2. **Tier 2 (borrowed, small)** — chosen for v2:
   - Outcome-tagged sessions (✓ / ⚠ / ✗), picker prefers shipped
   - PII scrub hook (5 regexes: email/api-key/token/jwt/phone)
   - `[[wikilink]]` graph hops in FEATURE.md (1-hop traversal)
   - Diversity-rank on retrieval (dedup by file overlap)
3. **Tier 3 (deferred)** — local embeddings (`all-MiniLM-L6-v2`, 22MB) for semantic recall; add only when BM25 misses (50+ features)

**Not ported from Reference D:**
- HNSW (overkill until 1000s of sessions)
- Neural pattern learning (training infra > value at this scale)
- 14-type PII detector (5 regexes cover 90%)
- Federated memory + cryptographic witness manifests (no multi-tenant need)
- Graph DB (markdown wikilinks are enough)

### Q8 — Why not use Reference A's full inventory (67 agents, 271 skills, 92 commands, hooks)?

**Decision:** ship a minimal seed by default + lazy install via packs.

- **Default seed**: ~10 skills, ~8 agents (~50KB)
- **On-demand packs**: `guideai pack install <name>` — clones to `~/.guideai/packs/<name>/`
- **Commands**: skip (their own docs flag them legacy; all map to skills)
- **Hooks**: already in our plan (6 of theirs)

**Pick-time priority:** `_user` > `_custom` > `pack` > `_seed`. User-promoted skills always win.

### Q9 — How are packs sourced + validated?

**Source: Git.** `guideai pack install <pack-name>` resolves the name through a static registry JSON (in a public repo) to a Git URL, `git clone --depth 1` into `~/.guideai/packs/`.

**Pack metadata:** `pack.json` declares requirements:
```json
{
  "name": "dev-skills-pro",
  "version": "1.0.0",
  "requires": {
    "tools": ["git", "gh"],
    "files": ["package.json"],
    "runtime": ["claude"]
  },
  "skills": "skills/",
  "agents": "agents/",
  "tags": ["dev", "general"]
}
```

Skills from packs with missing `requires` filtered out silently at pick-time; visible in browser with badge.

### Q10 — Generic pack names, not repo names.

User-facing names only: `dev-skills-pro`, `agent-pack-core`, `workflow-templates`, `frontend-bundle`, `backend-bundle`, `devops-bundle`, `testing-bundle`, `security-bundle`. Underlying repo URLs hidden in registry, swappable without breaking installs.

### Q11 — Default seed = "most useful," rest installed by user as packs.

Confirmed.
- Default skills (10): `add-test · fix-bug · refactor-function · add-feature · write-docs · review-code · rename · extract-function · debug · format`
- Default agents (8): `planner · coder · reviewer · tester · refactorer · debugger · doc-writer · researcher`

### Q12 — High-level sidebar sketch?

```
GUIDEAI ▾
  🚀 START
    ▸ New brief / Quick task / Open Kanban
  📂 FEATURES
    ▾ login-ui  ● in-progress
       ▸ sess_a1b2c3  ✓ today
       ▸ sess_9f8e7d  ✓
       ▸ sess_4c3b2a  ✗
    ▸ auth     ✓ shipped
    ▸ billing  ○ planned
  ⚙ ACTIVE WORK
  👥 TEAM (planner/coder/reviewer/...)
  🛠 SKILLS & PACKS
  📊 PROGRESS (4/12 · $0.34 / $2.00)

Status bar:  ●  GuideAI · ↓12k ↑3k · $0.04 · sonnet
```

Sessions live UNDER features. Status dots are the unit of glance-ability. No `/logs` section (sessions ARE the logs).

### Q13 — How is data stored? Multi-window behavior?

**Two-tier storage:** per-repo (project data) + global ($HOME, cross-project knowledge).

```
GLOBAL  ~/.guideai/
  registry.db · skills/_seed · packs · agents-memory · settings · integrations

PER-REPO  <repo>/.guideai/
  workspace.db · PROJECT.md · features/ · skills/_user · skills/_custom
  hooks.json · meta.json · .gitignore
```

**Multi-window:**
- 2 windows on 2 repos → fully isolated, no log bleed
- 2 windows on same repo → shared `.guideai/` (SQLite WAL handles reads, single server attaches via PID lock on `~/.guideai/server.pid`)
- Sidebar Features section shows only current window's repo

**Cross-workspace opt-in:** role memory (default `read-only`, can be `all`/`deny`), promoted skills (manual promote command), installed packs (one global install benefits all repos)

**Git-friendliness:**
- ✅ Committed: `PROJECT.md`, `FEATURE.md`, custom skills, hooks
- ❌ Gitignored: `workspace.db`, `sessions/*.jsonl`, `diffs/`

### Q14 — Branding: keep `guideai`.

User reversed an earlier consideration of renaming to `.atrune` — keep the existing `guideai` name throughout. v2 docs use `GuideAI` consistently. Existing code has mixed `Atrune*` references (`AtruneServer`, `atrune.openTaskTranscript`) that should be normalized to `guideai`/`GuideAI` during S1 cleanup.

### Q15 — Cut features list

**Cut from v1:** roundtable, critics, marketplace, /logs UI, /board, design-shotgun, cross-vendor review, slides/explainer, GitHub bootstrap, browser validation, daily digest, approval UI, apps/web, evals, runtime-openai.

**Keep + trim:** apps/server (6 routes), apps/vscode (only UI), orchestrator (stripped modules), runtime-claude, skills (extended), messaging, policies, permission-hook, agents-catalog (trimmed to seed), metrics, shared (trimmed tables), runtime-core.

### Q16 — Build incrementally, one feature at a time.

Confirmed. 13 steps in [v2-plan.md](v2-plan.md), each shippable + verifiable in isolation. User checks demo at end of each step before moving to next.

### Q17 — How are Claude's tool permissions handled?

Claude CLI's `PreToolUse` hook fires a binary we ship (`packages/permission-hook/bin/`). The binary POSTs to `/api/permissions/evaluate`. The server applies policies and either auto-allows, auto-denies, or asks the user.

```
Claude tries tool → PreToolUse hook → guideai-perm-hook binary
   → POST /api/permissions/evaluate (apps/server)
   → Server checks policies.json + workspace rules
       ├─ Auto-allow  (Read/Glob/Grep)
       ├─ Auto-deny   (rm -rf, --no-verify, paths outside consented folder)
       └─ Ask user    → VSCode toast / sidebar panel
   → Decision → hook returns approve/deny → tool runs or aborts
```

### Q18 — Add a dedicated permission UI surface + three modes.

**Locked design (S2.5):**

| Decision | Choice |
|---|---|
| Default mode | **Manual** (every tool call asks) |
| "Always allow" scope | **This session only** — rule cleared when brief/pipeline ends |
| Edit/Write previews | **Show before/after diff** in the prompt |
| Killswitch | Pinned to the panel header; independent of mode |
| Auto-timeout on pending | 5 minutes → deny |

**Three modes:**
- **Auto** — accept everything safe; hard-denies still apply
- **Manual** (default) — every tool call asks
- **Custom** — rules editable per-repo via webview

**Where it lives in the sidebar:**

```
ATRUNE ▾
  ┌──────────────────────────────────────────────────┐
  │ 🛂 PERMISSIONS              Mode: [Manual ▾] 🛑 │
  ├──────────────────────────────────────────────────┤
  │  ⏳ coder · 14:05                                │
  │     wants to  Edit  src/checkout.ts              │
  │     [before/after diff ▾]                        │
  │     [Allow once] [Allow session] [Deny]          │
  │     [Add rule…]                                  │
  │                                                  │
  │  Recent:                                         │
  │   ✓ 14:03  Read  src/auth.ts        (auto)       │
  │   ✓ 14:03  Edit  src/auth.ts        (you)        │
  │   ✗ 14:04  Bash  "rm -rf ..."       (denied)     │
  └──────────────────────────────────────────────────┘
  🚀 START
  📂 FEATURES
  …
```

Build step: **S2.5** — sits between S2 and S3. ~3 hours of work.

---

## Locked decisions (cross-reference table)

| Decision | Choice | Section in plan |
|---|---|---|
| Web UI | Drop entirely | Scope |
| Server | Keep Fastify on :4000 | Scope |
| Topology | Hierarchical (orchestrator-coordinated) | Architecture |
| Pipeline | 3 phases (plan/implement/review) | S3 |
| Quick lane | Yes — `[quick]` tag + heuristic | S4 |
| Skills role | Primary executor | S5 |
| UI surface | Sidebar tree views + Kanban/Chat/Diff webviews | S13 |
| Storage tier | Per-repo + global | Storage layout |
| Branding | Keep `guideai` (reverted from `.atrune`) | S1 |
| Session resume | Native `claude --resume` via FEATURE.md table | S6, S7 |
| Memory borrowings | Tier 2 only (PII, outcomes, wikilinks, diversity) | S11 |
| Skill/agent default | Minimal seed (10 + 8) | S5 |
| Pack source | Git, generic names | S12 |
| pack.json | Required, declares `requires` | S12 |
| ECC principles | Keep (token/tool/cadence/model discipline) | CLAUDE.md |
| Permission default mode | **Manual** | S2.5 |
| "Always allow" scope | **This session only** | S2.5 |
| Edit/Write prompts | **Show before/after diff** | S2.5 |
