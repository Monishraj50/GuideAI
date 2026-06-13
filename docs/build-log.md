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

