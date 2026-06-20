# Atrium.AI — User Guide

A walk-through of every feature, what it does, where to find it, and how to use it. If the README is the reference, this is the teaching doc.

---

## Table of contents

1. [Getting started](#1-getting-started)
2. [The 60-second mental model](#2-the-60-second-mental-model)
3. [End-to-end flow (worked example)](#3-end-to-end-flow-worked-example)
4. [Authentication & accounts](#4-authentication--accounts)
5. [Workspaces (projects)](#5-workspaces-projects)
6. [Project intake](#6-project-intake)
7. [Discovery round-table](#7-discovery-round-table)
8. [Plan review + critic gate](#8-plan-review--critic-gate)
9. [Hire orchestration](#9-hire-orchestration)
10. [The pipeline (research → verify)](#10-the-pipeline-research--verify)
11. [Work breakdown + per-project Dashboard](#11-work-breakdown--per-project-dashboard)
12. [Cross-project Board (Kanban)](#12-cross-project-board-kanban)
13. [Deliverables](#13-deliverables)
14. [Browser-driven validation](#14-browser-driven-validation)
15. [GitHub repo](#15-github-repo)
16. [Cross-vendor review (OpenAI)](#16-cross-vendor-review-openai)
17. [Cross-workspace agent memory](#17-cross-workspace-agent-memory)
18. [Design-shotgun](#18-design-shotgun)
19. [Budget governor + cost HUD](#19-budget-governor--cost-hud)
20. [Approval rules](#20-approval-rules)
21. [Killswitch](#21-killswitch)
22. [Daily standup digest](#22-daily-standup-digest)
23. [Hire marketplace (154 agents)](#23-hire-marketplace-154-agents)
24. [Logs & replay](#24-logs--replay)
25. [Appendix · keyboard, env vars, troubleshooting](#25-appendix)

---

## 1. Getting started

```bash
pnpm install
pnpm init-db          # creates ~/.guideai/db.sqlite
pnpm dev              # boots server (4000) + web (3000)
```

Open <http://localhost:3000>. On the **sign-in page**, the easiest path is:

> **Continue as guest** → no password, instant access. Atrium creates a guest user (`guest-<random>`) tied to your local machine.

> **Guest mode uses a deterministic mock adapter** — every feature works without an API key, but responses are fixtures. To use real Claude, go to *Settings → Claude integration* (see [§4](#4-authentication--accounts)).

---

## 2. The 60-second mental model

Three things to remember:

1. **You direct, AI executes.** You describe goals + constraints in plain language ("intake"). Atrium turns that into a structured plan, hires the right specialists, runs them through a 5-phase pipeline, and surfaces every step so you can intervene.
2. **Everything is gated.** Budget gate, critic gate, approval gate, hire gate — nothing dispatches silently. You can always force-override, but you'll see what you're overriding.
3. **Local-first.** Your briefs, your work items, your slide decks — all on your machine at `~/.guideai/`. Atrium's web UI is just a window onto that local state.

---

## 3. End-to-end flow (worked example)

Let's ship a brief from intake to slide deck. This is what every feature plugs into.

### Step 1 · Create a project

- Sidebar → **Projects** → **New project** → name it `"URL shortener"`.
- The slug `url-shortener` is the workspace id you'll see everywhere on disk and in URLs.

### Step 2 · Fill the intake (project page top)

| Field | Example |
|---|---|
| **Goal** | "Build a tiny URL-shortener API. Single POST endpoint." |
| **Success criteria** (Enter to add each as a chip) | `POST /shorten returns 200 in <100ms`, `Persist via SQLite` |
| **Constraints** | `Node + Fastify only`, `No auth in v1` |
| **Budget hint** | Toggle **Currency** → `5` USD, *or* toggle **Tokens** → `30` (= 30,000 tokens) |
| **Planning mode** | `Assisted` (sees the plan before dispatch) |
| **Hiring mode** | `Hybrid` (safe defaults auto, others queued) |

Click **Save intake**.

### Step 3 · Run the discovery round-table

Click **Run discovery round-table**. Five specialists weigh in (Product Strategist, Tech Lead, Finance Analyst, UX Researcher, Risk Officer). After ~3 seconds you'll see:

- A synthesis summary
- Recommended roles (e.g. `backend-developer`, `frontend-developer`, `qa-expert`)
- Risk flags
- Success metrics aggregated from your criteria + the panel
- Cost estimate with a verdict pill: **within-budget** / **tight** / **over-budget**

### Step 4 · Critic gate fires

Atrium automatically runs the CEO + Eng critics on the synthesis. Two cards appear:

- **CEO critic** — scope/ROI/value questions
- **Eng critic** — architecture/risk/staffing questions

Each card shows a verdict (`pass` / `needs-revision` / `reject`), concerns, and suggested edits.

> **If `needs-revision`**: the approve button becomes warn-tinted "force dispatch (override critics)". You can either edit the synthesis (click pencil → modify lists → save) and re-run critics, or override.

### Step 5 · Approve & dispatch

Click **approve & dispatch**:

1. Hire dispatch fires — safe-defaults like `backend-developer` auto-hired; specialised roles queued (visible in the *Hire dispatch result* panel).
2. The pipeline starts in the background. Status flips to **dispatched**, `briefId` shown.
3. WBS auto-seeds: 18-20 work items appear in the Dashboard, all in **todo**.

### Step 6 · Watch the pipeline

Either on the project page (Dashboard burndown + KPI strip) or in **Ops** (live event feed). You'll see:

```
phase research started → completed → phase plan started → ...
budget downgrade (review): sonnet → haiku   ← if you hit a cap
pass@3 verdict: pass · claude: 2/2 + openai: 1/1   ← cross-vendor review
deliverables harvest · 5 phase artifacts + 1 deck + 1 explainer
```

WBS items tick from **todo → done** as each phase finishes. Cost ticks up in the TopBar HUD.

### Step 7 · Open the deliverables

Project page → **Deliverables** section. You get:

- **Slide deck** (10 slides) — click `open` → arrow-key navigation through slides
- **Explainer** — plain-English walkthrough
- **5 phase artifacts** — research/plan/implement/review/verify markdowns
- *(optional)* **Regression test** if you set a validation target URL

### Step 8 · (Optional) Push to GitHub

Project page → **Repo** section → **link existing** repo or **create new** → click **Push deliverables**. Atrium writes:

```
README.md           (slide deck)
EXPLAINER.md        (plain-English walkthrough)
docs/research.md
docs/plan.md
docs/implement.md
docs/review.md
docs/verify.md
GUIDEAI.md          (index)
```

Then click **Sync WBS → issues** to mirror every work item as a GitHub issue with phase/priority labels.

That's the whole flow. The rest of this guide is each feature in depth.

---

## 4. Authentication & accounts

**Where**: `/signin`. Available before any other route.

**Three modes**:

| Mode | When to use | What you get |
|---|---|---|
| **Continue as guest** | Quick try, demos, or you don't have an Anthropic account | Guest user, mock-adapter responses, full feature set |
| **Sign up** (username + password) | First-time real user | Persistent account, can connect Claude CLI / API key |
| **Sign in** | Returning user | Restores your session |

Cookies (HttpOnly) keep you signed in. Password hashes use scrypt (Node built-in).

**Settings → Account**: change password, sign out, delete account.

Per-user credentials (Claude API key, OpenAI key, GitHub PAT) are scoped to your username so different users on the same machine don't see each other's keys.

---

## 5. Workspaces (projects)

A workspace = one project. Briefs, intake, plans, work items, deliverables, repo binding — all scoped to a workspace.

**Create**: Sidebar → **Projects** → **New project**. Type a name; the slug is auto-derived (e.g. `"URL Shortener"` → `url-shortener`).

**Switch**: Two places:
- **TopBar workspace switcher** (top of every page) — fastest
- **Projects grid** (`/projects`) — see all workspaces with stats per card

**Archive**: Hover over a workspace card → archive icon. The workspace disappears from lists but **data stays on disk** (you can re-create with a same-name later — Atrium auto-suffixes to `acme-2`, `acme-3`, …).

**The currently-active workspace** is what every other section (Board, Ops, Hire, etc.) refers to. The active id is persisted in `localStorage` so refreshing keeps your context.

---

## 6. Project intake

**Where**: top of every project page (`/projects/{id}`).

The intake is the *structured front-door* to a brief. The discovery panel reads from these fields verbatim.

### Field-by-field

| Field | Tip |
|---|---|
| **Goal** | One paragraph. Be specific about the *output* you want. |
| **Success criteria** | Outcomes, not features. *"users finish in under 2 minutes"* beats *"button is fast"*. Press Enter to add each as a chip. |
| **Constraints** | Hard limits. *"iOS first"*, *"no third-party SDKs"*. |
| **Budget hint** | See [§19](#19-budget-governor--cost-hud) for the deep cut. Click the toggle: **Currency** opens the unit dropdown (USD/EUR/GBP/INR/JPY) with an amount input. **Tokens** opens a k-units input (`100` = 100,000 tokens). |
| **Planning mode** | **Auto** = discovery + critics + dispatch in one click. **Assisted** = pause for your review after critique. **Manual** = skip discovery; write the brief yourself. |
| **Hiring mode** | **Auto** = hire every recommended role. **Hybrid** = safe defaults (backend/frontend/qa/etc.) auto, others queued. **Manual** = every hire queued. |

**Important**: changing intake after a discovery doesn't re-run discovery — you have to click **Run discovery round-table** again.

---

## 7. Discovery round-table

**Where**: Project page → click **Run discovery round-table** (under the intake).

Five specialist agents read your intake and reply in parallel:

| Specialist | Lens |
|---|---|
| Product Strategist (haiku) | Business value · scope · ROI · WIN condition |
| Tech Lead (sonnet) | Stack · required roles · technical risks · effort |
| Finance Analyst (haiku) | Ballpark cost · token-heavy phases · cuts · verdict |
| UX Researcher (haiku) | Audience · journey · success metrics · pitfalls |
| Risk Officer (sonnet) | Top risk · other risks · mitigations · security tag |

Each card shows the raw labelled response so you can see exactly what each specialist said.

### Synthesis card (top of the discovery view)

Aggregates all 5 inputs into:

- **Recommended roles** — info-tinted pills (deduplicated, role-aliased to catalog names)
- **Risks** — warn-tinted bullets
- **Success metrics** — accent-tinted bullets
- **Cost estimate** + verdict pill (within-budget / tight / over-budget)
- **Security tag** (required / recommended / not-needed)
- One-paragraph summary

**Cost** = total tokens × tier price across all five panelists. Usually a few cents per discovery.

### What happens after discovery completes

Depends on your **planning mode**:

- **Manual** → nothing. You go write your brief in Ops yourself.
- **Assisted** → a draft plan is created. You review/edit it. See [§8](#8-plan-review--critic-gate).
- **Auto** → a plan is created *and* immediately approved + dispatched (subject to critic gate + budget gate).

---

## 8. Plan review + critic gate

**Where**: Project page → **Plan review** section (appears after discovery).

A *plan* is an editable, user-reviewable copy of the synthesis. Status flow:

```
draft → approved → dispatched
              ↓
            rejected (soft — you can redraft)
```

### Editing

Click **pencil** → edit summary, recommended roles, success metrics, risks, benefits → **save edits**. Editing clears any prior critique (it's about to become stale).

### Critic gate

When you click **approve & dispatch** for the first time:

1. CEO critic runs (haiku, ~$0.001)
2. Eng critic runs (haiku, ~$0.001) in parallel
3. Both return: verdict (`pass` / `needs-revision` / `reject`), concerns, suggested edits

**What you see**:

```
┌─ CEO critic ───────────────┐  ┌─ Eng critic ───────────────┐
│ verdict: needs-revision    │  │ verdict: pass              │
│ concerns:                  │  │ concerns:                  │
│ • scope drift              │  │ • token cost overrun risk  │
│ • ROI unclear              │  │ suggested edits:           │
│ suggested edits:           │  │ summary=tighten "etc."     │
│ successMetrics=…           │  └────────────────────────────┘
└────────────────────────────┘
```

**What it does to the gate**:

| Combined verdict | Behavior |
|---|---|
| Both `pass` | Dispatches normally |
| Either `needs-revision` or `reject` | **Blocked**. Status stays `draft`. UI shows red banner + "force dispatch (override critics)" button |

### Budget gate (overlapping)

Independent of critics: if the synthesizer concluded `costVerdict='over-budget'` (cost × 30% buffer exceeds your budget hint), dispatch is blocked with a separate red banner. Approve button becomes "force dispatch (over budget)".

### Hire dispatch (after approval)

Once dispatched, you see a **hire dispatch result** with three columns:

- **hired** — agents now on your roster
- **queued for approval** — awaiting you in `/hire` (manual / hybrid mode)
- **skipped** — already on roster, or no catalog match

If `queued.length > 0` and you didn't `forceDispatch`, the plan stays `approved` (not `dispatched`). Click **force dispatch anyway** to send the brief without waiting for those hires.

---

## 9. Hire orchestration

**Where**: implicit during plan dispatch; managed at `/hire`.

Three modes (set in intake):

| Mode | What happens at dispatch |
|---|---|
| **Auto** | Every recommended role hired immediately |
| **Hybrid** | Safe defaults auto-hired (`backend-developer`, `frontend-developer`, `fullstack-developer`, `technical-writer`, `qa-expert`, `test-automator`); rest queued |
| **Manual** | Every role queued — you approve each one |

### Role aliasing

The panelists don't have to know every exact catalog ID. Atrium maps shorthand → canonical:

```
qa-engineer       → qa-expert
test-engineer     → test-automator
full-stack-developer → fullstack-developer
architect         → solution-architect
sre               → sre-engineer
ux-designer       → ui-designer
pm                → product-manager
```

Plus a fuzzy substring fallback. If nothing matches, the role is **skipped** (visible in the hire summary).

### The marketplace

`/hire` lists all 154 agents grouped by department. Click any agent → preview prompt + tools. **Hire** adds them to the active workspace's roster.

You can also create **custom agents** with your own system prompt and tool whitelist (see [§23](#23-hire-marketplace-154-agents)).

---

## 10. The pipeline (research → verify)

The core abstraction. Every dispatched brief runs through 5 phases, gated and routed:

| Phase | Model tier | What it produces |
|---|---|---|
| **research** | Haiku | 4-bullet research note (constraints, risks, unknowns, leverage) |
| **plan** | Sonnet | 3-step plan |
| **implement** | Sonnet | 3-5 bullet implementation sketch |
| **review** | Opus (or pass@3 for security) | ≤3 risks + ≤2 mitigations |
| **verify** | Haiku | One-paragraph go/no-go |

Each phase writes a markdown artifact to `~/.guideai/workspaces/{id}/briefs/{briefId}/{phase}.md` and emits a `phase` chunk in the event stream.

### What gates each phase

Before every phase:
1. **Budget forecast** — compute estimated tokens × tier price
2. **Budget gate** — if over cap, downgrade (opus → sonnet → haiku → pause)
3. **Memory injection** — prepend cross-workspace agent memory for this role
4. **Skill injection** — prepend any matching skill bundles
5. **Cross-vendor decision** (review phase only) — should one attempt go to OpenAI?

### Security-tagged briefs

If your brief starts with `[security]` (or the `securityTagged` flag is set), **review** runs pass@3 instead of pass@1. With cross-vendor on, the layout is `[claude, claude, openai]`. Verdict reports per-provider breakdown.

### Where to watch

- **Live**: Ops tab (event feed) — all chunks in real-time
- **After**: `/logs/{briefId}` — flame-graph + raw JSONL + diff scrubber

---

## 11. Work breakdown + per-project Dashboard

**Where**: project page → **Dashboard** section.

When a plan dispatches, Atrium auto-seeds work items from the synthesis:

- 1 research item + 1 implement item per recommended role (up to 8 roles)
- 1 review item per risk flag (up to 5)
- 1 verify item per success metric (up to 6)

So a typical plan creates **15-20 work items**, all in `todo`.

### The Dashboard

KPI strip at top:
- **open** — total not-done
- **in flight** — currently `in_progress`
- **done** — total done with 7-day velocity sub-label
- **spent** — actual USD ($ used / budget hint)
- **today** — items completed in the last 24h

Two inline-SVG charts (14-day window):
- **Items burndown** — actual remaining + ideal trajectory dashed
- **Cost burndown** — cumulative USD + budget baseline dashed (when set)

### Kanban

Four columns: **To do · In progress · Blocked · Done**.

**Drag and drop**: optimistic update — drag a card to a new column, it moves instantly; the PUT happens in the background. If the server rejects, it snaps back.

**Move via menu** (touch/no-drag): each card has a "move ▼" disclosure with four buttons.

**Add manually**: + add item → title + phase + priority + role.

### Auto-progress

As the pipeline completes each phase, `markPhaseComplete` ticks all matching auto items to **done**. Manual items (no `briefId`) are never auto-ticked — you mark them yourself.

---

## 12. Cross-project Board (Kanban)

**Where**: Sidebar → **Board**.

Same Kanban, but scoped to the **currently active workspace** via the TopBar switcher. Header shows the project name with an "open project →" link.

### Filters

Search box (title/description) + a "filters" disclosure:
- **Phase** — research / plan / implement / review / verify / other
- **Priority** — low / normal / high / critical
- **Role** — populated from facets the server returns

Active filter count + one-click clear-all.

### KPIs

Five tiles: open · in-flight · blocked · done·24h · done·7d.

### Switch projects

Top-bar workspace switcher. The Board re-scopes instantly when you pick a different project.

### Why two Kanbans?

The per-project Dashboard ([§11](#11-work-breakdown--per-project-dashboard)) is *inside* the project context — alongside burndown, KPIs, intake. The Board is a *dedicated tab*, single-purpose, with richer filtering. Same data, two presentations.

---

## 13. Deliverables

**Where**: project page → **Deliverables** section.

After every brief completes, Atrium auto-harvests three kinds of deliverables:

| Kind | What it is | How |
|---|---|---|
| **Phase artifacts** (×5) | research/plan/implement/review/verify markdowns | Walked off disk |
| **Slide deck** (1) | 10-slide markdown deck (title · outcome · 5 phase slides · metrics · risks · team) | Deterministic — no LLM call |
| **Explainer** (1) | Plain-English walkthrough: What we built / How it works / Why these choices / What's next | One haiku call, ~$0.001 |

Plus you can add **manual** deliverables:
- **Link** (e.g. staging URL)
- **File** (path on disk)

When [§14](#14-browser-driven-validation) runs, an extra:
- **Regression test** — persisted Playwright-lite script for re-runs

When [§18](#18-design-shotgun) fires, multiple:
- **Design variants** — 4 alternatives in different design lenses

### Viewing

Click **open** on any card → modal viewer:
- **Slide decks** — paged view, arrow keys to navigate, slide counter footer
- **Markdown content** — rendered inline (tiny in-house renderer: h1-h3, lists, `**bold**`, `_italic_`, `` `code` ``)
- **Links** — preview URL + an external-link "visit" action

### Per-brief regenerate

Top of the Deliverables section: chips showing every brief that has deliverables. Click any → re-harvests artifacts + regenerates deck + explainer (overwrites the prior auto rows, keeps manual ones).

---

## 14. Browser-driven validation

**Where**: project page → **Validation** section.

Drives a real Chromium (Playwright) against your app to validate the success criteria. The script becomes a **regression suite** you can re-run for free (no LLM).

### Setup (one-time per project)

1. Click **configure** under the Validation header.
2. Enter **Target URL** (e.g. `http://localhost:5173`).
3. The origin auto-fills the allowlist (`http://localhost:5173`).
4. Optionally add more allowed origins (e.g. `https://staging.example.com`).
5. **Save target**.

### What runs

After every brief completes, if a target URL is configured:

1. A haiku call composes a Playwright-lite script from your success criteria
2. The script uses only 6 step kinds: `goto · click · fill · expectText · expectVisible · screenshot`
3. `goto.url` is templated to `{TARGET}` — it can't navigate to attacker-controlled origins
4. Real Chromium opens, walks the script, captures per-step + per-failure screenshots
5. Report persists as a `validation_runs` row + the script as a `regression-test` deliverable

### Manual run

Per-brief chip row → click a brief id → fresh validation against the current target. Uses a fresh haiku call to compose.

### Re-run

Latest-run card → **rerun** button → replays the persisted script. **0 LLM cost** — pure Playwright.

### Run detail modal

Per-step pass/fail with selector + criterion + duration + inline screenshot. Failed steps show the error. Raw script JSON in a collapsible.

### Playwright not installed

The module dynamic-imports Playwright. If it's not installed, the **mock driver** kicks in — every step marked passed, no real browser, no screenshots, but the rest of the flow (compose + persist + report + deliverable) still works. Lets guest mode + dev environments demo the feature.

To enable real validation:
```bash
pnpm -F @guideai/server add playwright
pnpm exec playwright install chromium     # ~170MB
```

---

## 15. GitHub repo

**Where**: project page → **Repo** section (visible once Settings → GitHub is configured).

### Setup (in Settings → GitHub)

Two paths (Atrium tries them in order):

1. **gh CLI** — install [`gh`](https://cli.github.com), run `gh auth login`, then in Settings click **connect gh CLI**. Atrium uses your existing login.
2. **PAT** — paste a GitHub Personal Access Token (`repo` scope) into the PAT field. Stored at `~/.guideai/integrations/github.json` (`chmod 600`).

You can set both. CLI is preferred when authenticated.

### Per-workspace binding

In the project's **Repo** section:

- **Link existing**: owner + repo + visibility + default branch
- **Create new**: name + description + private/public (creates under `/user/repos`)

The binding is one repo per workspace. **Unlink** doesn't delete the repo on GitHub — it just removes the binding from Atrium.

### Push deliverables

After the binding, click **Push deliverables**. Atrium writes (or updates):

```
README.md           ← slide deck body
EXPLAINER.md        ← explainer body
docs/{phase}.md × 5 ← phase artifacts
GUIDEAI.md          ← index file
```

All via the Contents API with sha lookup, so re-pushes update in place (idempotent).

### Sync WBS → issues

Click **Sync WBS → issues**:

- Items without a `github_issue_number` → **create** an issue (title = work item title, body includes phase/priority/role/briefId, labels `guideai` + `phase:X` + `priority:Y`)
- Items with an issue number → **PATCH** state (`done` → `closed`, otherwise → `open`) + update body
- Cancelled items → skipped

`github_issue_number` + `github_issue_url` persist on the work item so re-syncs are idempotent.

### Two-way?

GitHub → Atrium isn't automatic. If you close an issue on GitHub, Atrium doesn't know. The recommended path is **polling-based two-way sync** (every 5 min hit `GET /issues?since=<last>`), not webhooks (local-first apps can't receive webhooks). Not built today; see [README "What's not built"](../README.md#whats-not-built-yet).

---

## 16. Cross-vendor review (OpenAI)

**Where**: Settings → OpenAI integration (global) + project page → top toggle (per-workspace).

When enabled, **security-tagged briefs** route one of three review attempts through OpenAI (independent verification across model families).

### Setup

1. Get an OpenAI API key (must support GPT-5 / GPT-5-mini).
2. Settings → OpenAI → paste it.
3. Optionally override per-tier model mappings (defaults: `haiku → gpt-5-mini`, `sonnet/opus → gpt-5`).
4. On the project, click the **Cross-vendor review** toggle at the top of the project page.

### When it fires

Both:
- `secondOpinionEnabled` is true on the workspace
- The brief is security-tagged (starts with `[security]` OR `securityTagged: true` in submitBrief)

The review phase already runs pass@3 for security; cross-vendor swaps one attempt for OpenAI.

### Routing

`crossVendorIdx = Set([k-1])` — the LAST attempt index. For k=3:
- Attempt 0 → Claude
- Attempt 1 → Claude
- Attempt 2 → **OpenAI**

So 2/3 self-consistency from Claude + 1/3 sanity from a different model family.

### What you see

In the event feed:
```
second opinion: attempt #3 routed to OpenAI (cross-vendor)
[openai] gpt-5
pass@3 verdict: pass · 3/3 attempts passed (req 3) · claude: 2/2 + openai: 1/1
```

In the review artifact:
```markdown
_cross-vendor: claude: 2/2 + openai: 1/1_

### attempt 1 (pass) · provider: claude · …
### attempt 2 (pass) · provider: claude · …
### attempt 3 (pass) · provider: openai · …
```

### No key on file

The toggle is still on but no OpenAI key — Atrium uses a **mock OpenAI adapter** so the codepath stays exercised. Status pill in the toggle card turns warn-tinted.

---

## 17. Cross-workspace agent memory

**Where**: project page → **Agent memory** section.

Each role can accumulate **notes** that travel between projects. When a role runs anywhere, Atrium prepends matching notes to its system prompt.

### Adding a note

In the Memory section:
1. Role: `backend-developer`
2. Body: *"Always default rate-limit windows to 60s on auth endpoints — bit us in q3."*
3. **Add note**

The note is stored against the current workspace + role.

### Share ACL (per workspace)

Three modes (top of the section):

| Mode | What other projects see |
|---|---|
| **all** | Notes are visible to agents working in *any* project |
| **read-only** | *(default)* Other projects can read; only this project can edit |
| **deny** | Notes stay private to this project |

When a role runs in workspace B, Atrium loads notes from B itself **and** every workspace whose share isn't `deny`. Newest first, capped at 6 to keep prompts lean.

### What gets injected

System prompt at every phase becomes:

```
## Your role
You are **{displayName}** ({role}).
{role's system prompt}

## Past notes (from previous projects)
- Always default rate-limit windows to 60s on auth endpoints — bit us in q3. _(from `prev-workspace`)_
- Avoid X in path Y. _(this workspace)_

## {Phase} task
{phase-specific instructions}
```

The `_(from …)_` suffix tells the agent (and the user reading the artifact) which workspace the note came from.

### Best uses

- *"For this codebase, never use `--no-verify` on commits"*
- *"Our staging URL is X; test there before prod"*
- *"Frontend uses Tailwind; don't suggest CSS-in-JS"*

The memory layer is **manual** — Atrium doesn't auto-distill notes from traces. (Skill promotion handles the auto lane.)

---

## 18. Design-shotgun

**Where**: trigger via brief tag; results in Deliverables → Design variants.

If a brief starts with `[design]`, `[ux]`, or `[ui]`, the **implement** phase fans out to **4 parallel variants**, each with a distinct design lens:

| Lens | Optimizes for |
|---|---|
| **mvp-first** | Simplicity, smallest viable slice |
| **power-user** | Density, keyboard shortcuts, command palette |
| **first-timer** | Onboarding, empty states, hand-holding |
| **accessibility** | Keyboard nav, contrast, screen-reader semantics |

Each variant is persisted as a `design-variant` deliverable. They appear at the top of the Deliverables grid.

### Picking

Open the Deliverables grid → Design variants section → 4 cards visible → click **pick this** on the one you like.

- The picked card gets a `picked` chip + accent glow
- The other 3 are recorded as **rejected**
- A `design_picks` row persists the choice

### Taste memory

For the next design brief in the **same workspace**, Atrium prepends a taste-memory block to the implement prompt:

```
## Taste memory — variants the user has picked before:
- _mvp-first_: Single page, single action — no nav. Inline empty state…
```

Capped at 4 past picks. Older picks fall off.

So the system learns your preferences over time. Not via ML — via prompt context.

---

## 19. Budget governor + cost HUD

**Where**:
- Live HUD in the TopBar (visible from every page)
- Detailed config: Settings → **Budget & rate limits**

### What it does

Every phase, before spending tokens:

1. Forecast the cost (tokens × tier price)
2. Compare against three caps:
   - **Daily $ cap**
   - **Monthly $ cap**
   - **5h token cap** (rate-limit window)
3. Decide based on **behavior**:
   - **Warn** — proceed, emit a warning chunk
   - **Downgrade** — drop one tier (opus → sonnet → haiku → pause) and retry
   - **Pause** — halt the pipeline, emit error chunk, mark phase paused

### Configuring (Settings → Budget)

Three meter cards (today $ / 30d $ / 5h tokens) with progress bars.

Three cap inputs:
- Daily $ cap (blank = no cap)
- Monthly (30d) $ cap
- Tokens / 5h window (default: 140,000 — Claude Pro typical)

Behavior radio: Warn / Downgrade / Pause.

### Budget hint vs budget cap

Two different things:

| | Budget hint (per project) | Budget cap (per workspace, in Settings) |
|---|---|---|
| Where | Intake form | Settings → Budget & rate limits |
| When checked | During *planning* (discovery synthesis) | During *every phase* of the pipeline |
| What it does | Sets the `costVerdict` (within/tight/over-budget) → can block dispatch | Caps actual spend → can warn/downgrade/pause |
| Units | Currency (USD/EUR/GBP/INR/JPY) or tokens | Currency + tokens |
| Buffer | 30% buffer applied to cost × buffer comparison | No buffer — hard caps |

The hint plans for a ceiling. The cap enforces a hard limit. You can have both, neither, or just one.

### TopBar HUD

Two pills (always visible if caps are set):

```
today $0.12 / $5     ← daily $ cap
5h 14,231 / 140,000  ← 5h token cap
```

Tinted green (<60% used) → amber (60-90%) → red (≥90%).

### Token-cap nuance

For token caps, **downgrade doesn't help** (a phase consumes about the same tokens at any tier). So token-cap hits skip the downgrade ladder and go straight to warn-or-pause.

---

## 20. Approval rules

**Where**: Settings → Approval rules.

When the pipeline runs and an agent tries to call a tool (`Read`, `Edit`, `Bash`, etc.), Atrium's PreToolUse hook intercepts and routes the call to the policy engine. The engine matches against your rules:

```jsonc
{
  "rules": [
    { "match": { "tool": "Read" }, "action": "auto-approve" },
    { "match": { "tool": "Bash", "cmd": "^(npm test|pnpm test|pytest)" }, "action": "auto-approve" },
    { "match": { "tool": "Edit", "path": "^docs/" }, "action": "auto-approve" },
    { "match": { "tool": "Bash", "cmd": "rm |git push" }, "action": "always-ask" },
    { "match": { "tool": "Bash", "cmd": ".*--no-verify" }, "action": "deny" },
    { "default": "ask" }
  ]
}
```

### Three actions

| Action | Behavior |
|---|---|
| **auto-approve** | Tool runs without bothering you |
| **ask** *(default)* | Pending approval appears in the project's "Needs your approval" tray |
| **deny** | Tool call blocked; agent told to abandon |

### Synthesizing a rule from a denied action

In the approval tray, when you deny a tool call, you'll see a **"Don't ask me again about `pnpm test`"** prompt — click it and Atrium adds a matching auto-approve rule to your `policies.json`.

### Pending approvals

Project page → **Needs your approval** section. Each pending row shows tool + args. Click **approve** or **deny**. Audit log records every decision.

---

## 21. Killswitch

**Where**: Sidebar bottom (skull icon).

Two scopes:

| | Where | Effect |
|---|---|---|
| **Per-agent kill** | `/org` → agent card → killswitch | Stops one agent process |
| **Global stop** | Sidebar killswitch button | Stops *every* running agent across all workspaces, in <2s |

Both are audited in `events.jsonl`. Use the global kill when you see something running away.

When agents are running, the TopBar shows a `running N` pill with a warn-tinted pulse.

---

## 22. Daily standup digest

**Where**: Home page (`/`) shows the latest; runs automatically at 09:00 local via cron.

The Chief-of-Staff (CoS) agent reads the last 24h of events per workspace and writes a one-paragraph digest:

> *"Yesterday: 3 briefs shipped (acme-docs, url-shortener, auth-rewrite). 2 work items moved to blocked: auth-rewrite's API spec waiting on legal; url-shortener's rate-limit decision waiting on you. 12 work items completed, $4.31 spent. Next: clear the 2 pending approvals on auth-rewrite."*

### Trigger manually

Home page → **Run now** button. Generates a fresh digest immediately.

### Storage

`~/.guideai/workspaces/{id}/digests/{YYYY-MM-DD}.md`. One per workspace per day.

### Surfaced

- Home page hero
- Per-project card on `/projects` (digest date badge)

---

## 23. Hire marketplace (154 agents)

**Where**: Sidebar → **Hire**.

Browse and hire from 154 pre-built subagents across 10 departments. Sourced from [`awesome-claude-code-subagents`](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).

### Departments

01 — Core development · 02 — Language specialists · 03 — Infrastructure · 04 — Quality & security · 05 — Data & AI · 06 — Developer experience · 07 — Specialized domains · 08 — Business & product · 09 — Meta & orchestration · 10 — Research & analysis.

### Hiring

Click any agent card → preview shows system prompt + tool whitelist. **Hire** adds them to the active workspace's roster.

Hired agents are stored in the `agents` table with `status: 'idle'`. They become candidates for phase routing — the orchestrator picks the best match for each phase.

### Retiring

`/org` → agent card → **retire**. Sets `status: 'retired'`. Data kept on disk; agent removed from the active roster.

### Custom agents

`/hire` → **Create custom agent** → name + role-slug + system prompt + tool whitelist + (optional) model override → save. The custom agent shows up in your roster alongside catalog agents.

---

## 24. Logs & replay

**Where**: Sidebar → **Logs** or `/logs/{briefId}` directly.

For each completed brief:

- **Flame-graph view** — every phase as a horizontal bar, color-coded by tier
- **Event timeline** — raw JSONL chunks: phase metadata, AI text, tool calls, approvals, system warns/errors
- **Diff scrubber** — when phases touch files, a scrubbable diff between phases

### What's in the JSONL

`~/.guideai/workspaces/{id}/events.jsonl` is append-only. Every chunk has:

```jsonc
{
  "id": "uuid",
  "ts": 1734567890123,
  "workspaceId": "url-shortener",
  "agentId": "backend-developer-abc",  // optional
  "kind": "ai|system|phase|tool|approval|user",
  // kind-specific fields
}
```

Replay just walks the file in order. No reconstruction step.

---

## 25. Appendix

### Keyboard shortcuts

| Key | What |
|---|---|
| `⌘K` / `Ctrl+K` | Open command palette (search + navigate) |
| `←` / `→` | In slide-deck viewer: prev / next slide |
| `Esc` | Close any modal (slide viewer, run detail, etc.) |
| `j` / `k` | (in Ops feed) navigate event list (planned, not all routes yet) |

### Environment variables (all optional)

| Variable | Default | Use |
|---|---|---|
| `PORT` | `4000` | Fastify server port |
| `GUIDEAI_CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `GUIDEAI_GH_BIN` | `gh` | Path to gh CLI binary |
| `GUIDEAI_OPENAI_ENDPOINT` | `https://api.openai.com/v1/chat/completions` | OpenAI chat endpoint |
| `GUIDEAI_PERMISSIONS_URL` | `http://127.0.0.1:4000/api/permissions/evaluate` | PreToolUse hook callback |

### Storage layout

```
~/.guideai/
├── db.sqlite                     # All structured state
├── workspaces/{id}/
│   ├── events.jsonl              # Append-only event stream
│   ├── briefs/{briefId}/         # Phase markdown artifacts
│   ├── agents/{agentId}/         # Per-agent sandboxed cwd
│   └── validation/{runId}/       # Per-run screenshots
├── integrations/
│   ├── claude.json               # chmod 600
│   ├── github.json               # chmod 600
│   └── openai.json               # chmod 600
├── skills/*.md                   # Promoted skill bundles
├── catalog/catalog.json          # 154-agent cache
└── policies.json                 # Approval rules
```

### Common troubleshooting

**Page stuck on `loading…`**
You're not signed in. The AuthGate is redirecting to `/signin`. Hit it and continue as guest (or sign up).

**Plan won't dispatch despite hitting approve**
Either the critic gate or the budget gate blocked it. Look for a red/warn banner above the action buttons. Edit the synthesis or click force-dispatch.

**Validation says `target_url origin not in allowlist`**
The target URL's origin isn't in the allowlist. Two fixes: (1) re-save the target without an explicit allowlist (Atrium auto-adds the origin), or (2) add the origin manually.

**`/board` shows empty**
The current workspace has no work items. Either dispatch a brief or click + add item.

**Workspace I archived still appears**
You're on an old build. Pull the latest — the GET endpoint now filters archived by default.

**Same-name workspace fails with "already exists"**
That collision is only blocked for *active* workspaces. If the conflict is with an archived one, the new workspace auto-suffixes (e.g. `acme-2`).

**`Connecting…` flashes on Claude integration**
The CLI isn't logged in. Open a terminal: `claude /login`. Then back in Settings click **connect to CLI**.

**OpenAI verdict missing despite toggle being on**
Either no OpenAI key on file (mock fixture runs instead — verdict label says `(mock)`) or the brief isn't security-tagged (cross-vendor only runs on review pass@3, which only fires for security briefs).

**Webhooks for GitHub?**
Don't. Local-first machines can't be reached by GitHub's POST. Use polling — see README → What's not built.

---

## Where to learn more

- **README** — quick reference + architecture overview
- **`docs/build-log.md`** — chronological record of how each phase shipped, what was verified, what was surfaced as a limitation
- **`CLAUDE.md`** — repo conventions for anyone (or any agent) editing this codebase
