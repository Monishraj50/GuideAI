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

---

## Polish pass — UI refresh (done 2026-06-13)

Inspiration: agent-teams-ai aesthetic — dense, professional dark theme; live HUD meters; polished microinteractions. Took the energy without copying the Kanban metaphor.

**Foundation:**
- Inter (UI) + JetBrains Mono (code) via `next/font/google` with CSS variables.
- Refined Tailwind palette — layered greys (`bg`/`surface`/`surface2`/`line`/`line2`), ink ladder (`ink`/`ink2`/`dim`/`dim2`), accent + gradient `accent → accent2`, tier colours retained (`haiku`/`sonnet`/`opus`).
- Custom keyframes: `pulse`, `shimmer`, `slideUp`, `fadeIn`. Global `:focus-visible` ring + slim scrollbar. Radial-gradient body background gives the page subtle depth.
- `lib/cn.ts` helper around `clsx` for variant composition.

**New shared components:**
- `TopBar` — workspace selector + live HUD meters (active agents, tokens, $ spend, running-process count with red pulse when armed) + ⌘K search shortcut.
- `CommandPalette` (`⌘K`) — fuzzy command launcher: navigate, run digest, fire killswitch, with arrow-key navigation and modal backdrop blur.
- `ToastHost` + `toast({title, description?, variant})` — bottom-right stack with `success`/`warn`/`error`/`info` colour-coded, auto-dismiss, slide-up entry. Wired into hire, retire, brief, approval, killswitch, rule-save flows.
- `Sparkline` — pure-SVG 80×22px polyline with end-dot. Used on Org cards.

**Refreshed surfaces:**
- **Sidebar** — Lucide icons per tab, active row gets an accent left-bar + `bg-line2/60`, glass background, killswitch pinned at the bottom (red shadowed when armed).
- **Ops feed** — icons per chunk kind, model-tier pills (haiku/sonnet/opus colour-coded) on AI rows, animated connection dot, sticky "jump to live" pill when scrolled away.
- **BriefPane** — focus-accent textarea, security checkbox with `ShieldAlert` icon, runtime select with CPU icon, gradient send button with spinner state, `⌘↵` hint.
- **PendingTray** — animated cards (slide-up), `Wrench` glyph, "don't ask again" follow-up card.
- **Home** — gradient title with stable greeting ("Hello, boss" → "Good {tod}, boss" post-hydration), digest hero card, quick-link grid.
- **Org Chart** — heat-tinted cards with sparkline trends, status-aware pulse dot, hover lift, detail aside slides in.
- **Hire** — Lucide-icon hire/retire/preview buttons, hover-only retire (`opacity-0 group-hover:opacity-100`), animated department list, shimmer skeleton during catalog load.
- **Logs** — status pill badges, replay flame graph with hover tooltips, scrubber with chevron buttons, artifact accordion, raw drawer slides up.
- **Settings** — rule rows with action-coloured pills, hover-reveal delete, audit log filter dropdown, polished add-rule bar with focus-accent inputs.

**Hydration-safety fix (Principle 10B):** `Home.timeOfDay()` was called inline → SSR computed it server-side, client hydrated with a potentially different value. Moved into `useState('Hello')` + `useEffect` → stable SSR placeholder, client overwrite on mount.

**Verified:** all 6 routes (`/`, `/ops`, `/org`, `/hire`, `/logs`, `/settings`) return HTTP 200; SSR HTML contains the new components (TopBar meters, Sidebar nav, gradient title, glass panels). Tailwind compiled with the new palette. Fonts loaded via Next.js Font.

---

## Project layer — multi-workspace navigation (done 2026-06-13)

The system now treats every workspace as a first-class **project** that you can browse, plan against, and switch between.

**Server API:**
- `GET  /api/workspaces` — full list with summaries (agents, briefs, pending approvals, tokens, $ spend, last activity, digest date).
- `POST /api/workspaces` — create with slug-derived id (`"Acme Docs Site"` → `acme-docs-site`); 409 on collision.
- `DELETE /api/workspaces/:id` — soft archive (sets `autonomyMode: 'archived'`; data on disk preserved).
- `GET  /api/workspaces/:id/plan` — per-project planning surface: workspace metadata + agent counters + pending approvals + latest digest + recent briefs (last 10) + last 30 events.

**Web:**
- `components/WorkspaceProvider.tsx` — React context + `useWorkspace()` / `useWorkspaceId()` hooks. Persists active workspace to `localStorage`, refreshes the list on demand, exposes `create()` and `archive()`.
- `components/WorkspaceSwitcher.tsx` — popover from the TopBar showing every project with its agent / brief / pending counts, "New project" inline input, archive-on-hover, "open all projects" link.
- `app/projects/page.tsx` + `ProjectsIndex.tsx` — index of all projects as cards: name, status pill (pending count if any), last brief preview, 4-stat row (agents / briefs / tokens / spend), digest date, last activity. Aggregate strip at the top totals every project.
- `app/projects/[id]/page.tsx` + `ProjectPlan.tsx` — per-project planning view: hero with name + 4 stat tiles; "Needs your approval" section with inline approve/deny; "Standup digest" with one-click regenerate; "Recent briefs" each linking to its replay; "Project surfaces" jump grid (Ops/Hire/Org/Logs).
- All other tabs (Ops / Org / Hire / Logs / Settings / Home / Killswitch / TopBar HUD / Command Palette) now use `useWorkspaceId()` instead of the hard-coded `"demo"` — switching the workspace via the switcher (or visiting `/projects/<id>`) updates every surface.
- Command Palette gained per-workspace switch actions (e.g. `Switch to "Acme Docs Site"`) on top of the navigation/utility actions.
- Sidebar gained a `Projects` tab + FolderTree icon.

**Verified end-to-end:**
- `GET /api/workspaces` → 1 project initially (`demo` with 4 agents, 11 briefs, $0.157 spend).
- `POST /api/workspaces` body `{name:"Acme Docs Site"}` → `{id:"acme-docs-site", name:"Acme Docs Site"}`.
- Re-list shows both projects.
- `GET /api/workspaces/demo/plan` returns workspace metadata, agents `{active:4, total:5}`, 0 pending approvals, digest `2026-06-13`, 11 briefs (2 active), 3 recent briefs.
- `/projects` HTTP 200 with `Projects`, `New project`, `pending` markers in SSR HTML.
- `/projects/demo` and `/projects/acme-docs-site` both render the project-plan view (HTTP 200, ~32KB each).
- TopBar HUD label changed from `Workspace` to `Project`, switcher button shows the active project name + FolderTree icon.

**Surfaced (Principle 10B):** workspace switching reloads per-page state via the `useEffect` keyed on `workspaceId` — feeds, metrics, audit, digest, brief lists all refresh. The `useEffect` swap is intentional (avoids needing URL params for shareable state for v1); a follow-up could add `?ws=<id>` deep-links.

---

## Claude sign-in flow (done 2026-06-13)

The app now gates on Claude authentication before letting the user in.

**Server (`apps/server/src/routes/auth.ts`):**
- `GET /api/auth/status` — probes `claude --version`, merges with `~/.guideai/auth.json`, returns `{userName, apiKeySet, apiKeyHint, connectedAt, cliDetected, cliVersion, connected}`. The API key itself is never echoed back; only the last 4 chars (`apiKeyHint`).
- `POST /api/auth/connect {userName, apiKey?}` — requires either a CLI session or an API key. Writes `~/.guideai/auth.json` chmod 600.
- `POST /api/auth/disconnect` — wipes the auth file.
- `DELETE /api/auth/apikey` — clears just the API key (CLI session preserved).

**Runtime adapter:**
- `packages/runtime-claude/src/adapter.ts` reads the stored API key from `~/.guideai/auth.json` on each spawn and injects it as `ANTHROPIC_API_KEY` env var into the Claude CLI subprocess. Still deny-by-default for every other env var (Principle 8) — the key is only forwarded if the user explicitly stored one.

**Web:**
- `AuthProvider` — React context + `useAuth()` hook. Holds `state`, `loading`, `refresh`, `connect`, `disconnect`, `clearApiKey`.
- `AuthGate` — wraps the app shell. While `loading`, renders a "connecting…" stub. If not `connected`, redirects to `/signin`. If `connected` and currently on `/signin`, redirects to `/`.
- `AppShell` — renders `Sidebar` + `TopBar` around `children`, **except on `/signin`** which gets a clean full-bleed layout.
- `/signin` — 2-column page: branded left rail (gradient blob art, feature bullets); right rail form with name input, optional API key input, CLI-detection banner (green if detected, warn if not + instructions to run `claude /login`).
- `/settings` gained an `AuthSection` at the top: status rows (CLI version, API key hint with last 4 chars), identity edit (change name), API key management (save / clear), and a final "Disconnect" button.
- `Sidebar` got an **identity card** at the bottom (avatar with first initial, name, `cli · key set` status line) that links to `/settings`.

**Verified:**
- `GET /api/auth/status` (no auth) → `{cliDetected: true, cliVersion: "2.1.177 (Claude Code)", connected: false}`.
- `POST /api/auth/connect {userName: "Monish"}` → `connected: true`. File written to `~/.guideai/auth.json` (chmod 600).
- `POST /api/auth/connect {userName: "Monish", apiKey: "sk-ant-test-1234"}` → `apiKeySet: true`, `apiKeyHint: "…1234"`.
- `DELETE /api/auth/apikey` → `apiKeySet: false`, `connected: true` (CLI still satisfies it).
- `POST /api/auth/disconnect` → file wiped, `connected: false`.
- `/signin` renders 200 in a bare layout (no Sidebar / TopBar in the HTML).
- `/settings` includes the AuthSection rendered above RulesEditor + AuditLog.

**Surfaced (Principle 10B):** SSR pre-hydration shows "connecting…" because `useAuth()` hasn't fetched `/api/auth/status` yet. First paint flashes the stub briefly before the form (or the app shell) appears. Acceptable for a local dev tool; a follow-up could read auth state via a cookie/middleware to skip the flash.

---

## Plan A — Dispatch to specialists (done 2026-06-14)

Specialists in the roster now actually do work. Before this, every phase ran as CoS — the org chart's hired-agent cards never moved off zero.

**Routing (`packages/orchestrator/src/routing.ts`):**
- `scoreAgent(agent, phase, briefTokens)` — keyword overlap between the brief + agent identity (role, displayName, system prompt) and phase-specific keyword sets (research → analyst/strategist/pm, implement → developer/engineer/pro, review → reviewer/security, verify → qa/tester).
- `routeRoster({brief, roster, cos, phases})` returns a `RouteDecision` per phase: `{agent, score, fallback, reason}`. Falls back to CoS when no specialist scores positive.

**Pipeline (`phases.ts`):**
- `runPipeline()` now accepts `route: Record<Phase, RouteDecision>`.
- Each phase resolves the worker, builds a layered system prompt (`## Your role\n<persona>` + phase task + skills), uses the agent's `toolWhitelist` and `model` preference, and threads `worker.id` into both the adapter call and the chunk stream.
- `PhaseResult` gained `workerAgentId / workerRole / workerDisplayName`.
- Phase artifacts (`research.md`, …) record the worker in frontmatter: `_worker: Backend Developer (backend-developer) · model: sonnet · …_`.

**CoS (`cos.ts`):**
- Loads the workspace's live roster, builds the route, emits a single `routing plan: research→Backend Developer · plan→Backend Developer · implement→Backend Developer · review→Qa Expert · verify→Qa Expert` system chunk for visibility, then fires the pipeline.
- `schema.tasks` rows are keyed by `workerAgentId` — `/org` metrics aggregate per specialist instead of dumping everything on CoS.

**UI:**
- `EventFeed` highlights `routing plan:` / `dispatch:` system notes in sonnet (purple) to make routing decisions visually distinct.
- `OrgChart` cards swap their 3-stat row from `win/tasks/$` to `phases/tokens/$` so specialists with no win-rate data yet read meaningfully.

**Verified end-to-end (guest mode):**
- Brief: *"Build a small backend API endpoint to return health status. Add a QA pass."*
- Feed: routing plan + 5 dispatch lines (`research/plan/implement → Backend Developer`, `review/verify → Qa Expert`) with keyword-match scores 6–26.
- `schema.tasks`: 3 rows under backend-developer, 2 under qa-expert, **0 under CoS for this brief**.
- `/org`: cards light up — Backend Developer (3 phases, 114↓/168↑), Qa Expert (2 phases, 66↓/97↑).
- Artifact frontmatter on every `.md` records the worker.

**Surfaced (Principle 10B):**
- Scoring is heuristic. A brief mentioning "frontend" can route an implement phase to frontend-developer even if the actual work is backend — only by token coincidence. A judge-pass routing layer (extra agent picks workers) is a natural follow-up.
- Specialists still call the runtime with their own `toolWhitelist`, but step 8's MCP-based real tool interception is still pending — until then they can't actually `Bash`/`Write`. Wiring `--permission-prompt-tool` to GuideAI's approval flow is the next step that fully unblocks "ship real code through your team."

---

## Plan B — Real tool interception via PreToolUse hooks (done 2026-06-14)

Every real tool call an agent attempts now routes through GuideAI's policy engine + approval flow. The synthetic post-brief Bash chunk is gone.

**Approach**: Claude Code 2.1.x doesn't ship `--permission-prompt-tool` yet, but it does ship `PreToolUse` hooks via `settings.json`. We write a per-agent `<cwd>/.claude/settings.json` at spawn time pointing at a Node hook that calls back into the GuideAI server. Same end-state, fewer moving parts (no extra MCP process).

**New: `packages/permission-hook/`**
- `bin/guideai-perm-hook.cjs` — pure-Node, zero-deps, directly executable from `settings.json`. Reads stdin JSON (`{tool_name, tool_input}`), POSTs to `GUIDEAI_PERMISSIONS_URL`, writes Claude-shaped decision JSON to stdout. Reads `GUIDEAI_WORKSPACE_ID`, `GUIDEAI_AGENT_ID`, `GUIDEAI_BRIEF_ID`, `GUIDEAI_HOOK_WAIT_MS` from env. Denies on any error (safe default).
- Output schema covers both modern (`hookSpecificOutput.permissionDecision`) and legacy (`continue` / `stopReason`) keys so multiple Claude versions parse it.

**New: `apps/server/src/routes/permissions.ts`**
- `POST /api/permissions/evaluate {workspaceId, agentId?, briefId?, tool, args, waitMs?}` — runs the policy engine.
  - Auto-approve/deny matches: emit `ToolChunk` + `ApprovalChunk` + system note + DB row, return immediately.
  - Ask: create pending approval, append to feed, **long-poll** up to 120s for a `notifyApprovalDecided()` from the existing approval API. Resolve as soon as the user clicks approve/deny in the PendingTray. Timeout → deny-by-default.
- `GET /api/permissions/wait/:id` — non-blocking peek for any waiter.
- `routes/approvals.ts` updated: every existing `POST /api/approvals/:id` decision now also calls `notifyApprovalDecided` to unblock any hook that's waiting on this approval.

**Adapter wiring (`packages/runtime-claude/src/adapter.ts`):**
- `writePermissionSettings(cwd, opts)` runs before every `spawn()` and `runOnce()`. Drops `.claude/settings.json` in the agent's sandboxed cwd with `hooks.PreToolUse[].matcher: '.*'` pointing at `node <abs path to hook>`.
- `buildEnv` now injects `GUIDEAI_PERMISSIONS_URL`, `GUIDEAI_WORKSPACE_ID`, `GUIDEAI_AGENT_ID` so the hook knows where to call back and who it's running for.
- Existing deny-by-default env allowlist is unchanged.

**Removed in `cos.ts`:** the synthetic Bash chunk that step 8 used as a placeholder. No more fake `Bash(ls -la)` after every brief — approvals you see in the feed correspond to real tool requests.

**Verified end-to-end:**
- **Auto-approve path:** `echo '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' | hook` → `{continue:true, permissionDecision:'allow', reason:'Read-only tools auto-approve.'}` (Read rule hit, no DB pending row).
- **Deny-by-timeout path:** Bash with `GUIDEAI_HOOK_WAIT_MS=2000` → `{continue:false, permissionDecision:'deny', reason:'user decision'}` after 2 s (no user input).
- **Human-in-the-loop path:** Bash hook started with 20 s wait → pending approval appears in `/api/workspaces/demo/approvals/pending` → API call decides `approved` → hook receives `{continue:true, permissionDecision:'allow', reason:'user decision'}` within milliseconds. `notifyApprovalDecided` unblocks the waiter as designed.

**Surfaced (Principle 10B):**
- Hook output format covers two known Claude versions but may need tweaking for future ones — Claude CLI is still evolving its hooks payload.
- Long-poll uses an in-memory `Map` of waiters — restarting the server while a hook is mid-flight will leave the hook hanging until its own 60s deadline (then deny-by-timeout). Acceptable: any agent that was mid-spawn is killed alongside the server anyway.
- Hook timeout default is 60 s. For interactive use, the user has 60 s to click approve before the safe default (deny) kicks in. Tunable via `GUIDEAI_HOOK_WAIT_MS` env var.

**Now possible:** Specialists can actually `Bash`, `Edit`, `Write` — every call appears in your PendingTray; you approve or deny per call (or add an auto-approve rule). Real code can ship through the team.

---

## Plan C — Inter-agent channels (done 2026-06-14)

The `/channels` tab is real. Built-in topic streams + per-agent + per-brief views over the workspace event log.

**`apps/server/src/routes/channels.ts`:**
- `GET /api/workspaces/:id/channels` — returns built-in channels (`#general`, `#routing`, `#approvals`, `#briefs`, `#errors`), per-agent channels (`@Backend Developer`, `@Qa Expert`, …), and per-brief channels (`#brief-<id>` for the 10 newest briefs).
- `GET /api/workspaces/:id/channels/:channelId/events` — chronological events filtered to that channel. Filter logic per channel kind: `routing` catches phase chunks + system notes starting with `routing plan:` / `dispatch:` / `handoff:` / `skills loaded:`; `approvals` catches `tool` + `approval` chunks + auto-decision system notes; `briefs` catches `user` + `ai` chunks; `errors` catches system level=error; `agent` channels match `agentId`; `brief` channels match phase `taskId` or text references.

**`packages/orchestrator/src/phases.ts`:**
- Tracks the previous phase's worker; on transition emits a system note `handoff: Backend Developer → Qa Expert (review)`. Verified end-to-end with two briefs:
  - "Plan and verify our backend health endpoint" → 1 handoff (implement BE → review QA)
  - "Frontend redesign of the dashboard with QA tester verification" → 1 handoff (implement FE → review QA)

**`apps/web/app/channels/`:**
- 2-column layout (sidebar + main pane) replacing the stub. Sidebar groups channels: built-ins on top, then `Direct agents` group, then `Briefs` group.
- Lucide icons per kind (`Hash, GitBranch, ShieldAlert, FileText, AlertTriangle, AtSign`).
- Header shows the channel name + description + live count.
- Live updates: subscribed to the workspace SSE; any new event triggers a re-fetch of the filtered channel.
- Keyboard nav: `j` / `k` cycles through channels.

**Verified end-to-end:**
- Channel list returns 18 channels (5 built-in + 5 active agents + 8 of the 10 newest briefs).
- `#routing` returns 18 events: 1 routing plan + 5 dispatch lines + 1 handoff + 10 phase chunks (5 started, 5 completed) + skills-loaded note.
- `#approvals` returns 0 events here (guest mode mock adapter doesn't call real tools — Plan B's real path would populate this).
- `#brief-<id>` returns 11 events scoped to one brief (5 phase started + 5 completed + the user brief).
- `/channels` page renders HTTP 200 with sidebar + main pane markup.

**Surfaced (Principle 10B):**
- Channels are derived (read-time filtering) — no per-channel storage. Trade-off: zero index cost, but every channel switch re-scans the workspace events file. Fine until events.jsonl crosses ~10 MB.
- Live update uses SSE + refetch; with many events this could thrash. Move to a delta-based filter in a follow-up if it becomes noisy.
- Agent inboxes (`packages/messaging/inbox.ts`) still exist from step 3 but aren't wired into channels yet — that's the foundation for truly autonomous agent-to-agent messaging (an agent emitting `send to: code-reviewer` mid-pipeline). Phase handoffs are the v1 stand-in; autonomous messaging is the natural next step alongside multi-agent collaboration mid-phase.

---

## Phase 0 — Budget + rate-limit governor (done 2026-06-14)

Foundational layer for the project-lifecycle roadmap. Every phase, every adapter call now consults a per-workspace budget before spending.

**Schema (`packages/shared/src/db/`):**
- `usage_log { id, workspaceId, agentId, briefId, phase, model, tokensIn, tokensOut, costUsd, ts }` — append-only ledger of every Claude call. Indexed by `(workspaceId, ts)` for fast 5h-window sums.
- `workspace_budgets { workspaceId, dailyUsdCap, monthlyUsdCap, tokensPer5hCap, behavior, updatedAt }` — per-project caps. `behavior` ∈ `{warn, downgrade, pause}`.

**Module (`packages/policies/src/budgets.ts`):**
- `recordUsage(event)` — append row + compute USD cost from per-tier price table (haiku $1/$5 per 1M, sonnet $3/$15, opus $15/$75).
- `summarizeUsage(workspaceId)` → `{todayUsd, monthUsd, tokens5h, lastTs, windowResetTs}`. The 5h window is sliding; `windowResetTs` projects when the oldest in-window event ages out.
- `forecastPhaseCost({tier, briefLength, artifactsLength, k})` — heuristic estimate (4 chars/token + constants). Cheap, no LLM.
- `checkBudget({cfg, usage, forecast, tier})` → `{action: 'ok'|'warn'|'downgrade'|'pause', ...}`. Pure function over (config, usage, forecast). Token-cap hits **only** warn or pause (downgrading model doesn't reduce token count); dollar-cap hits cycle through the downgrade ladder (opus → sonnet → haiku) before pausing.

**Pipeline gate (`phases.ts`):**
- Before every phase, the loop:
  1. Forecasts phase cost at routed tier
  2. Summarises current usage
  3. Calls `checkBudget`
  4. On `downgrade`: swaps `routing.tier`, emits warn note, retries forecast (up to 3 tries)
  5. On `warn`: emits warn note, proceeds
  6. On `pause`: emits error note with `resume at HH:MM`, marks the phase chunk `'paused'`, throws to halt the pipeline
- After every adapter call (single-pass and pass@k both): calls `recordUsage` with the real `tokensIn/tokensOut`.

**Server (`apps/server/src/routes/budget.ts`):**
- `GET /api/workspaces/:id/budget` — current config + live usage summary.
- `PUT /api/workspaces/:id/budget` — update caps + behavior.
- `GET /api/workspaces/:id/usage` — recent ledger rows for the spend dashboard.

**UI:**
- **TopBar** gets two new HUD pills:
  - `today $ X.XX / $ Y` — tinted green/amber/red as you approach the daily cap
  - `5h Z / W tokens` — tinted similarly, hidden when no token cap is set
- **Settings → "Budget & rate limits"** (new section, between Claude integration and Approval rules):
  - 3 live meter cards (today $, 30d $, 5h tokens) with progress bars
  - 3 cap inputs (daily $, monthly $, 5h tokens) — blank = no cap
  - Behavior radio cards: Warn / Downgrade / Pause with full descriptions
  - "save budget" button

**Verified end-to-end:**
- Setting `dailyUsdCap=0.001, behavior=downgrade` with empty ledger → submitting a brief produced:
  - `budget downgrade (research): sonnet → haiku · daily cap would be exceeded ($0.02/$0.00)`
  - `budget pause (research): daily cap would be exceeded ($0.01/$0.00) · resume at 9:31:50 PM`
- Setting `tokensPer5hCap=5000` with 4500 pre-existing tokens → next brief paused immediately (token cap bypasses the downgrade ladder).
- Default config (`tokensPer5hCap=140000`, no $ caps, `behavior=downgrade`) lets briefs run normally with full per-phase usage rows persisted.

**Surfaced (Principle 10B):**
- Pause sets the phase chunk to `'paused'` and throws, halting the pipeline. There's no auto-resume scheduler yet — when the 5h window rolls, the user must re-submit the brief. A small `setInterval` resumer is straightforward to add later (poll for `briefs.status='paused'` + `paused_until <= now`).
- Forecast heuristic (~4 chars/token + 1500 overhead + 800 response) tends to over-estimate, which biases toward safety. Real usage is recorded post-call so the running totals are accurate.
- Per-workspace caps only — no global cap across projects. If you want a global cap, that's a follow-up (sum across workspaces in `summarizeUsage`).



---

## Phase 1 — Project intake + Discovery round-table (planning/hiring mode toggles)

The intake layer that sits in front of every brief: a structured form (goal, success criteria, constraints, budget hint) and a 5-agent discovery round-table that produces a synthesized recommendation (recommended hires, ballpark cost, risks, success metrics). Mode toggles control how the round-table feeds the rest of the pipeline.

**Schema (`packages/shared/src/db/init.ts` + `schema.ts`):**
- `project_intakes` — one row per workspace. Fields: `goal`, `success_criteria` (JSON), `constraints` (JSON), `budget_hint_usd`, `planning_mode` (`auto|assisted|manual`), `hire_mode` (`auto|manual|hybrid`).
- `discoveries` — append-only history of round-table runs. Stores `panel_json` (5 panelist entries with text/tokens/cost) and `synthesis_json` (recommended_roles, cost_estimate, verdict, risks, success_metrics, security_tag, summary).

**Module (`packages/orchestrator/src/discovery.ts`):**
- Fixed 5-agent panel: **Product Strategist** (haiku · value/scope/win), **Tech Lead** (sonnet · stack/roles/risks/effort), **Finance Analyst** (haiku · ballpark $/verdict), **UX Researcher** (haiku · audience/journey/metrics), **Risk Officer** (sonnet · top risk/mitigations/security_tag).
- Each panelist gets a tight labelled-field prompt (`LABEL: value\n`) so synthesis can `regex` extract structured fields without a second LLM call (Principle 1B — keep token cost lean).
- `runDiscovery()` runs all 5 panelists in **parallel** (Principle 3B — parallelism within a gate is fine, not across), each tracked via `recordUsage` so spend lands in the same `usage_log` as the pipeline.
- Pre-flight budget gate (same `checkBudget` from Phase 0): if the sum forecast crosses caps with `behavior='pause'`, the round-table is aborted with an `error` event in the feed before any tokens are spent.
- Synthesis (`synthesize()`): pulls labelled fields, dedupes, falls back to defaults (`backend-developer/frontend-developer/qa-engineer` if the Tech Lead doesn't return roles), composes a one-paragraph summary. Cost verdict honors the Finance Analyst's call first; otherwise compares ballpark to the user's budget hint.

**Mock adapter (`packages/runtime-claude/src/mockAdapter.ts`):**
- Detects a `[panel:<role>]` marker in the system prompt and returns role-appropriate fixture text. Lets guest mode (and Phase 0 tests) demo the round-table without a Claude account.

**Server (`apps/server/src/routes/intake.ts`):**
- `GET /api/workspaces/:id/intake` → `{intake, latestDiscovery}`
- `PUT /api/workspaces/:id/intake` → upsert with field-level validation (mode enums, finite budget number)
- `POST /api/workspaces/:id/discovery` → kicks `runDiscovery`, returns the persisted record
- `GET /api/workspaces/:id/discovery` → latest
- `GET /api/workspaces/:id/discoveries` → full history

**UI (`apps/web/app/projects/[id]/IntakeSection.tsx`):**
- Lives at the top of the project plan page (above approvals).
- **Intake form:** goal textarea, success-criteria chips (Enter to add, X to remove), constraints chips, budget input, planning-mode 3-card radio (Auto/Assisted/Manual with descriptive cards), hiring-mode 3-card radio (Auto/Hybrid/Manual).
- **Run discovery button:** disabled when planning mode is `manual` (tooltip explains); fires `POST .../discovery` and shows the result inline.
- **Discovery view:**
  - **Synthesis card** (top, accent-tinted): one-paragraph summary, 4 KPI stats (hires/ballpark $/risks/metrics) with cost verdict tinted green/amber/red, lists of recommended roles (info pills), risks (warn-dotted), and success metrics (accent-dotted), tokens/cost/security footer.
  - **5 panelist cards** in a 1-2-3 column grid: initials avatar, name, lens line, raw labelled response, per-card tokens/cost/duration. Failed panelists shown with err-tinted border.

**Verified end-to-end:**
- Created `phase1-test` workspace, PUT intake (`goal`, criteria, constraints, $50 budget hint, `assisted+hybrid`), POSTed discovery.
- All 5 panelists responded with structured `LABEL:` fields; synthesis parsed correctly:
  - `recommendedRoles`: 4 (backend/frontend/qa/devops)
  - `costEstimateUsd`: 18.5 · `costVerdict`: `within-budget` (vs $50 hint)
  - `riskFlags`: 7 deduped across Tech Lead + Risk Officer
  - `successMetrics`: 6 merging product WIN line + UX METRICS + user-supplied criteria
  - `securityTag`: `recommended`
- Usage rows landed in `usage_log` keyed by `phase='discovery'`, so the Phase 0 HUD pills reflect round-table spend.

**Surfaced (Principle 10B):**
- Round-table runs synchronously inside the POST handler today. That's fine while panelists are haiku/sonnet (~500ms each in parallel) but if a panelist hangs the HTTP request hangs with it. A fire-and-forget pattern (like `submitBrief`) is the natural next step — return the discovery id immediately, surface progress via the SSE feed, poll the GET endpoint.
- The mode toggles are wired but not yet enforced in the pipeline. Wiring them up is Phase 2: `assisted` → pause at plan review; `auto` → synthesis becomes the brief, skip to implement; `hybrid` hire mode → prompt before non-default hires.
- Panelists return free-text; if a real Claude run omits a labelled field, synthesis falls back to defaults instead of erroring. That's intentional (lean parsing, no fragile JSON contracts), but means a malformed model response degrades gracefully rather than failing loud.


---

## Phase 2 — Plan review + planning/hire mode enforcement

The plan-review layer. Phase 1 produced a discovery synthesis; Phase 2 turns it into an editable plan, dispatches hires per the workspace's hire mode, and submits the brief — with the planning-mode toggle deciding how much of that runs automatically vs. with the user in the loop.

**Schema (`packages/shared/src/db/init.ts` + `schema.ts`):**
- `plans` table: `id`, `workspace_id`, `discovery_id`, `status` (`draft|approved|dispatched|rejected`), `edited_synthesis_json` (mutable copy of the synthesis), `notes`, `brief_id` (set when dispatched), `hire_summary_json` (post-approval result), timestamps. Indexed on workspace + discovery.

**Module (`packages/orchestrator/src/planReview.ts`):**
- `previewHires({workspaceId, roles, hireMode})` → `{hired, queued, skipped, errors}`. Pure function over (current roster, catalog, mode):
  - **auto** — every recommended role tagged `hire`.
  - **manual** — every role tagged `queue`.
  - **hybrid** — roles in `SAFE_DEFAULT_ROLES` (backend/frontend/fullstack/technical-writer/qa-expert/test-automator) tagged `hire`; others `queue`.
- `executeHires(...)` — runs `hireAgent` for each `hire` entry; errors degrade to `skip`.
- **Role alias table** (`ROLE_ALIASES`): translates panelist shorthand → catalog-real role IDs (`qa-engineer → qa-expert`, `full-stack-developer → fullstack-developer`, `architect → solution-architect`, …). Falls back to fuzzy substring match before giving up. Means the panelists don't have to memorise all 154 catalog IDs.
- `createPlanFromDiscovery({workspaceId, discoveryId?, synthesis?})` — drafts a plan from a discovery's synthesis. Re-uses an existing `draft` plan for the same discovery instead of accumulating duplicates.
- `savePlanEdits({planId, synthesis?, notes?})` — only allowed while `status='draft'`.
- `composeBriefBody(synthesis, intakeGoal)` — builds a markdown brief body from the (possibly edited) synthesis (goal headline + summary + benefits + success metrics + roster + risks + ballpark cost line).
- `approvePlan({planId, forceDispatch?})` — runs `previewHires` + `executeHires`, then:
  - If no hires are queued (or `forceDispatch=true`) → composes brief body → calls `submitBrief` → marks `dispatched`.
  - Otherwise → marks `approved`, waits for the user to clear queued hires (then they re-call approve, or click "force dispatch").
- `rejectPlan(planId)` — soft-rejects; UI can redraft from latest discovery.
- `planFromDiscoveryByMode({...planningMode})` — convenience helper called by the discovery POST handler:
  - **manual** — does nothing (user writes brief themselves in Ops).
  - **assisted** — drafts a plan, leaves it `draft` for user review.
  - **auto** — drafts + approves in one shot (so the whole flow runs hands-off if hire-mode also allows it).

**Server (`apps/server/src/routes/plans.ts` + `intake.ts` change):**
- Discovery POST now returns `{discovery, plan}` — the plan is populated for `auto`/`assisted` mode, `null` for `manual`.
- `GET /api/workspaces/:id/plan-reviews` — list history.
- `GET /api/workspaces/:id/plan-review` — latest.
- `POST /api/workspaces/:id/plan-review` — draft from latest discovery (idempotent).
- `GET /api/workspaces/:id/plan-review/hire-preview` — live preview without dispatching (UI uses this so the user can see what auto/hybrid/manual will do before approving).
- `PUT /api/plans/:id` — merge-edit synthesis + notes (only while draft).
- `POST /api/plans/:id/approve` — body `{forceDispatch?}`.
- `POST /api/plans/:id/reject`.
- `GET /api/plans/:id` — fetch one.
- Path note: avoided `/api/workspaces/:id/plan` because that's already the workspace-summary route; used `plan-review` instead.

**UI (`apps/web/app/projects/[id]/PlanReview.tsx`):**
- Sits between the intake section and the approvals tray on the project page.
- **Editable summary card** — textarea for the synthesis summary plus per-list chip editors for recommended_roles, success_metrics, riskFlags, benefits. Toggle edit/save/cancel; edits only allowed in `draft`.
- **Hire dispatch preview** (3-column grid: will-hire / queued / skipped) updates every 4 seconds and reflects the current hire-mode. The catalog-resolved displayName is shown so the user sees what they're getting, not just the raw role slug.
- **Hire dispatch result** appears after approval with the same 3-column layout — the actual outcome.
- **Status pill** (draft / approved / dispatched / rejected) with tint.
- **Actions:**
  - draft → "approve & dispatch" or "reject"
  - approved-with-queued-hires → "force dispatch anyway" (warn-tinted, so it's clear this skips approvals)
  - dispatched → link to `/logs/<briefId>` for the trace
  - rejected → "redraft from latest discovery"

**Verified end-to-end (4 scenarios):**

| Workspace | planning | hire | Result |
|---|---|---|---|
| `phase2-auto`     | `auto`     | `auto`   | discovery → plan auto-drafted → 4 hires (backend/frontend/qa-expert/devops) → brief dispatched. status=`dispatched`. |
| `phase2-hybrid`   | `auto`     | `hybrid` | 3 safe-defaults hired (backend/frontend/qa-expert), devops queued. status=`approved` (waiting on queue). |
| `phase2-assisted` | `assisted` | `manual` | plan drafted but NOT auto-approved. PUT edits accepted (dropped devops, added technical-writer). approve → all 3 queued (manual). force-dispatch → brief dispatched anyway. |
| `phase2-manual`   | `manual`   | `manual` | discovery still runs, but plan is NOT created. User writes brief themselves in Ops. |

Role alias resolution verified: the panelist's `qa-engineer` (not in catalog) resolves to `qa-expert` (in catalog) at hire time. Stored synthesis keeps the human-friendly alias; only `executeHires` translates.

**Surfaced (Principle 10B):**
- Approval handler runs `submitBrief` synchronously inside the POST request. `submitBrief` itself is fire-and-forget (the pipeline runs in the background), so the HTTP request returns quickly — but if `executeHires` ever grew slower (e.g. cross-workspace catalog lookup), this would block. Acceptable for now.
- `hireMode=manual` queues every hire today, but doesn't actually create approval rows in the `approvals` table — the queue is a list returned for the UI to render. Wiring those into the real /hire approval flow is the natural next step (Phase 3 — auto-hire + GitHub bootstrap).
- `SAFE_DEFAULT_ROLES` is a hard-coded set. A reasonable upgrade: make it editable from Settings so each workspace can define its own.
- Plan history (`/api/workspaces/:id/plan-reviews`) is exposed but no UI surfaces it yet — currently we only show the latest. A "plan history" drawer is a small follow-up.
- When the user changes hire-mode in the intake form, the live preview updates within 4s (auto-refresh) but the stored synthesis doesn't change — only the dispatch decision. That's intentional; the panel's recommendation is independent of *how* you hire.

---

## Phase 4 — Work Breakdown Structure (WBS)

Once a plan is dispatched, every workspace gets a flat, editable list of work items the user can move across a Kanban. Items auto-seed from the synthesis (one set per role × phase, one per risk, one per success metric), and the pipeline auto-completes them as it ticks through phases — so the board reflects real state without bookkeeping.

**Schema (`packages/shared/src/db/init.ts` + `schema.ts`):**
- `work_items` table: `id`, `workspace_id`, `brief_id`, `plan_id`, `parent_id`, `title`, `description`, `assigned_role` (catalog or alias), `assigned_agent_id`, `phase` (`research|plan|implement|review|verify|other`), `status` (`todo|in_progress|blocked|done|cancelled`), `priority` (`low|normal|high|critical`), `estimate_hours`, `position` (column-local sort), `source` (`auto|manual`), timestamps + `started_at`/`completed_at`. Indexed on workspace + brief + status.

**Module (`packages/orchestrator/src/wbs.ts`):**
- `listWorkItems(workspaceId, {briefId?, status?})` — sorted by column then position.
- `createWorkItem(input)` — appends to bottom of the target status column.
- `updateWorkItem(id, patch)` — status transitions stamp `started_at`/`completed_at`; if status changes and no explicit `position` given, item goes to bottom of the new column.
- `deleteWorkItem(id)`.
- `autoSeedFromPlan({workspaceId, briefId, planId, synthesis})` — idempotent per brief: skips if any auto items already exist. Generates:
  - 1 research item + 1 implement item per recommended role (capped at 8 roles)
  - 1 review item per risk (capped at 5)
  - 1 verify item per success metric (capped at 6)
- `markPhaseComplete({workspaceId, briefId, phase})` — bulk-marks all matching items done.

**Pipeline integration (`packages/orchestrator/src/phases.ts`):**
- After every phase completion (single-pass and pass@k both), `markPhaseComplete` is called for the (briefId, phase) pair. Wrapped in `try/catch` so a WBS failure can't break the pipeline.

**Plan dispatch hook (`packages/orchestrator/src/planReview.ts`):**
- `approvePlan` calls `autoSeedFromPlan` immediately after `submitBrief` succeeds, so the dashboard has items the moment the brief lands.

**Server (`apps/server/src/routes/workItems.ts`):**
- `GET /api/workspaces/:id/work-items` — list with optional `?briefId=` / `?status=` filters.
- `POST /api/workspaces/:id/work-items` — manual add (defaults source=manual).
- `PUT /api/work-items/:id` — partial update (title/description/status/priority/phase/assignedRole/estimateHours/position).
- `DELETE /api/work-items/:id`.

## Phase 5 — Progress dashboard

The dashboard is one section on the project page that turns the WBS into a Kanban + the cost ledger into a pair of inline burndown charts. No external chart library — small inline SVG matching the existing `Sparkline` style.

**Server (`apps/server/src/routes/burndown.ts`):**
- `GET /api/workspaces/:id/burndown?days=N` — one pass over `work_items` + `usage_log` returning:
  - `totals`: items/done/open/inProgress/blocked + usd + budgetHintUsd (from intake)
  - `velocity`: items completed today + items completed in the last 7d
  - `series`: per-day buckets for the last N days (inclusive of today): `completed`, `cumulativeCompleted`, `remaining` (proxy: totalItems − cumulativeCompleted), `usdSpent`, `cumulativeUsd`

**UI (`apps/web/app/projects/[id]/Dashboard.tsx`):**
- Lives below `PlanReview` on the project page; auto-refresh every 5s.
- **KPI strip** (5 cards): open, in-flight (+ blocked sub), done (+ 7d velocity sub), spent (+ budget hint sub), today's velocity.
- **Two inline-SVG charts** (14d window):
  - **Items burndown** — actual remaining line + dashed ideal line (linear from total → 0). Tinted accent.
  - **Cost burndown** — cumulative USD line + dashed budget-hint baseline (when set). Tinted warn.
  Both show first/last date + current value + budget number.
- **Add-item form** — collapsible drawer with title + phase + priority + role.
- **Kanban (4 columns: todo / in-progress / blocked / done):**
  - Drag-and-drop between columns (optimistic update, server PUT on drop).
  - Each card shows title, optional description, phase pill + priority pill + role pill, source tag, and a per-card "move" disclosure with one-click status buttons (for users without drag).
  - Hover-only delete button (with confirm).

**Verified end-to-end (`p4p5-test` workspace):**
- Submitted intake (`auto+auto`), POST'd discovery → plan auto-dispatched.
- WBS auto-seeded with **19 items** across phases: 4 research, 4 implement (per recommended role), 5 review (per risk flag), 6 verify (per success metric). Statuses: all `todo`.
- Manually added a 20th item (`Wire up analytics`, phase=implement) — `source=manual` set correctly.
- Pipeline ran in the background; each `phase` completion ticked all matching items to `done` (19 items, 1 manual item left at `todo`).
- `GET /burndown?days=14` returned: `totals.done=19`, `velocity.today=19`, `velocity.last7d=19`, with the spike showing only on today's bucket. Off-by-one fix: `startMs = now − (days − 1) × DAY_MS` so today is included in the window (the original calc cut today off).

**Surfaced (Principle 10B):**
- **`remaining` is a proxy**, not a historical snapshot. We compute it as `totalItems − cumulativeCompleted`, which is fine for showing today's trend but doesn't reconstruct "items as of N days ago" if items were added or deleted mid-stream. Adding a small `wbs_snapshots` table that records `{ts, total, done}` daily would give true historical accuracy.
- **`autoSeedFromPlan` is one-shot** — it skips if any auto items already exist for the brief. Re-running discovery on the same plan re-uses the seed; that's the right default. If the user wants a fresh seed they can delete the auto items first.
- **Kanban drag is HTML5 drag/drop** — works on desktop, awkward on touch. A small touch-shim or library is the right follow-up if mobile becomes a real use case.
- **`markPhaseComplete` matches by `(workspaceId, briefId, phase)`** — that's narrow on purpose. Manually-added items (no `briefId`) are never auto-ticked. So if the user adds "Wire up analytics" mid-flow, they explicitly mark it done. Good for trust.

---

## Phase 6 + 7 — Deliverables + learning/explainer space

When a brief completes, GuideAI now produces three things automatically: copies of each phase artifact, a markdown slide deck synthesized from the run, and a plain-English explainer ("how it works") written by a cheap model. All three live in one section on the project page, alongside manually-added links/files. Both phases share one table; the `kind` column distinguishes them.

**Schema (`packages/shared/src/db/init.ts` + `schema.ts`):**
- `deliverables` table: `id`, `workspace_id`, `brief_id`, `kind` (`artifact|slide-deck|explainer|link|file`), `title`, `body` (markdown), `uri` (file path or URL), `source` (`auto|manual`), `phase` (set only for `kind=artifact`), `tokens_in/out` + `cost_usd` (for `explainer`), `created_at`. Indexed on workspace + brief + kind.

**Module (`packages/orchestrator/src/deliverables.ts`):**
- `harvestArtifacts({workspaceId, briefId})` — walks the brief's artifact directory on disk and creates one `kind=artifact` row per phase markdown (research/plan/implement/review/verify). Idempotent: wipes prior auto artifacts before reinserting, so re-running gives a clean slate.
- `generateSlideDeck({workspaceId, briefId, synthesis?, briefBody?})` — **deterministic, no LLM call**. Composes a multi-slide markdown deck (separated by `---`):
  1. Title (from synthesis summary or brief headline)
  2. "The outcome" — summary + cost + benefits
  3-7. One slide per phase, with bullets pulled from the artifact body (prefers existing `- ` lines; falls back to first sentences)
  8. Success metrics
  9. Risks
  10. Team (recommended roles)
- `generateExplainer({workspaceId, briefId, briefBody, synthesis?})` — **one cheap haiku call** with a structured 4-section prompt (`What we built / How it works / Why these choices / What's next`). Records token usage via `recordUsage` so the Phase 0 budget HUD reflects it.
- `harvestBriefDeliverables({...})` — convenience wrapper that runs all three with individual `try/catch` so one failure can't cascade.

**Mock adapter (`packages/runtime-claude/src/mockAdapter.ts`):**
- Detects `[explainer]` marker in the prompt and returns a fixture matching the 4-section format. Guest mode demos this end-to-end with no Claude account.

**Post-pipeline hook (`packages/orchestrator/src/cos.ts`):**
- After `runPipeline` completes and tasks/skill-promotion have run, look up the plan that produced this brief (if any) to recover the synthesis, then call `harvestBriefDeliverables`. Wrapped in `try/catch` and emits a `warn` chunk on failure — the brief itself is never blocked.

**Server (`apps/server/src/routes/deliverables.ts`):**
- `GET /api/workspaces/:id/deliverables?briefId=&kind=` — list with optional filters.
- `GET /api/deliverables/:id` — fetch one.
- `POST /api/workspaces/:id/deliverables` — manual add (link or file, server forces source=manual).
- `DELETE /api/deliverables/:id`.
- `POST /api/workspaces/:id/briefs/:briefId/deliverables/regenerate` — re-runs the full harvest (useful after editing the plan synthesis post-dispatch).

**UI (`apps/web/app/projects/[id]/Deliverables.tsx`):**
- Lives below the dashboard on the project page; auto-refresh every 6s.
- **Grouped grid** — one section per kind in this order: Slide decks · Explainers · Phase artifacts · Links · Files. Each section is hidden when empty so the page doesn't bloat.
- **Card preview** — title, brief id, relative time, source tag, and a kind-specific snippet (slide count for decks, first 140 chars for explainers, phase name for artifacts, URI for links/files).
- **Per-brief regenerate** — small chip row at the top lets the user trigger `POST .../regenerate` for any brief that has deliverables.
- **Add link/file panel** — kind switcher + title + URI + optional brief ID.
- **Full-screen viewer modal** (click "open" on any card):
  - For slide decks: paged view with `← →` arrow navigation + footer prev/next buttons + esc to close. Splits on `\n---\n`.
  - For everything else: rendered markdown (tiny in-house markdown renderer supporting h1/h2/h3, lists, `**bold**`, `_italic_`, `` `code` `` — added to avoid pulling in a markdown lib).

**Verified end-to-end (`p6p7-test` workspace, auto+auto):**
- Submitted intake, ran discovery → plan auto-dispatched → pipeline ran in background.
- 6s later, `GET /deliverables` returned **7 items**: 5 phase artifacts + 1 slide deck (10 slides) + 1 explainer.
- Explainer recorded `162↓/243↑ tokens · $0.0014` and produced the expected 4-section markdown.
- Slide 1 (title) + slide 2 (outcome with benefits) rendered correctly.
- Added a manual link (`Staging URL`, source=`manual`) — accepted, tied to the brief.
- POST `/regenerate` reported `5 artifacts · new deck · new explainer` — idempotent (prior auto rows replaced).

**Surfaced (Principle 10B):**
- **Slide deck is plain markdown**, not a real presentation format. The viewer paginates by splitting on `\n---\n`. Trade-off: no animations / themes / speaker notes, but it's trivially editable as text and survives any future export-to-pptx pipeline.
- **In-house markdown renderer is intentionally tiny** — h1/h2/h3, lists, inline `**`/`_`/`` ` ``. No tables, code blocks with fences, blockquotes, links inline, or images. If a deliverable needs those, swap in `react-markdown` later.
- **Explainer always uses haiku** (no router consultation). One $0.001-ish call per brief. If you want opus quality, that's a route-table change — but the trade-off isn't worth it for what's essentially a wiki summary.
- **`uri` for manual files is just a string** — we don't upload/copy/store the file. Adding it as a deliverable surfaces it in the UI but doesn't move bytes around. If you want true attachment storage, that's a follow-up.
- **Synthesis fallback**: if a brief was submitted directly (not via a plan), `synthesis` is null and the deck/explainer degrade gracefully (deck uses brief headline; explainer reads phase artifacts only).
