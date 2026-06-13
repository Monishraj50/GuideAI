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

