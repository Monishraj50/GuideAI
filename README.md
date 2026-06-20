# AtruneAI

> Your AI workplace. Brief your team. Review their work. Ship faster.

AtruneAI is a multi-agent platform where **you direct, AI executes**. Hire from a 154-agent marketplace, dispatch a brief, and watch a phase-gated pipeline (research → plan → implement → review → verify) run with budget caps, cross-vendor sanity-checks, browser validation, and live dashboards. Everything stays on your machine.

- **Local-first** — SQLite + filesystem at `~/.guideai/`. No backend service required.
- **Per-user credentials** — Claude CLI / Anthropic key / OpenAI key / GitHub PAT all stored locally, `chmod 600`.
- **Day-1 runtime** — Claude Code CLI; OpenAI used for cross-vendor review; adapter interface ready for Codex/Copilot/Gemini.
- **AGPL-3.0** licensed.

---

## Quick start

**Requirements**: Node ≥ 20 · pnpm 9 · (optional but recommended) Claude Code CLI installed and logged in.

```bash
# Install
git clone <repo> && cd <repo>
pnpm install

# Initialize the local database (creates ~/.guideai/)
pnpm init-db

# Boot the server (port 4000) + Next.js UI (port 3000) together
pnpm dev
```

Open **http://localhost:3000** → click *Continue as guest* on the sign-in page → land on Mission Control.

Guest mode uses a deterministic **MockAdapter** — every feature works end-to-end without an API key, with fake-but-plausible responses. To hook up the real Claude, go to **Settings → Claude integration** and either connect the CLI or paste your Anthropic API key.

---

## What's inside

### One-line tour

```
intake → discovery round-table → critic gate (CEO + Eng) → plan review →
hire orchestration → pipeline (research → plan → implement → review → verify) →
WBS auto-seed → dashboard → deliverables harvest → browser validation →
explainer + slide deck → GitHub bootstrap → cross-vendor review → agent memory →
design-shotgun
```

### Feature matrix

| Phase | What it gives you | UI surface |
|---|---|---|
| **Budget governor** | Per-workspace daily/monthly $ caps + 5h token cap. Pause / downgrade / warn behavior. Live HUD pills in the TopBar. Supports USD/EUR/GBP/INR/JPY/tokens with 30% planning buffer. | Settings → Budget · TopBar HUD |
| **Project intake** | Goal, success criteria, constraints, budget hint (currency or tokens), planning mode (auto/assisted/manual), hiring mode (auto/hybrid/manual). | Project page → top |
| **Discovery round-table** | 5 specialist agents (Product Strategist, Tech Lead, Finance Analyst, UX Researcher, Risk Officer) each weigh in. Synthesizes recommended roles, ballpark cost, risks, success metrics. | Project page → Discovery card |
| **Multi-perspective critic gate** | CEO + Eng critics review the synthesized plan before dispatch. Block on `reject` or `needs-revision`. Force-dispatchable. | Project page → Plan review |
| **Plan-review surface** | Editable summary, recommended roles, metrics, risks, benefits. Live hire-dispatch preview by mode. | Project page → Plan review |
| **Hire orchestration** | 154-agent catalog. Auto = hire all recommended. Hybrid = safe defaults auto, rest queued. Manual = user approves every hire. Role aliasing maps shorthand to catalog roles. | Project page · /hire |
| **Sequential phase pipeline** | research → plan → implement → review → verify. Each phase routed by tier (Haiku for research/verify, Sonnet for plan/implement, Opus for review/security). pass@k checkpoints. | Project page · /logs |
| **Work Breakdown Structure (WBS)** | Auto-generated work items per role/risk/metric. Drag-drop Kanban. Pipeline ticks items done as phases complete. | Project page → Dashboard · /board (cross-project) |
| **Progress dashboard** | KPI strip, items burndown, cost burndown with budget baseline, velocity stat. | Project page → Dashboard |
| **Deliverables** | Auto-harvested phase artifacts, slide deck (10 slides), plain-English explainer (haiku-generated, ~$0.001). Manual link/file attachments. Slide viewer with arrow-key nav. | Project page → Deliverables |
| **GitHub bootstrap** | Per-workspace repo binding. Push deliverables (README from deck + EXPLAINER.md + docs/{phase}.md). Sync WBS → issues. gh CLI primary, PAT fallback. | Settings → GitHub · Project page → Repo |
| **Cross-vendor second opinion** | Security-tagged briefs route 1 of 3 review attempts through OpenAI (independent verification across model families). Per-user OpenAI key + per-workspace toggle. | Settings → OpenAI · Project page → toggle |
| **Browser-driven validation** | Real Chromium (Playwright) drives the user's app to validate success criteria. Persisted regression scripts. Per-step screenshots. URL allowlist. Mock fallback if Playwright not installed. | Project page → Validation |
| **Cross-workspace agent memory** | Per-role notes that travel between projects, gated by share ACL (all / read-only / deny). Memory block prepended to role's system prompt at every phase. | Project page → Agent memory |
| **Design-shotgun** | `[design]` brief tag fans implement out to 4 parallel variants (mvp-first / power-user / first-timer / accessibility). Pick one → taste memory feeds future design briefs. | Project page → Deliverables |
| **Approval & policy engine** | Per-tool/per-path rules. Auto-approve read-only ops; always-ask on `rm`/`git push`; deny `--no-verify`. Synthesize rules from denied actions. | /settings (rules) |
| **Killswitch** | Per-agent + global "stop the world". Audit log persisted. | Sidebar |
| **Daily standup digest** | Cron at 09:00 local — Chief-of-Staff agent summarizes 24h: shipped / blocked / awaits-you. | / (Home) |
| **Skill promotion** | Stop-hook auto-distills successful pipeline traces into reusable skills under `~/.guideai/skills/`. | /settings (audit) |
| **154-agent marketplace** | Hire / preview prompts / retire / create custom roles. From `awesome-claude-code-subagents`. | /hire |
| **Replay / trace view** | Per-brief flame-graph + raw JSONL drawer + diff scrubber. | /logs/[briefId] |
| **Cross-project Kanban** | Aggregate work items by status across all workspaces with filters (phase/priority/role/search) and drag-drop. | /board |

---

## The flow, end to end

```
┌────────────────┐    ┌──────────────────┐    ┌────────────────┐
│  Intake form   │ →  │ Discovery panel  │ →  │ Critic gate    │
│ goal · budget  │    │ 5 specialists    │    │ CEO + Eng      │
│ planning mode  │    │ → synthesis      │    │ verdicts       │
└────────────────┘    └──────────────────┘    └────────┬───────┘
                                                       ↓
┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────────┐
│  Browser validation │ ←  │  Pipeline (5 phases)│ ←  │ Plan review      │
│  Playwright drives  │    │ research → ... →    │    │ + hire dispatch  │
│  the user's app     │    │ verify              │    │ (auto/hybrid/man)│
└─────────────────────┘    └────────┬────────────┘    └──────────────────┘
                                    ↓
                       ┌──────────────────────────┐
                       │  Deliverables harvest    │
                       │  artifacts · deck ·      │
                       │  explainer · regression  │
                       └──────────┬───────────────┘
                                  ↓
                       ┌──────────────────────────┐
                       │  Optional: GitHub push   │
                       │  README · docs · issues  │
                       └──────────────────────────┘
```

Every phase respects:
- **Budget cap** — forecasts cost, downgrades model tier or pauses if exceeded
- **Approval rules** — every tool call routed through the PreToolUse hook
- **Cross-workspace memory** — role-specific notes prepended to the system prompt
- **Critic gate** — won't dispatch a plan the CEO or Eng critic flags as `reject`
- **Token-cost ledger** — every adapter call recorded, surfaced in TopBar HUD + budget panel

---

## Setup checklist

After `pnpm dev` and signing in, you'll want to configure:

1. **Settings → Budget & rate limits** — set daily $ cap + 5h token cap; choose currency or tokens; pick warn/downgrade/pause behavior.
2. **Settings → Claude integration** — connect the CLI *or* save an Anthropic API key (per-user, `chmod 600`).
3. **Settings → OpenAI integration** *(optional)* — paste an OpenAI key to enable cross-vendor review.
4. **Settings → GitHub** *(optional)* — connect `gh` CLI or save a PAT for repo push + issue sync.
5. **Settings → Approval rules** — review the default auto-approve / always-ask / deny list.

Per project, you'll also configure (on the project page):

- **Intake** — goal, criteria, budget hint (currency/tokens), planning + hiring modes
- **Memory share** (optional) — `all` / `read-only` / `deny` for cross-project agent memory
- **GitHub repo** (optional) — link existing or create new
- **Validation target** (optional) — URL + allowlist for browser-driven validation
- **Cross-vendor review** (optional) — workspace toggle (requires OpenAI key)

---

## Common workflows

### 1. Ship a brief end-to-end (auto mode)

1. **Projects → New project** → name it.
2. On the project page, fill **Intake**:
   - Goal: *"Build a tiny URL-shortener API"*
   - Success criteria: *"`POST /shorten` returns 200 in <100ms"*
   - Budget hint: `$5 USD` (with 30% buffer applied during planning)
   - Planning mode: **Auto** · Hiring mode: **Auto**
3. Click **Save intake**, then **Run discovery round-table**.
4. The 5-agent panel runs; a plan is auto-drafted; CEO + Eng critics review.
5. If critics pass and the budget fits, the brief is dispatched automatically.
6. Watch the dashboard — WBS items tick from todo → done as phases complete.
7. Open the **Deliverables** section: slide deck, explainer, phase artifacts ready.

### 2. Tight budget that should be flagged

Set budget to `$1 USD`. Run discovery in **assisted** mode. The synthesizer's `costVerdict = over-budget`. Plan-review shows a red banner — *"Estimated cost exceeds your budget (incl. ~30% buffer). Trim scope, raise budget, or force-dispatch to override."* The approve button becomes red `force dispatch (over budget)`.

### 3. Token-based budget

In **Intake → Budget hint**, click the **Tokens** toggle. Enter `100` (= 100,000 tokens). The finance analyst plans against that ceiling instead of dollars.

### 4. Cross-vendor security review

Settings → OpenAI → paste key. Project page → top → toggle **Cross-vendor review** on. Submit a brief starting with `[security]`. The review phase runs pass@3 with 2 Claude attempts + 1 OpenAI attempt. The verdict surfaces provider agreement: *"pass@3 verdict: pass · claude: 2/2 + openai: 1/1"*.

### 5. Design-shotgun

Brief starts with `[design]`. Implement phase fans out to 4 variants in 4 lenses (mvp-first / power-user / first-timer / accessibility). Each is a `design-variant` deliverable. Open the Deliverables grid, click **pick this** on the one you like — siblings are auto-recorded as rejected. Next design brief in the same workspace will see your past pick as taste-memory context.

### 6. Browser validation

Project page → **Validation** section → set target URL (e.g. `http://localhost:5173`) → submit a brief. After the pipeline completes, Playwright launches Chromium, drives the success criteria, captures per-step screenshots, persists the script as a `regression-test` deliverable. **Rerun** replays the persisted script without an LLM call.

### 7. GitHub workspace

Settings → GitHub → connect `gh` CLI (or paste a PAT). Project page → **Repo** section → either **link existing** or **create new**. Use **Push deliverables** to write README from the slide deck + EXPLAINER.md + `docs/{phase}.md`. Use **Sync WBS → issues** to create / update one issue per work item.

### 8. Cross-workspace Kanban

Sidebar → **Board**. Shows work items for the currently-active workspace with phase/priority/role filters + search. Switch projects via the TopBar workspace switcher; the board re-scopes instantly.

### 9. Agent memory across projects

Project A → **Agent memory** → add a note (e.g. `backend-developer: "always default rate-limit windows to 60s on auth endpoints"`). Set Project A's share to `read-only`. When `backend-developer` runs in Project B, that note is prepended to its system prompt.

### 10. Killswitch

Sidebar → red killswitch icon. Stops all running agents in <2s. Audit log records the event.

---

## Stack & architecture

```
apps/
├── web/                # Next.js 15 App Router · React 19 · Tailwind 3
└── server/             # Fastify 5 · SSE · spawns Claude CLI as child process

packages/
├── shared/             # SQLite + Drizzle ORM · paths · types · chunks
├── policies/           # budget governor · model router · MCP/concurrency caps
├── orchestrator/       # phase pipeline · CoS · routing · approvals · WBS ·
│                       # deliverables · github · validate · critique · memory ·
│                       # designShotgun · secondOpinion
├── runtime-core/       # adapter interface · stub registry
├── runtime-claude/     # Claude CLI bridge + MockAdapter + DisconnectedAdapter
├── runtime-openai/     # OpenAI chat completions adapter (cross-vendor review)
├── messaging/          # JSONL inbox + chokidar watcher
├── agents-catalog/     # 154 hireable subagents (from awesome-claude-code-subagents)
├── skills/             # skill bundle loader + Stop-hook promoter
├── evals/              # pass@k checkpoint runner
├── metrics/            # per-agent stats: cost · latency · win-rate · rework
└── permission-hook/    # zero-dep Node PreToolUse hook for Claude CLI

~/.guideai/             # runtime state (created on first run)
├── db.sqlite           # 19 tables
├── workspaces/{id}/    # per-workspace artifacts + screenshots
├── integrations/       # claude.json · openai.json · github.json (chmod 600)
├── skills/             # auto-promoted skill bundles
└── catalog/            # cached agent catalog
```

### Data model (selected tables)

`workspaces` · `project_intakes` · `discoveries` · `plans` · `briefs` · `tasks` · `agents` · `work_items` · `deliverables` · `validation_runs` · `agent_memory` · `design_picks` · `usage_log` · `workspace_budgets` · `workspace_repos` · `approvals` · `users` · `skills` · `metric_snapshots`.

### The ECC principles in this codebase

This project eats its own dogfood. Every principle that runs at runtime is enforced during the build too:

| # | Principle | Runtime expression | Build expression |
|---|---|---|---|
| 1 | Context is infrastructure | Per-agent token ceiling per phase | `CLAUDE.md` caps verbose comments, prefers concise diffs |
| 2 | Lean MCP scoping (≤10) | Per-agent whitelist in policies | `.mcp.json` capped at 10 |
| 3 | Sequential phase gates | research → ... → verify pipeline | Build steps gated; runnable demo before next step |
| 4 | Model-tier routing | Haiku/Sonnet/Opus per phase | Same routing for scaffolding/mainline/architecture |
| 5 | Minimum viable concurrency | `maxConcurrentAgents = 3` | ≤3 build steps in flight |
| 6 | Skills > tools | Auto-promoted skill bundles | `.claude/skills/` for recurring motions |
| 7 | Stop hooks | Per-agent 5-line "what worked" notes | Per-session entry in `docs/build-log.md` |
| 8 | Isolation precedes scale | Per-agent sandboxed cwd | Each `packages/*` dev'd in isolation first |
| 9 | Checkpoint evals (pass@k) | Configurable per phase; k=3 for security | Demo re-run on clean clone before claiming done |
| 10 | No silent truncation | Every cap surfaced as UI meter | Every skip recorded in build log explicitly |

---

## Configuration

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Fastify server port |
| `GUIDEAI_CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `GUIDEAI_GH_BIN` | `gh` | Path to gh CLI binary |
| `GUIDEAI_OPENAI_ENDPOINT` | `https://api.openai.com/v1/chat/completions` | OpenAI chat endpoint |
| `GUIDEAI_PERMISSIONS_URL` | `http://127.0.0.1:4000/api/permissions/evaluate` | PreToolUse hook callback |

### Storage paths

All under `~/.guideai/`:

- `db.sqlite` — main SQLite database
- `workspaces/{id}/` — per-workspace artifact directory (`briefs/{briefId}/*.md`, `agents/{agentId}/`, `events.jsonl`, `validation/{runId}/`)
- `integrations/claude.json` — per-user CLI consent + Anthropic API key (`chmod 600`)
- `integrations/github.json` — per-user gh CLI consent + GitHub PAT (`chmod 600`)
- `integrations/openai.json` — per-user OpenAI key + model overrides (`chmod 600`)
- `skills/*.md` — promoted skill bundles
- `catalog/catalog.json` — cached 154-agent catalog
- `policies.json` — auto-approval rules

### Optional dependencies

- **`playwright`** — for browser-driven validation. `pnpm -F @guideai/server add playwright && pnpm exec playwright install chromium`. Without it, validation falls back to a deterministic mock driver.

---

## CLI / scripts

```bash
pnpm install         # workspace install
pnpm init-db         # create/upgrade ~/.guideai/db.sqlite
pnpm dev             # boot apps/server + apps/web (concurrently)
pnpm typecheck       # tsc --noEmit across packages

# Per-package
pnpm -F @guideai/server dev       # server only
pnpm -F @guideai/web dev          # web only
pnpm -F @guideai/agents-catalog seed   # rebuild the 154-agent catalog
```

The server uses `tsx watch` so any change to `apps/server/**` or `packages/**` hot-reloads.

---

## Security model

- **Single-user, local-first.** All credentials, all data, all artifacts stay on your machine.
- **Per-user file permissions.** All integration JSON files written with `mode: 0o600`.
- **Per-agent sandboxed cwd.** Each agent runs under `~/.guideai/workspaces/{id}/agents/{agent}/cwd/`.
- **PreToolUse hook.** Every tool call from the Claude CLI is intercepted and routed through the policy engine. Approve / deny / auto-approve based on rules in `~/.guideai/policies.json`.
- **Deny-by-default secrets.** `*_TOKEN` / `*_KEY` env vars are not forwarded to agent processes by default.
- **Killswitch.** Global stop-the-world kills every live agent in <2 seconds. Audited in `events.jsonl`.
- **Append-only event log.** Every approval, every tool call, every phase transition logged. No silent edits.
- **Restricted browser-validation vocabulary.** Validation scripts can only use `goto/click/fill/expectText/expectVisible/screenshot`. `goto.url` is templated to `{TARGET}` only — script can't navigate to attacker-controlled origins.

---

## What's not built (yet)

These are documented limitations, not surprises:

- **Two-way GitHub sync.** AtruneAI → GitHub is automatic (push + issue create); GitHub → Atrune is not. Polling-based sync is the documented path; webhooks don't fit a local-first product.
- **Visual diff regressions.** Validation captures screenshots but doesn't compare them across runs. `expectScreenshotMatches` is the follow-up.
- **Prompt-injection ML classifier.** Validation relies on the URL allowlist + restricted vocabulary; no ML guard yet.
- **Streaming OpenAI adapter.** Cross-vendor is one-shot only (review pass@k). For streaming you'd need `send/onEvent` impls.
- **Mobile/touch Kanban.** HTML5 drag-and-drop only; desktop-friendly.
- **Permanent-delete for workspaces.** Archive is soft; the slug stays reserved. Auto-suffix on recreate (`acme-2`) keeps you moving.
- **OpenAI tier pricing.** Billed as Claude `sonnet` in the budget table — order-of-magnitude right, not exact.
- **VS Code extension.** Planned post-v1; reuses all packages.

---

## Troubleshooting

**`/board` shows `loading...` forever** → not authenticated. Hit `/signin` → Continue as guest.

**Plan review shows `Estimated cost exceeds your budget`** → either raise the budget hint, trim the synthesized roles/metrics in the plan, or click `force dispatch (over budget)`.

**`Connecting…` flashes on the Claude integration card** → CLI isn't logged in. Run `claude /login` in a terminal, then back in Settings click *Connect to CLI*.

**Webhook for GitHub?** Don't. Use polling — see [What's not built](#whats-not-built-yet).

**`No work items in <project> yet`** on the Board → no brief has been dispatched in this workspace yet. Either submit a brief in Ops or use the **Add item** form on the Dashboard.

**Validation says `target_url origin not in allowlist`** → either the URL doesn't match the allowlist exactly, or you set them via two separate API calls that didn't merge. The PUT call honours `allowlist` verbatim when provided; auto-merge only happens when `allowlist` isn't sent.

---

## Project status

**v1 complete.** 11 phases shipped end-to-end. See `docs/build-log.md` for the full chronological record (each phase + its verification + its surfaced limitations).

```
✅ Phase 0  — Budget + rate-limit governor
✅ Phase 1  — Intake + discovery round-table
✅ Phase 2  — Plan review + planning/hire toggles
✅ Phase 3  — GitHub repo bootstrap
✅ Phase 4  — Work Breakdown Structure
✅ Phase 5  — Progress dashboard
✅ Phase 6  — Deliverables space
✅ Phase 7  — Learning/explainer
✅ Phase 8A — Multi-perspective plan critique
✅ Phase 8B — Browser-driven validation
✅ Phase 9  — Cross-vendor second opinion (OpenAI adapter)
✅ Phase 10 — Cross-workspace agent memory
✅ Phase 11 — Design-shotgun + taste memory
```

---

## License

AGPL-3.0. Substantial code is lifted from `agent-teams-ai` (AGPL-3.0), so AtruneAI ships AGPL-3.0.
