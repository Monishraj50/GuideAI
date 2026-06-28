# AtruneAI End-to-End Test Plan

> Build one tiny web app from scratch through AtruneAI. Every brief is
> deliberately shaped to exercise a different feature category. By the time
> the project ships, you've verified every major surface.

---

## Why this approach

Testing 50+ features in isolation is tedious and misses interactions. A single
cohesive project, run through the platform end-to-end, hits the same features
in the order a real user would — and surfaces bugs that only appear in
combination (e.g. budget gate + critic gate + cross-vendor review interacting).

The project is small enough that a full run takes ~2 hours; large enough to
touch the full 5-phase pipeline multiple times.

---

## The project: **QuickLink** — a URL shortener

A minimal URL-shortener web app:

- **POST `/shorten`** — accepts a URL, returns a 6-char code
- **GET `/:code`** — 302-redirects to the original URL, increments a hit counter
- **GET `/stats/:code`** — JSON of hit count + created_at
- **Tiny frontend** — input box + "Shorten" button + last 5 links
- **SQLite persistence**
- **Tests** for every endpoint
- **README + ARCHITECTURE.md**

That's it. Six pages of code total. Built across six briefs.

---

## Pre-flight checklist

Run these before starting — failures here mean the test plan can't proceed.

| Step | Verify |
|---|---|
| `pnpm install` | exits 0, no peer-dep warnings on critical packages |
| `pnpm dev` | Fastify (`:4000`) + Next.js (`:3000`) both boot, no errors in logs |
| `curl localhost:4000/healthz` | returns `{"ok":true, ...}` |
| `curl localhost:3000` | returns HTML with the new Atrune sidebar |
| **Settings → Claude integration** (per-workspace) | "Connected" badge appears after `claude login` |
| **Settings → OpenAI integration** | API key accepted, "Connected" |
| **Settings → GitHub integration** | gh CLI or PAT validates, "Connected" |
| VS Code extension `code --install-extension apps/vscode/atruneai-0.1.0.vsix` | activity bar shows the cube icon |
| Reload VS Code → sidebar opens | three TreeViews render |
| Status bar | reads `Atrune · …` not `connecting…` after 5s |

If any of these fail, fix before proceeding.

---

## The build — six briefs, each testing a feature category

### Brief 1 · Scaffold the backend

**What you type:**

> Build a tiny URL-shortener API in Fastify + SQLite:
> - POST /shorten — body `{ url }` — returns `{ code }`
> - GET /:code — 302 redirect, increments hit counter
> - GET /stats/:code — returns `{ code, url, hits, createdAt }`
> - SQLite at `./quicklink.db` via Drizzle
> - Tests for every endpoint with vitest
> - Folder: `quicklink/`

**Use:** auto-hire mode. No template.

**Features exercised:**

- ✅ Workspace creation (create a new one called "quicklink")
- ✅ Brief intake (manual, plain text)
- ✅ Discovery round-table (watch for the discovery transcript in Ops feed)
- ✅ Auto-hire (a backend-developer + tech-lead should appear in Team)
- ✅ Plan review with critic verdicts
- ✅ Critic gate (if first plan is weak, the critic rejects it and a new plan is drafted — verify this happens at least once)
- ✅ 5-phase pipeline runs research → plan → implement → review → verify
- ✅ Per-phase artifacts written to `~/.guideai/workspaces/quicklink/deliverables/`
- ✅ Budget governor: should hit roughly $0.50–$1.00; verify the budget HUD in TopBar updates live
- ✅ PreToolUse hook fires (look at Logs/replay for the hook chunks)
- ✅ Status bar narrator updates: `connecting → planning → building → reviewing → verifying`
- ✅ Browser validation (vitest tests run, results appear in Validation page)

**Verify on completion:**
- Deliverables tree contains `research.md`, `plan.md`, `implement.md`, `review.md`, `verify.md`
- `quicklink/` folder exists in the workspace cwd with `index.ts`, `db.ts`, `package.json`, `quicklink.test.ts`
- `cd quicklink && pnpm test` → all tests pass

---

### Brief 2 · Build the frontend

**Use the "Build a website" template.** Edit its body to:

> Build a tiny frontend for the QuickLink API at /quicklink/web/:
> - Input + "Shorten" button at center
> - Below: last 5 shortened links (read from /stats/:code)
> - Tailwind for styling
> - One page only, no routing
> - Mobile-responsive

**Features exercised:**

- ✅ **Project template** picker (P2 from Phase 5)
- ✅ Pre-filled brief body edited before dispatch
- ✅ **Cost preview popup** (P3) — verify the modal appears, confirm or click "Don't show again" once to test the persistence
- ✅ Manual hire mode — when discovery proposes agents, deny one, accept another (tests the approval system)
- ✅ Channels (team rooms) — open `/channels` mid-run; discovery and plan should post messages
- ✅ Org view roster — confirm the hired UX designer + frontend dev appear with correct status
- ✅ Live narrator updates with new agent roles
- ✅ Memory injection — second brief should reference Brief 1's deliverables (check the research artifact for citations to Brief 1)

**Verify on completion:**
- `quicklink/web/page.tsx` exists with a working UI
- `pnpm --filter quicklink-web dev` boots, the UI renders, calls /shorten on submit

---

### Brief 3 · Persistence and reliability

**What you type:**

> Audit the QuickLink storage layer. Specifically:
> - Move from local SQLite to a Drizzle migration setup
> - Add a `created_at` timestamp + index
> - Handle the duplicate-code edge case with a retry loop
> - Ensure connection pooling
>
> Tag this brief as security-sensitive — I want extra review.

**Tick the "Security-tagged" checkbox in the composer.**

**Features exercised:**

- ✅ **Security-tagged brief** — review runs at `pass@3`
- ✅ **Cross-vendor sanity check** (OpenAI) — second-opinion artifact should appear in Validation tab
- ✅ Plan review approval flow — manually approve the plan from the sidebar
- ✅ **Native VS Code approval popup** — when implementer wants to run `pnpm install drizzle-kit`, the popup should appear in VS Code's bottom-right
  - Click **Approve** → pipeline continues
  - Verify: the popup format is `Atrune wants to run: pnpm install drizzle-kit` (in dev mode) OR `Atrune wants to run a command` (if founder mode is on)
- ✅ Design shotgun (if a UI decision comes up, three variants generated and a winner picked)
- ✅ WBS / Dashboard — Atrium-level burndown moves as tasks complete
- ✅ Kanban Board — work items show up in the columns

**Verify on completion:**
- A migration file lives at `quicklink/drizzle/0000_initial.sql`
- Cross-vendor review artifact at `~/.guideai/.../deliverables/cross-vendor-review.md` with verdicts

---

### Brief 4 · Documentation

**Use the "Write technical documentation" template.** Edit to:

> Document QuickLink:
> - README.md at the project root with a 3-paragraph overview + install/run/test
> - ARCHITECTURE.md describing the data flow and table schema
> - API.md with every endpoint, params, responses, examples
> - Tone: technical but warm; audience: another engineer who'll inherit it

**Features exercised:**

- ✅ Template + body edit
- ✅ **Founder mode** — flip `atrune.founderMode` on in VS Code settings; verify the status bar now reads "your team is writing the docs · …"
- ✅ Lighter pipeline (docs briefs skip heavy `verify` phase)
- ✅ Deliverables viewer — open each markdown artifact in the Mission Control deliverables tab

**Verify on completion:**
- All three markdown files exist
- READMEs are coherent, not hallucinated; cite real endpoints from Brief 1

---

### Brief 5 · Refactor

**Use the "Refactor existing code" template.** Edit to:

> Refactor quicklink/ for:
> - Each route handler in its own file
> - Shared types in src/types.ts
> - Smaller functions (target: <30 lines each)
> - Drop any dead imports
>
> Constraint: every existing test must still pass.

**Features exercised:**

- ✅ Template
- ✅ Auto-hire picks a different agent (a refactorer / senior-engineer should be hired, not a builder)
- ✅ Memory injection (latest brief should reference the file structure from Briefs 1+3)
- ✅ Verify phase actually runs `pnpm test` and confirms all tests still green
- ✅ **Killswitch** — let the brief run for 30 seconds, then click the killswitch button in the sidebar; verify the pipeline halts within 5s and the partial state is recoverable

**Verify on completion:**
- Resume the killed brief from Mission Control
- It picks up where it left off, doesn't restart from scratch
- Final tests pass

---

### Brief 6 · Ship to GitHub

**What you type:**

> Push QuickLink to a new GitHub repo called `quicklink-test`. Sync our
> open work items to GitHub issues. Don't enable Pages or any CI — just the
> code + issues.

**Features exercised:**

- ✅ **GitHub integration** — repo creation via `gh` CLI
- ✅ Deliverables push (the markdown docs land in the repo)
- ✅ Work-item-to-issue sync (every open task in WBS → issue)
- ✅ Issue body formatting (each issue links back to its Atrune brief)

**Verify on completion:**

```bash
gh repo view <your-username>/quicklink-test --web
gh issue list --repo <your-username>/quicklink-test
```

You should see ~5–10 issues, the code, and the docs.

---

## Direct-task interludes — run between briefs

These bypass the pipeline; verify they still respect budget + memory + approvals.

### Interlude A · Ask one agent (manual hire)

After Brief 1, in VS Code:

1. Right-click `quicklink/index.ts` → **Atrune: Auto-fix this**
2. Prompt: *"add structured logging with pino"*
3. **Verify:** cost preview popup appears with `~$0.18, ~3 min`
4. Click Continue → agent runs
5. Output opens in an **untitled Markdown tab** with token/cost/duration header
6. SCM panel shows changes; review and accept

### Interlude B · Ask one agent (named)

After Brief 2:

1. In Team view, right-click the UX designer agent → **Send direct task**
2. Prompt: *"give me two layout variants for the QuickLink homepage"*
3. **Verify:** two designs delivered; founder mode (if on) changes the popup phrasing

### Interlude C · Selection-based

After Brief 5:

1. Open `quicklink/index.ts`
2. Select the regex that validates URLs
3. Right-click → **Atrune: Ask agent about this selection**
4. Type: *"explain this regex"*
5. **Verify:** response is contextual to the selected text, not generic

---

## VS Code extension — surfaces touched across the whole run

| Surface | Verified during |
|---|---|
| Activity bar icon (cube glyph) | Pre-flight |
| 🎯 Active work TreeView | Every brief (live updates per phase) |
| ✅ Pending TreeView + badge count | Brief 3 (manual approval flow) |
| 👥 Team TreeView | Brief 2 (hires) + Interlude B (right-click) |
| 💬 New brief toolbar button | Briefs 2, 4, 5 (template path) |
| ⚡ Quick ask toolbar button | Interludes A, B |
| 📦 Mission Control toolbar button | Pre-flight + every brief check |
| ⚙️ Settings toolbar button | Pre-flight + Brief 4 (founder mode) |
| Status bar — narrator | Continuously |
| Status bar — budget HUD | Continuously |
| Status bar — pending count | Brief 3 |
| Native approval popups | Brief 3, every paid Bash |
| Project templates picker | Briefs 2, 4, 5 |
| Cost preview modal | Briefs + Interlude A |
| Founder mode toggle | Brief 4 |
| Walkthrough | First activation only — run `Atrune: Show me around` to re-test |
| **Browse marketplace** link (Team view, empty state) | Test with a fresh workspace (no agents yet) |
| **View all briefs** link (Active work, idle state) | Test between briefs |
| Restart server command | Edge case: kill the server, run this command, verify recovery |
| Switch project command | After creating a 2nd workspace (see Edge Cases) |

---

## Edge cases — deliberately break things

These tests verify failure modes don't corrupt state.

### E1 · Budget cap exceeded

1. Settings → Budget → set workspace cap to $0.10
2. Submit Brief 1 (would normally cost ~$0.50)
3. **Verify:** pipeline pauses mid-phase with a "budget cap hit" message in the narrator
4. Raise the cap, resume the brief, verify it completes

### E2 · Deny an approval

1. Mid-Brief 3, deny the `pnpm install drizzle-kit` approval popup
2. **Verify:** pipeline pauses with the implementer trying an alternate path (e.g. inline JSON migration) OR fails gracefully with a clear error
3. Atrune output channel shows the denial chunk

### E3 · Two workspaces, switch between

1. Create a second workspace called `scratchpad`
2. Use the Switch project command in VS Code
3. **Verify:** sidebar, status bar, and Mission Control all reflect the new workspace
4. Submit a trivial brief in `scratchpad`; verify it doesn't affect QuickLink

### E4 · Archive + recreate

1. Settings → Workspaces → archive `quicklink`
2. **Verify:** it disappears from the active list
3. Create a new workspace also called `quicklink`
4. **Verify:** the slug auto-suffixes (`quicklink-2`); no 409 error
5. Unarchive the original; both should coexist

### E5 · Server restart mid-pipeline

1. Submit Brief 5 (refactor)
2. After 30s, run `Atrune: Restart server` from the command palette
3. **Verify:** the active brief shows "paused — server restarting", then resumes after ~10s
4. No deliverables corruption

### E6 · Cross-vendor disagreement

1. In a fresh small brief: *"What's 2+2? Output the answer in Spanish."*
2. Tag as security-sensitive (forces cross-vendor review)
3. If reviewers disagree, the verdict appears in Validation with both opinions

---

## Daily standup + digest

After all six briefs complete:

1. Wait until midnight UTC, or manually trigger the digest cron
2. **Verify:** an `~/.guideai/digests/<date>.md` file appears summarizing what shipped, agent metrics, budget spent
3. The next-day standup post should reference yesterday's work items

---

## Cleanup

1. Archive the `quicklink` workspace
2. `rm -rf quicklink/` (the actual code on disk)
3. `gh repo delete <user>/quicklink-test --yes` (optional; or keep as a portfolio artifact)
4. Reset budget cap in Settings

---

## Feature coverage matrix

Cross-check every feature got tested. If a column is empty, your run missed
that feature — extend the test plan with a targeted brief.

| Feature | Brief / Step |
|---|---|
| Workspace creation | Pre-flight |
| Workspace switching | E3 |
| Workspace archival | E4 |
| Per-workspace integration credentials | Pre-flight |
| Brief intake (manual) | Brief 1 |
| Brief intake (template) | Briefs 2, 4, 5 |
| Security-tagged brief | Brief 3 |
| Discovery round-table | Brief 1 |
| Auto-hire | Briefs 1, 5 |
| Manual hire | Brief 2 |
| Hire approval/denial | Brief 2 |
| Plan review | Briefs 1, 3 |
| Critic gate | Brief 1 |
| 5-phase pipeline | Briefs 1, 2, 3, 5 |
| Lighter docs pipeline | Brief 4 |
| Budget governor | Continuous |
| Budget cap exceeded | E1 |
| Cross-vendor sanity check | Brief 3, E6 |
| Browser validation | Brief 1 |
| WBS / Dashboard | Brief 3 |
| Kanban Board | Brief 3 |
| Channels (team chat) | Brief 2 |
| Org view (roster) | Brief 2 |
| Logs / replay | Brief 1 (PreToolUse) |
| Deliverables tree | Brief 1, every brief |
| Slide deck viewer | Brief 4 (if any slides generated) |
| GitHub integration — repo create | Brief 6 |
| GitHub integration — deliverables push | Brief 6 |
| GitHub integration — issue sync | Brief 6 |
| Validation reports | Brief 1, Brief 3, E6 |
| Killswitch | Brief 5 |
| Memory injection | Briefs 2, 5 |
| Design shotgun | Brief 3 |
| Approval rules | Brief 3, E2 |
| Daily standup digest | Standalone post-run |
| Direct task: Ask one agent | Interludes A, B |
| Direct task: Auto-fix file | Interlude A |
| Direct task: Selection ask | Interlude C |
| VS Code: Activity bar icon | Pre-flight |
| VS Code: Active work view | Continuous |
| VS Code: Pending view + badge | Brief 3 |
| VS Code: Team view | Brief 2, Interlude B |
| VS Code: Toolbar buttons (4) | Pre-flight, every brief |
| VS Code: Status bar narrator | Continuous |
| VS Code: Status bar budget HUD | Continuous |
| VS Code: Status bar pending count | Brief 3 |
| VS Code: Native approval popups | Brief 3 |
| VS Code: Project templates picker | Briefs 2, 4, 5 |
| VS Code: Cost preview modal | Briefs + Interlude A |
| VS Code: Founder mode | Brief 4 |
| VS Code: Walkthrough | First activation |
| VS Code: Browse marketplace link | Fresh workspace step |
| VS Code: View all briefs link | Between briefs |
| VS Code: Restart server | E5 |
| VS Code: Switch project | E3 |
| VS Code: Refresh sidebar | Continuous (auto-poll) |

---

## Pass/fail criteria

The test plan passes if:

1. All six briefs complete with deliverables on disk
2. The QuickLink app actually works (`curl localhost:<port>/shorten` returns a code; redirect works; tests pass)
3. The GitHub repo exists with code + ≥5 synced issues
4. Every row in the feature coverage matrix has been ticked at least once
5. No state corruption between workspaces (E3, E4)
6. Edge cases E1–E6 produce sane failure / recovery behavior

**Failures to file as bugs:**
- Any phase that completes without writing its artifact
- Any approval popup that doesn't actually approve/deny when clicked
- Any TreeView that stays empty when data exists (and refresh doesn't fix it)
- Any budget HUD that goes negative or stops updating
- Any cross-vendor review with one verdict (should always be two opinions)
- Any direct task that bypasses the budget gate

---

## Estimated time

| Phase | Time |
|---|---|
| Pre-flight | 10 min |
| Briefs 1–6 (sequential) | 75 min |
| Interludes A–C | 15 min |
| Edge cases E1–E6 | 25 min |
| Daily digest verification | overnight or manual trigger (5 min if manual) |
| Cleanup | 5 min |
| **Total active time** | **~2h 15min** |

Run this end-to-end after every significant release. Run a subset (briefs 1 + 3 + 6) as a daily smoke test.
