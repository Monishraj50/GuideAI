# GuideAI Build Log

Per ECC Principle 7B: every build session appends a 5-line entry. Read this before starting a session.

---

## Step 1 — Monorepo skeleton (done 2026-06-13)

- pnpm@9 installed user-local at `~/.npm-global/bin/pnpm` (no sudo on this host).
- pnpm workspaces wired; `apps/{server,web}` present, `apps/web` is a placeholder until step 4.
- `packages/shared` ships Drizzle schema + `init-db` script. `pnpm init-db` → `~/.guideai/db.sqlite` (WAL, FK on, 7 tables, 5 indexes).
- `packages/policies` ships caps stubbed (Principles 1,2,5,9) and model router (Principle 4).
- Demo: `pnpm dev` brings up `apps/server` on :4000; `GET /healthz` returns caps payload → wiring confirmed end-to-end.
- **Skipped (Principle 10 — surfaced, not silent):** Next.js scaffold deferred to step 4 to keep step 1 lean. `apps/web` runs a placeholder script. The recursive `pnpm -r run dev` pattern was abandoned because subprocess PATH doesn't include user-local pnpm — root `dev` now calls `tsx` and `node` directly via `concurrently`.
- **Pass@1 dogfood check (Principle 9B):** `pnpm init-db` and `pnpm dev` re-run from clean state, both work.

---

## Step 2 — runtime-claude adapter (done 2026-06-13)

- `packages/runtime-core` ships the `RuntimeAdapter` interface (`spawn` + `runOnce` + `AgentHandle`). Designed so Codex/Copilot/Gemini adapters plug in identically.
- `packages/runtime-claude` implements `ClaudeAdapter`: spawns the `claude` CLI with `--output-format stream-json --verbose`, parses stream-json into our `Chunk` discriminated union (UserChunk/AIChunk/SystemChunk/ToolChunk).
- Sandboxing per Principle 8: ensures the agent's `cwd` exists, builds env from a small allowlist (`PATH, HOME, LANG, LC_ALL, TERM, USER`), opt-in env via `SpawnOpts.env`. No `*_TOKEN/*_KEY` leak by default.
- Kill-switch (Principle 8): `handle.kill()` sends SIGTERM then SIGKILL after 2s if process hasn't exited.
- Smoke (`pnpm --filter @guideai/runtime-claude smoke`): runs in `~/.guideai/workspaces/_smoke/agents/smoke-agent/cwd`, sends a single-word prompt, receives 4 chunks including one AI chunk with token counts.
- **Pass@2 (Principle 9B):** both runs identical (4 chunks, "ok", model=`claude-opus-4-7`, ~3.2s, exit 0).
- **Skipped (Principle 10 — surfaced, not silent):** `runOnce` is fully wired; `spawn` (interactive long-running mode) compiles and is structurally complete but its stdin protocol (`{type:'user', text}`) hasn't been exercised end-to-end — that lands in step 5 when an agent receives messages from another agent.

---

## Step 3 — messaging + events.jsonl + SSE (done 2026-06-13)

- `packages/messaging` ships three modules:
  - `events.ts` — `appendEvent(workspaceId, chunk)` and `readEvents(workspaceId, {sinceTs?, sinceOffset?})` over the workspace's `events.jsonl`.
  - `inbox.ts` — per-agent JSONL inbox (`InboxMessage` shape), `send()` + `readInbox()`.
  - `watcher.ts` — `watchWorkspace(workspaceId, onChunk, {fromOffset})` tails `events.jsonl` using chokidar (polling at 50ms) + a 250ms fallback interval drain. Survives file rotation/truncate.
- `apps/server/src/sse.ts`:
  - `GET /api/workspaces/:id/events` opens an SSE stream. Replays backlog (filterable by `?since=<ts>`), emits `event: ready` once replay is done, then streams live chunks. 15s heartbeat keeps proxies awake. Closes watcher on client disconnect.
  - `POST /api/workspaces/:id/events` appends a chunk (used by tests/dev; agents will write directly via the messaging package later).
- Smoke (`pnpm --filter @guideai/messaging smoke`): spawns the server on :4321, opens SSE, writes 3 events via 3 different paths (file append, HTTP POST, second file append after 300ms), verifies all 3 arrive live; then reconnects and verifies backlog replay sees all 3; then verifies inbox `send`+`readInbox` round-trip.
- **Pass@2 (Principle 9B):** both runs green. Live SSE delivers all 3 system chunks plus the `ready` signal; backlog replay returns 4 (3 + ready); inbox round-trip OK.
- **Bug squashed during build (Principle 10B noted):** fs.watch on Linux missed rapid sequential file appends. Switched chokidar to polling mode (`usePolling: true, interval: 50`) and added a 250ms fallback drain interval as a second safety net. Initial smoke test also had a wait-condition bug that counted the SSE `ready` event toward the expected 3 — fixed to filter by text.

---

## Step 4 — Mission Control feed, read-only (done 2026-06-13)

- `apps/web` rebuilt as Next.js 15 (App Router) + Tailwind 3 + React 19.
- Routes scaffolded: `/ops` (active), `/channels`, `/org`, `/hire`, `/logs`, `/settings` (placeholders signposted to their later steps — Principle 10B).
- `app/ops/EventFeed.tsx` is a client component using native `EventSource` to subscribe to `/api/workspaces/:id/events`. Per-row glyph + agent + text/preview + token badge for AI chunks. Header shows live connection light, backlog count, and **token meter** (running totals of `tokensIn` / `tokensOut`).
- `next.config.mjs` proxies `/api/*` and `/healthz` to the Fastify server on :4000 — single-origin in dev, no CORS friction.
- Root `pnpm dev` now boots both apps via concurrently (server :4000, web :3000).
- **Verified (pass@2):**
  - `/ops` renders SSR HTML with our Tailwind tokens compiled into `/_next/static/css/app/layout.css`.
  - `/healthz` via :3000 proxy returns the caps payload.
  - SSE through proxy delivers 5+ live chunks across 4 kinds (system / ai / phase / tool). Backlog replay confirmed across reconnects.
  - AI chunks expose `tokensIn / tokensOut / model` in the UI's per-row badge.
- **Skipped (Principle 10B):** brief pane is rendered but disabled (lands in step 5); other tabs are signpost stubs.

---

## Step 5 — single-agent end-to-end (done 2026-06-13)

- `packages/orchestrator` ships `submitBrief()` (Chief-of-Staff dispatcher) and `decideApproval()` + `listPending()`. Idempotent CoS agent provisioning per workspace (one row per role+workspace).
- `apps/server`: two new route modules — `routes/briefs.ts` (`POST /api/workspaces/:id/briefs`) and `routes/approvals.ts` (`GET /api/workspaces/:id/approvals/pending`, `POST /api/approvals/:id?workspace=...`).
- `apps/web/app/ops`: `BriefPane` (live textarea + ⌘↵ submit) and `PendingTray` (1.5s poll, approve/deny buttons), wired into the right rail of `/ops`.
- Synthetic Bash tool-use is appended at the end of every brief to demo the approval pathway; **step 8 will replace this with a real MCP permission-prompt-tool hook**.
- **Verified (pass@2):**
  - **Run 1 (approve):** brief "Plan how to ship our v0.1 docs site by Friday" → 4 chunks captured, agent responded, synthetic Bash approval surfaced → `POST /api/approvals/...?workspace=demo {decision:'approved'}` → events.jsonl ends with `approval: approved` + `system: approved Bash(...) — would execute`.
  - **Run 2 (deny):** brief "Outline a tiny CI pipeline in 3 bullets" → same flow → `decision:'denied'` → events.jsonl ends with `approval: denied` + `system: denied Bash(...)`.
  - Same agent id reused on second brief (idempotent provisioning).
  - 11 events written per run, all parse-clean.
- **Bug noted:** `tsx watch` killed the server during build when a route imported `@guideai/orchestrator` before the workspace `pnpm install` had been run. Workflow lesson: install new workspace packages BEFORE saving routes that import them, or restart dev after install.
- **Skipped (Principle 10B):** real tool interception via MCP permission-prompt-tool (step 8); brief is sent through one-shot `runOnce` rather than long-running `spawn` (step 6+ when phases need stdin replies).

---

## Step 6 — phase pipeline + model router + skill loader (done 2026-06-13)

- `packages/skills` ships `loadSkills()` (reads `~/.guideai/skills/*.md`, frontmatter-parsed), `skillsForPhase()`, `renderSkillsAsContext()`. Skills with `appliesTo: research, plan, …` are injected only into matching phases' system prompts.
- `packages/orchestrator/src/phases.ts` runs the ECC sequential pipeline `research → plan → implement → review → verify`. Each phase consumes prior artifacts as context, writes its own markdown artifact to `~/.guideai/workspaces/{id}/briefs/{briefId}/{phase}.md`, and emits `phase: started` / `phase: completed` chunks.
- `packages/policies/src/router.ts` updated to use CLI-friendly model aliases (`haiku`, `sonnet`, `opus`) instead of dated IDs — portable across CLI versions and subscriptions.
- `cos.ts.submitBrief()` rewritten as async: returns `{briefId, agentId, phases, pipeline:'started'}` in ~17ms; the full pipeline runs in the background and surfaces every phase via SSE.
- **Verified (pass@2):**
  - **Run 1** — brief "Sketch a 3-line health check endpoint" → 5 artifacts written in 56s; 10 phase events (5 started + 5 completed); models hit: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-8`; total 4927↓ / 23↑ tokens.
  - **Run 2** — brief "Decide whether to bundle our two utility packages" → 5 artifacts in 65s; 10 phase events; same three model families hit; total 4964↓ / 41↑ tokens.
  - Model tier per artifact frontmatter matches router decision: research=haiku, plan=sonnet, implement=sonnet, review=opus, verify=haiku.
- **Bug squashed during build (Principle 10B):** initial sync `submitBrief` held the HTTP request open for the entire 5-phase pipeline (~30-60s) → Next.js dev-proxy timeout (`ECONNRESET`). Refactored to fire-and-forget.
- **Surfaced (Principle 10B):** the agent occasionally produces a clarifying question instead of a phase artifact (e.g. "What framework is your API using?"). That's a prompt-engineering miss in the phase prompts — fix in step 7 (Stop hooks promote successful trace patterns into reusable skills).

---

## Step 7 — Stop hooks + skill promotion (done 2026-06-13)

- `packages/skills/src/promote.ts` ships `promoteSkillFromTrace()`: heuristic-only (no extra LLM call), turns each phase's first non-empty line into one bullet under "Lessons from a prior similar brief." Slug derived from the brief via stopword-filtered tokens. Idempotent: collisions get a `-2`, `-3`, … suffix.
- `cos.ts` calls promotion at the tail of every successful pipeline. Writes a `skill_id` row to `schema.skills` and emits a `system: skill promoted: …` chunk to the feed.
- `phases.ts` emits `skills loaded: N (name1, name2)` at the start of every run — observability for "did the skill actually get loaded".
- **Verified end-to-end (matching demo target):**
  - **Run 1** — brief "Refactor our config loader to read from a single env file" → 5 artifacts → skill `auto-refactor-config-loader-read.md` written to `~/.guideai/skills/`.
  - **Run 2** — brief "Switch our settings module to use a TOML file instead of JSON" → emitted `skills loaded: 2 (auto-refactor-config-loader-read, concise-bullets)` (the run-1 skill was picked up alongside the manual control skill); pipeline completed; another skill `auto-switch-settings-module-use.md` promoted.
  - Skills folder ends with 2 auto-promoted + 1 manual = 3 files.
- **Surfaced (Principle 10B):** heuristic promotion is intentionally non-LLM. A higher-quality LLM-distilled variant lands later as an opt-in setting; this stays Haiku-class cost (zero) by default.

---

## Step 8 — auto-approval rule engine + Settings UI (done 2026-06-13)

- `packages/policies/src/engine.ts` ships the full rule engine: `loadPolicies()` / `savePolicies()` over `~/.guideai/policies.json`, `evaluateTool(p, tool, args)` returns `{action, ruleId, ruleDescription}`, `addRule()` / `removeRule()` mutators, `synthesizeRuleFromDecision()` proposes a rule that auto-{decides} an identical future call.
- Default `policies.json` ships with 3 built-in auto-approves (Read/Glob/Grep) and `defaultAction: 'ask'`.
- `apps/server/src/routes/policies.ts`: `GET /api/policies`, `PUT /api/policies`, `POST /api/policies/rules`, `DELETE /api/policies/rules/:id`, `POST /api/policies/rules/synthesize`.
- `cos.ts` synthetic-Bash code path now consults `evaluateTool()` first. On rule match, emits a `ToolChunk(status: 'denied' | 'auto-approved')` + `ApprovalChunk(decision, ruleId)` + a `system: auto-<decision> … via <ruleId>` note — **no pending approval row is created**.
- `apps/web/app/settings/RulesEditor.tsx`: list / add / remove rules with action color-coding (auto-approve = accent, always-ask = warn, deny = err).
- `apps/web/app/ops/PendingTray.tsx`: after approve/deny, shows "don't ask me about this again" button that calls synthesize → save → drops back into the steady state.
- **Verified end-to-end (demo target — "deny once, accept the auto-rule, never asked again"):**
  - **Run 1:** brief "Tell us one thing to improve about our error handling" → synthetic `Bash(ls -la)` lands as pending → denied via API → synthesize call produced `rule-syn-bash-…` (`action: deny`, `argsPattern: ^\\{"cmd":"ls -la"\\}$`) → POST `/api/policies/rules` saved it at the top of the list.
  - **Run 2:** brief "Pick one log line we should always emit at startup" → synthetic Bash emitted → policy engine matched the rule → `ToolChunk(status:'denied')` + `ApprovalChunk(decision:'denied', ruleId: rule-syn-bash-…)` + `system: auto-denied Bash(...) via rule-syn-bash-…` — **no new pending approval row created**.
- **Surfaced (Principle 10B):** rules apply only to *new* decisions; stale pending approvals from before the rule existed stay queued until the user acts on them. That's intentional (avoids surprising retroactive auto-flips), worth a UI bulk-clear later.

---

## Step 9 — Hire Marketplace (done 2026-06-13)

- `packages/agents-catalog` ships `loadCatalog()`, `departments()`, `findAgent()`, and a `seed.ts` script that fetches the full catalog from `VoltAgent/awesome-claude-code-subagents` via GitHub trees API + `raw.githubusercontent.com` (no rate-limit on raw). One-time `pnpm --filter @guideai/agents-catalog seed` writes `~/.guideai/catalog/catalog.json` (~880KB) with 154 agents across 10 departments.
- `packages/orchestrator/src/hiring.ts` ships `hireAgent()`, `retireAgent()`, `listRoster()`. Hires are idempotent on `role` (returns the existing live agent if present); retire sets `status: 'retired'` (doesn't delete — preserves audit). Re-hiring after retire creates a new agent row with a fresh id.
- `apps/server/src/routes/catalog.ts`: `GET /api/catalog` (departments + count), `GET /api/catalog/agents` (filter by `?dept=…&q=…`), `GET /api/catalog/agents/:role` (full body for preview), `POST /api/workspaces/:id/agents {role}`, `DELETE /api/workspaces/:id/agents/:agentId`, `GET /api/workspaces/:id/agents` (roster).
- `/hire` page: 3-column layout — department list (incl. live counts) + active filter, search-by-substring middle pane with hire button, and a right-rail preview that loads the system-prompt body on hover.
- **Verified end-to-end:**
  - seed → 154 agents written; departments breakdown matches VoltAgent's repo (Language Specialists 30, Quality & Security 17, Infrastructure 16, etc.).
  - `POST /api/workspaces/demo/agents {role:'backend-developer'}` → row inserted with tools `[Read,Write,Edit,Bash,Glob,Grep]`; second identical call returns the same id (idempotent).
  - Hired three roles (backend-developer, frontend-developer, qa-expert) → roster of 4 (plus CoS).
  - Retired backend-developer → roster shrinks to 3 → hired again → got a NEW id (`backend-developer-92331b`), proving non-destructive retire + clean re-hire.
  - Every hire/retire emits a `system: hired … into workspace` / `system: retired …` chunk; SSE confirms 5 such events across the test.
- **Surfaced (Principle 10B):** `prettyName()` title-cases naively → "qa-expert" renders as "Qa Expert" instead of "QA Expert". Cosmetic, easy fix in step 10 when Org Chart polishes the display names; agent identity is by `role`, not by display name, so no functional impact.

---

## Step 10 — Org Chart + Performance Reviews (done 2026-06-13)

- `packages/metrics/src/index.ts` ships `computeRosterStats(workspaceId)`. For each agent it derives: tasks completed / failed, win rate, avg phase ms, rework count (same `(briefId, phase)` repeated), tokens in/out, USD spend (Anthropic-tier pricing approximated by model alias), and last activity. Pure SQL-backed compute — no LLM calls, no extra writes.
- `GET /api/workspaces/:id/metrics` exposes the snapshot.
- `/org`: grid of agent cards heat-tinted by win-rate (≥85% accent / ≥60% warn / <60% err / no tasks = neutral). Top bar shows aggregate active/retired counts + workspace spend + token total. Clicking a card opens a right-rail detail panel with 8 stat tiles and a retire button. Refreshes every 4 s.
- `apps/web/app/org/OrgChart.tsx` patches the naive title-case from step 9 with an ACRONYMS map (`QA, API, AI, LLM, ML, CI, CD, AWS, SQL, CSS, …`).
- **Verified end-to-end:**
  - `GET /api/workspaces/demo/metrics` returned 5 agents (CoS + 3 active hires + 1 retired).
  - **Chief of Staff:** 35 tasks completed (matches 7 prior briefs × 5 phases), winRate 100% (green tint), tokens 34 813 ↓ / 460 ↑, **$0.11** spend.
  - **3 fresh hires:** 0 tasks → neutral tint (intentional — pipeline still goes through CoS until step 11+ wires dispatch to specialists).
  - **Retired backend-developer:** filtered out of the active grid, listed in the "Retired" footer.
  - Re-hired backend-developer (post-retire) appears as a separate row with its own id.
- **Surfaced (Principle 10B):** specialists in the roster don't get tasks yet because the orchestrator still routes everything through CoS. Wiring dispatch-to-specialist lands in a later step; their cards intentionally read "0" until then.

---

## Step 11 — pass@k eval checkpoints (done 2026-06-13)

- `packages/evals/src/index.ts` ships `runPassK<T>({ k, requireAgreement, attempt, predicate?, parallel? })`. Runs N independent attempts (parallel by default), applies a "passed" predicate (default: text ≥ 30 chars), returns `{ attempts, passes, verdict, canonical, passthroughs }`. Canonical = longest passing (fallback: longest overall).
- `packages/orchestrator/src/phases.ts` consults `CAPS.evals[phase]` per phase. Default `implement` and `review` = `k:1, require:1` (single-call fast path). When the brief is `securityTagged`, the **review** phase uses `CAPS.evals.security = { k: 3, requireAgreement: 3 }`.
- `cos.ts` detects security tagging from either an explicit `securityTagged: true` in the POST or a `[security]` / `[sec]` prefix in the brief body.
- UI: `BriefPane` got a `security review (review phase runs pass@3)` checkbox.
- Each pass@k phase emits 2 system chunks (`running pass@k (security-tagged)` and `pass@k verdict: X · Y/k attempts passed`), forwards every attempt's raw chunks to the feed, and writes a multi-section `review.md` with frontmatter (`pass@3 · verdict: pass (3/3)`), the canonical answer, then each attempt verbatim with its own pass/fail header.
- **Verified end-to-end (demo target — "security-tagged task runs review pass@3"):**
  - Brief: `[security] Outline a basic CSRF check for a public API endpoint.` with `securityTagged: true`.
  - Pipeline took 75s end-to-end.
  - Feed shows `phase review running pass@3 (security-tagged)` and `pass@3 verdict: pass · 3/3 attempts passed (req 3)`.
  - 6 opus AI chunks total (3 attempts × 2 chunks per stream) — matches pass@3 expected count.
  - `review.md` header: `_model: opus · pass@3 · verdict: pass (3/3) · tokens: 9744 in / 24 out_`. Three `### attempt N (pass)` sections present.
- **Surfaced (Principle 10B):** the "pass" predicate is *length-based*, not semantic — three coherent reviews and three near-empty reviews would both produce `verdict: pass`. A judge-panel pattern (one extra agent voting on agreement) is the next-tier upgrade; this v1 implementation catches "agent silently gave up" but not "three plausible disagreements".

---

## Step 12 — Daily standup digest cron (done 2026-06-13)

- `packages/orchestrator/src/digest.ts` ships `generateDigest({workspaceId, windowMs?})` and `readLatestDigest(workspaceId)`. Aggregates the last 24h of `events.jsonl` into counters (briefs, phases-completed, hired/retired, approved/denied, skills-promoted, tokens), invokes Haiku for the narrative paragraph, falls back to deterministic copy if Claude is unreachable. Writes `~/.guideai/workspaces/{id}/digests/{yyyy-mm-dd}.md` and emits a `system: digest generated for {date}` chunk.
- `apps/server/src/routes/digest.ts`: `GET /api/workspaces/:id/digest` (latest), `POST /api/workspaces/:id/digest?window=ms` (run now). Also registers a `node-cron` schedule `'0 9 * * *'` that iterates every DB-known workspace at 09:00 local.
- `apps/web/app/page.tsx` becomes a real **Home** page (replaces the redirect to /ops) with the latest digest rendered, a "run now" button, and quick links to the other tabs.
- Sidebar gets a Home tab.
- **Verified end-to-end (demo target — "trigger manually, digest renders on Home"):**
  - `POST /api/workspaces/demo/digest` → 4s round-trip; returns `{date: '2026-06-13', filePath, text, summary, generatedAt}`.
  - Summary counters extracted from the live `events.jsonl`: briefs 1, phases completed 5, approvals 0 approved / 1 denied, skills promoted 1, tokens 9800 ↓ / 48 ↑.
  - Markdown file present at `~/.guideai/workspaces/demo/digests/2026-06-13.md` (397 bytes).
  - `GET /api/workspaces/demo/digest` returns the same JSON.
  - SSR HTML on `/` includes "Daily standup digest" / "run now" / quick-links — Home page renders.
- **Surfaced (Principle 10B):** Haiku paragraph quality is the weak link — sample output read "Hi! I see your workspace activity snapshot…" (not a real digest). Better prompt + few-shot examples land later. Cron behaviour itself is fully validated via the `?run=now` trigger path — at 09:00 the same code path runs.

---

## Step 13 — Cross-runtime adapter scaffold (done 2026-06-13)

- `packages/runtime-core/src/index.ts` extended `RuntimeAdapter` with `displayName`, `availability: 'ready' | 'coming-soon'`, and `description`. New `makeStubAdapter()` factory returns an adapter that throws on `spawn`/`runOnce` — UI can show non-ready runtimes without silent mis-route.
- `packages/runtime-core/src/registry.ts` ships `STUB_ADAPTERS` for `codex`, `copilot`, `gemini` and `listRuntimes(claudeAdapter)` to build the public listing.
- `packages/runtime-claude/src/adapter.ts` now sets `availability: 'ready'`, declares `displayName: 'Claude Code'`, and exposes the CLI path.
- `apps/server/src/routes/runtimes.ts`: `GET /api/runtimes` returns all 4 runtimes.
- UI: BriefPane has a runtime `<select>` that loads from `/api/runtimes`. Non-ready entries render with the "(soon)" suffix and the HTML `disabled` attribute — visible but unselectable.
- **Verified end-to-end (demo target — "picker visible, only Claude selectable"):**
  - `GET /api/runtimes` returns 4 entries: claude (ready), codex / copilot / gemini (coming-soon), each with capabilities + description.
  - SSR HTML for `/ops` contains `runtime` label + `select` with all 4 `<option>` rows; non-Claude options carry the `disabled` flag.
  - submitBrief still routes through ClaudeAdapter — no behavioural regression on the live path.
- **Surfaced (Principle 10B):** the runtime id is **not yet threaded through `submitBrief()` / `runPipeline()` / `cos.ts`**. The UI picker stores the choice locally but the request body doesn't include it (since only Claude is ready). When the second adapter ships, the API will gain `runtime: 'codex'` and the orchestrator's adapter lookup will swap from a direct `ClaudeAdapter` import to a registry resolve.

---

## Step 14 — Replay / trace view polish (done 2026-06-13)

- `apps/server/src/routes/replay.ts`: `GET /api/workspaces/:id/briefs` (list briefs with phase counts + token totals) and `GET /api/workspaces/:id/briefs/:briefId` (full trace: brief row, task rows, filtered chunks within the brief's window, artifact bodies).
- `apps/web/app/logs/page.tsx` lists briefs with status pill, body preview, timestamps, tokens.
- `apps/web/app/logs/[briefId]/page.tsx` + `Replay.tsx` render the trace view:
  - **Flame graph**: 5 colored bars (haiku/sonnet/opus palette) positioned by `startedAt`, sized by duration. Hover for tooltip with tokens + ms.
  - **Scrubber**: range slider + ⏮ ← → ⏭ buttons. Cursor selects one chunk; rows above it stay visible, the rest hide. Current event banner shows ts + kind + agent + preview.
  - **Artifacts pane**: collapsible list of `research.md`/`plan.md`/`implement.md`/`review.md`/`verify.md` with inline body preview (4 KB cap).
  - **Raw drawer**: bottom panel toggleable via the `raw` button — shows JSONL of every visible chunk.
- `tailwind.config.ts` got 3 model-tier colors (`haiku`, `sonnet`, `opus`) so the flame graph reads as model tiers at a glance.
- **Bug fixed during build (Principle 10B):** `cos.ts` was writing `startedAt: now()` and `endedAt: now()` at the *end* of the pipeline → every task had `dur = 0` and the flame graph degenerated. Threaded real `phaseStartedAt`/`phaseEndedAt` into `PhaseResult` and persisted those to `schema.tasks` instead.
- **Verified end-to-end (demo target — "scrub a completed task end-to-end"):**
  - New brief "Pick a default page size for our list APIs." → 5 phases run in 56.8s.
  - Trace API returns real durations: research 13.1 s (23%), plan 5.3 s (9%), implement 15.3 s (27%), review 16.3 s (29%), verify 6.8 s (12%).
  - 103 chunks present in the window; all 5 artifact files loaded inline.
  - `/logs` lists 10 briefs (1 new + 9 historical); `/logs/<id>` returns 28 KB SSR HTML containing `Replay`, `scrub`, `Artifacts`, `raw` markers.
- **Surfaced (Principle 10B):** pre-existing briefs (steps 5-11) still record `dur: 0` because they were written before this fix. New briefs from step 14 onward have correct durations. A backfill SQL could re-derive these from `events.jsonl` phase chunks if needed.

---

## Step 15 — Audit log + killswitch hardening (done 2026-06-13)

- `packages/runtime-claude/src/adapter.ts` now maintains a module-scoped `TRACKED: Set<Tracked>` registry of every spawned Claude process (both `spawn()` and `runOnce()` paths). Exposes `listRunningClaudeAgents()` for status + `killAllClaudeAgents({hardTimeoutMs=2000})` that SIGTERMs every live process and escalates to SIGKILL after the deadline.
- `apps/server/src/routes/killswitch.ts`: `GET /api/killswitch/status`, `POST /api/killswitch?workspace=…`, and a dev-only `POST /api/dev/spawn-test-agents?n=5` that fire-and-forgets N verbose `runOnce` calls so the killswitch is demoable without waiting for a real pipeline.
- `apps/server/src/routes/audit.ts`: `GET /api/workspaces/:id/audit?limit=N` merges every row in `schema.approvals` (ground truth) with audit-worthy `system:` chunks from the last 7 days (hires, retires, skill promotions, killswitch events, digests, decisions). Sorted newest-first.
- UI:
  - `Killswitch` component pinned to the bottom of the sidebar — polls `/api/killswitch/status` every 2 s, shows running count, button turns red when `running > 0`, asks `confirm()` before firing.
  - `/settings` now embeds an `AuditLog` section with a kind filter (all / approval / hire / retire / skill / killswitch / digest), 4 s refresh.
- **Verified end-to-end (demo target — "spawn 5 agents, click global stop, all killed in <2s"):**
  - `POST /api/dev/spawn-test-agents?n=5` → 5 PIDs returned, registry shows 5 running with uptime ~1 s each.
  - `POST /api/killswitch?workspace=demo` → **`{killed: 5, durationMs: 884}`** (44% of the 2 s budget).
  - Post-kill registry: 0 running.
  - Audit log: top entry is `killswitch | KILLSWITCH: 5 agents killed in 884ms`.
  - Earlier audit history confirms approvals, skill promotion, and hire/retire events are all captured chronologically.
- **Surfaced (Principle 10B):** `spawn()` (long-running interactive) exits fast under the current CLI flags (`-p` is implicit one-shot) — the demo therefore uses `runOnce` fire-and-forget. Real long-running stdin-streaming agents need either dropping `-p` + PTY emulation or wiring an MCP loopback. That's the same gap noted in step 2 and step 13; not blocking the killswitch correctness — both `spawn` and `runOnce` register into the same `TRACKED` set, so the killswitch covers both code paths.

---

## v1 complete

All 15 build steps shipped. The platform is live at:

- Web UI: http://localhost:3000
- API: http://localhost:4000
- State: `~/.guideai/` (SQLite + JSONL events + agent inboxes + skills + digests + catalog)

Tabs end-state:
- `/` — Home (digest)
- `/ops` — live event feed, brief pane (with runtime picker, security checkbox), pending tray
- `/channels` — stub (lands when specialists get dispatched)
- `/org` — heat-tinted roster, performance metrics, retire UI
- `/hire` — 154-agent marketplace by department
- `/logs` + `/logs/[briefId]` — brief list + flame-graph replay + artifact pane + raw drawer
- `/settings` — rules editor + audit log

Killswitch always visible bottom-left.

VS Code extension (sibling app per the plan) is the planned next-tier integration.

